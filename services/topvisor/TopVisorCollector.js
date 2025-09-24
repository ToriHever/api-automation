// services/topvisor/TopVisorCollector.js
const BaseCollector = require('../../core/BaseCollector');
const axios = require('axios');

class TopVisorCollector extends BaseCollector {
    constructor() {
        super('topvisor');
        this.config = this.getConfig();
        
        // Кэш для быстрого доступа к маппингам
        this.projectEngineCache = new Map();
    }
    
    
   // 1. НОВЫЕ МЕТОДЫ ДЛЯ РАБОТЫ СО СПРАВОЧНИКОМ
    async loadProjectEngineMap() {
        try {
            const result = await this.dbManager.query(
                `SELECT topvisor_project_id, topvisor_region_id, id as project_engine_id
                 FROM common.dim_projects_engines 
                 WHERE topvisor_project_id IS NOT NULL AND topvisor_region_id IS NOT NULL`
            );
            
            // Очищаем кэш
            this.projectEngineCache.clear();
            
            // Заполняем кэш: ключ = "topvisor_project_id:topvisor_region_id"
            for (const row of result.rows) {
                const cacheKey = `${row.topvisor_project_id}:${row.topvisor_region_id}`;
                this.projectEngineCache.set(cacheKey, row.project_engine_id);
            }
            
            this.logger.info(`Загружено ${this.projectEngineCache.size} маппингов из справочника`);
        } catch (error) {
            this.logger.error('Ошибка загрузки маппинга проектов', error);
        }
    }                                          /* Загружает маппинг TopVisor ID → project_engine_id из БД */
    async getProjectEngineId(topvisorProjectId, topvisorRegionId) {
        const cacheKey = `${topvisorProjectId}:${topvisorRegionId}`;
        
        // Проверяем кэш
        if (this.projectEngineCache.has(cacheKey)) {
            return this.projectEngineCache.get(cacheKey);
        }
        
        // Если нет в кэше, ищем в БД
        try {
            const result = await this.dbManager.query(
                `SELECT id FROM common.dim_projects_engines 
                 WHERE topvisor_project_id = $1 AND topvisor_region_id = $2`,
                [topvisorProjectId, topvisorRegionId]
            );
            
            if (result.rows.length > 0) {
                const id = result.rows[0].id;
                this.projectEngineCache.set(cacheKey, id);
                return id;
            }
            
            // Если не нашли - это ошибка, т.к. маппинг должен существовать
            throw new Error(`Не найден маппинг для topvisor_project_id=${topvisorProjectId}, topvisor_region_id=${topvisorRegionId}`);
            
        } catch (error) {
            this.logger.error(`Ошибка получения project_engine_id для ${cacheKey}`, error);
            throw error;
        }
    }         /* Получает project_engine_id по TopVisor ID */
    
    async checkApiConnection() {
        this.logger.info('Проверка подключения к TopVisor API');
        
        try {
            // Простой запрос для проверки API
            const response = await axios.post(
                process.env.TOPVISOR_API_URL,
                { "show": "info" }, // Минимальный запрос
                {
                    headers: {
                        Authorization: `Bearer ${process.env.TOPVISOR_API_KEY}`,
                        "User-Id": process.env.TOPVISOR_USER_ID,
                        "Content-Type": "application/json"
                    },
                    timeout: 10000
                }
            );

            this.logger.info('TopVisor API подключение успешно');
            return true;
        } catch (error) {
            this.logger.error('Ошибка подключения к TopVisor API', error);
            throw new Error(`TopVisor API недоступен: ${error.message}`);
        }
    }                                            /* Проверка подключения к API*/
    async fetchData(startDate, endDate) {
        // Если даты не переданы, используем вчерашний день
        if (!startDate) {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            startDate = yesterday.toISOString().split('T')[0];
            endDate = startDate;
        }

        this.logger.info(`Получение данных за период: ${startDate} - ${endDate}`);

        // Конфигурация запросов (из вашего текущего кода)
        const apiRequests = this.buildApiRequests(startDate, endDate);
        
        // Проверяем существующие данные
        const existingRecords = await this.checkExistingData(startDate);
        if (existingRecords > 0 && !process.env.FORCE_OVERRIDE) {
            this.logger.warn(`Обнаружено ${existingRecords} записей за ${startDate}`);
            this.stats.warnings.push(`Данные за ${startDate} уже существуют (${existingRecords} записей)`);
            return [];
        }

        if (existingRecords > 0 && process.env.FORCE_OVERRIDE === 'true') {
            this.logger.info(`Принудительная перезапись: удаление ${existingRecords} записей за ${startDate}`);
            await this.dbManager.query('DELETE FROM topvisor.positions WHERE event_date = $1', [startDate]);
        }

        // Разделяем запросы на батчи по 4 (чтобы не превысить лимит 5)
        const requestBatches = this.chunkArray(apiRequests, 4);
        const allData = [];

        for (let batchIndex = 0; batchIndex < requestBatches.length; batchIndex++) {
            const batch = requestBatches[batchIndex];
            this.logger.info(`Обработка батча ${batchIndex + 1}/${requestBatches.length} (${batch.length} запросов)`);

            // Выполняем запросы в батче параллельно
            const promises = batch.map(requestConfig => 
                this.makeApiRequest(requestConfig)
                    .then(data => ({ success: true, data, requestConfig }))
                    .catch(error => ({ success: false, error, requestConfig }))
            );

            const results = await Promise.all(promises);

            // Обрабатываем результаты
            for (const result of results) {
                if (result.success) {
                    if (result.data.result && result.data.result.keywords) {
                       const transformedData = await this.transformApiData(result.data, result.requestConfig.name);
                        allData.push(...transformedData);
                    }
                } else {
                    this.logger.error(`Не удалось выполнить запрос "${result.requestConfig.name}"`, result.error);
                    this.stats.errors++;
                }
            }

            // Задержка между батчами (кроме последнего)
            if (batchIndex < requestBatches.length - 1) {
                this.logger.info("Пауза 5 секунд между батчами...");
                await this.delay(5000);
            }
        }

        this.logger.info(`Получено ${allData.length} записей из API`);
        return allData;
    }                                   /* Получение данных из API */
    async saveData(records) {
        let saved = 0;
        let errors = 0;

        for (const record of records) {
            try {
                const exists = await this.recordExists(record);
                
                if (exists) {
                    await this.updateRecord(record);
                } else {
                    await this.insertRecord(record);
                }

                saved++;
            } catch (error) {
                this.logger.error(`Ошибка сохранения записи: ${this.getRecordKey(record)}`, error);
                errors++;
            }
        }

        return { saved, errors };
    }
    buildApiRequests(startDate, endDate) {
        return [
            {
                name: "Позиции: Данные по RU сайту для Яндекс",
                body: {
                    "project_id": "7063822",
                    "regions_indexes": ["5"],
                    "date1": startDate,
                    "date2": endDate,
                    "positions_fields": ["relevant_url", "position", "snippet"],
                    "show_groups": true
                }
            },
            {
                name: "Позиции: Данные по RU сайту для Google",
                body: {
                    "project_id": "7063822",
                    "regions_indexes": ["7"],
                    "date1": startDate,
                    "date2": endDate,
                    "positions_fields": ["relevant_url", "position", "snippet"],
                    "show_groups": true
                }
            },
            {
                name: "Позиции: Данные по EN сайту для Google",
                body: {
                    "project_id": "7063718",
                    "regions_indexes": ["159"],
                    "date1": startDate,
                    "date2": endDate,
                    "positions_fields": ["relevant_url", "position", "snippet"],
                    "show_groups": true
                }
            },
            {
                name: "Позиции: Данные по EN сайту для Bing",
                body: {
                    "project_id": "7063718",
                    "regions_indexes": ["701"],
                    "date1": startDate,
                    "date2": endDate,
                    "positions_fields": ["relevant_url", "position", "snippet"],
                    "show_groups": true
                }
            },
            {
                name: "Позиции: Данные по Блог для Яндекс",
                body: {
                    "project_id": "7093082",
                    "regions_indexes": ["5"],
                    "date1": startDate,
                    "date2": endDate,
                    "positions_fields": ["relevant_url", "position", "snippet"],
                    "show_groups": true
                }
            },
            {
                name: "Позиции: Данные по Блог для Google",
                body: {
                    "project_id": "7093082",
                    "regions_indexes": ["7"],
                    "date1": startDate,
                    "date2": endDate,
                    "positions_fields": ["relevant_url", "position", "snippet"],
                    "show_groups": true
                }
            },
            {
                name: "Позиции: Данные по Термины для Яндекс",
                body: {
                    "project_id": "11430357",
                    "regions_indexes": ["5"],
                    "date1": startDate,
                    "date2": endDate,
                    "positions_fields": ["relevant_url", "position", "snippet"],
                    "show_groups": true
                }
            },
            {
                name: "Позиции: Данные по Термины для Google",
                body: {
                    "project_id": "11430357",
                    "regions_indexes": ["7"],
                    "date1": startDate,
                    "date2": endDate,
                    "positions_fields": ["relevant_url", "position", "snippet"],
                    "show_groups": true
                }
            }
        ];
    }                                  /* Построение конфигурации API запросов     */
    async makeApiRequest(requestConfig, retries = 3) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                this.logger.info(`Выполнение запроса: ${requestConfig.name} (попытка ${attempt})`);
                
                const response = await axios.post(
                    process.env.TOPVISOR_API_URL,
                    requestConfig.body,
                    {
                        headers: {
                            Authorization: `Bearer ${process.env.TOPVISOR_API_KEY}`,
                            "User-Id": process.env.TOPVISOR_USER_ID,
                            "Content-Type": "application/json"
                        },
                        timeout: 30000 // 30 секунд таймаут
                    }
                );

                this.logger.info(`Запрос "${requestConfig.name}" выполнен успешно`);
                return response.data;

            } catch (error) {
                if (error.response?.status === 429) {
                    this.logger.warn(`Превышен лимит API для "${requestConfig.name}". Попытка ${attempt}/${retries}`);
                    if (attempt < retries) {
                        const waitTime = attempt * 10000; // 10, 20, 30 секунд
                        this.logger.info(`Ожидание ${waitTime/1000} секунд перед повторной попыткой...`);
                        await this.delay(waitTime);
                        continue;
                    }
                }
                
                if (attempt === retries) {
                    this.logger.error(`Ошибка в запросе "${requestConfig.name}" после ${retries} попыток`, error);
                    throw error;
                }
                
                this.logger.warn(`Ошибка в запросе "${requestConfig.name}". Попытка ${attempt}/${retries}`, error);
                await this.delay(5000); // 5 секунд задержка перед повтором
            }
        }
    }                      /* Выполнение одного API запроса с повторными попытками*/
    async transformApiData(data, requestName) {
        const records = [];
        
        if (!data.result || !data.result.keywords) {
            this.logger.warn(`API вернул пустой результат для "${requestName}"`);
            return records;
        }

        // Загружаем маппинг при первом вызове
        if (this.projectEngineCache.size === 0) {
            await this.loadProjectEngineMap();
        }

        for (const keyword of data.result.keywords) {
            const request = keyword.name;

            if (!keyword.positionsData || Object.keys(keyword.positionsData).length === 0) {
                continue;
            }

            for (const key in keyword.positionsData) {
                const [event_date, topvisor_project_id, topvisor_region_id] = key.split(":");
                const positionData = keyword.positionsData[key];
                
                let position = positionData.position;
                let relevant_url = positionData.relevant_url || '';
                let snippet = positionData.snippet || '';

                // Обработка позиции
                if (position === "--") {
                    position = null;
                } else {
                    position = parseInt(position, 10);
                }

                try {
                    // Получаем project_engine_id из справочника
                    const project_engine_id = await this.getProjectEngineId(topvisor_project_id, topvisor_region_id);
                    

                    records.push({
                        request,
                        event_date,
                        position,
                        relevant_url,
                        snippet,
                        project_engine_id  // ← ID из справочника
                    });
                    
                } catch (error) {
                    this.logger.error(`Пропускаем запись из-за ошибки маппинга: ${key}`, error);
                    continue;
                }
            }
        }

        return records;
    }                             /* Трансформация данных API с использованием БД-справочника*/
    async recordExists(record) {
        try {
            const result = await this.dbManager.query(
                `SELECT id FROM topvisor.positions 
                 WHERE request = $1 AND event_date = $2 AND project_engine_id = $3`,
                [record.request, record.event_date, record.project_engine_id]
            );
            return result.rows.length > 0;
        } catch (error) {
            this.logger.error('Ошибка проверки существования записи', error);
            return false;
        }
    }                                            /* Проверка существования записи (обновленная) */
    async insertRecord(record) {
        await this.dbManager.query(
            `INSERT INTO topvisor.positions 
             (request, event_date, position, relevant_url, snippet, project_engine_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                record.request,
                record.event_date,
                record.position,
                record.relevant_url,
                record.snippet,
                record.project_engine_id
            ]
        );
    }                                            /* Вставка новой записи (обновленная)*/
    async updateRecord(record) {
        await this.dbManager.query(
            `UPDATE topvisor.positions 
             SET position = $4, relevant_url = $5, snippet = $6, updated_at = CURRENT_TIMESTAMP
             WHERE request = $1 AND event_date = $2 AND project_engine_id = $3`,
            [
                record.request,
                record.event_date,
                record.project_engine_id,
                record.position,
                record.relevant_url,
                record.snippet
            ]
        );
    }                                            /* Обновление существующей записи (обновленная)*/
    async checkExistingData(date) {
        try {
            const result = await this.dbManager.query(
                'SELECT COUNT(*) FROM topvisor.positions WHERE event_date = $1',
                [date]
            );
            return parseInt(result.rows[0].count, 10);
        } catch (error) {
            this.logger.warn(`Ошибка проверки существующих данных: ${error.message}`);
            return 0;
        }
    }                                         /* Проверка существующих данных за дату */
    getRecordKey(record) {
        return `${record.request}|${record.event_date}`;
    }                                                  /* Получение ключа записи для логирования */
    chunkArray(array, chunkSize) {
        const chunks = [];
        for (let i = 0; i < array.length; i += chunkSize) {
            chunks.push(array.slice(i, i + chunkSize));
        }
        return chunks;
    }                                          /* Разделение массива на батчи*/
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }                                                             /* Функция задержки*/
    async getStats(startDate, endDate) {
        try {
            const result = await this.dbManager.query(
                `SELECT 
                    COUNT(*) as total_records,
                    COUNT(DISTINCT d.project_name) as projects_count,
                    COUNT(DISTINCT d.search_engine) as search_engines_count,
                    MIN(p.event_date) as first_date,
                    MAX(p.event_date) as last_date
                 FROM topvisor.positions p
                 JOIN common.dim_projects_engines d ON p.project_engine_id = d.id
                 WHERE p.event_date BETWEEN $1 AND $2`,
                [startDate, endDate]
            );

            return {
                service: this.serviceName,
                period: { startDate, endDate },
                ...result.rows[0]
            };
        } catch (error) {
            this.logger.error('Ошибка получения статистики', error);
            return {
                service: this.serviceName,
                period: { startDate, endDate },
                total_records: 0
            };
        }
    }                                    /* Получение статистики за период*/
}

module.exports = TopVisorCollector;