// services/topvisor/TopVisorCollector.js
const BaseCollector = require('../../core/BaseCollector');
const axios = require('axios');
const crypto = require('crypto');

class TopVisorCollector extends BaseCollector {
    constructor() {
        super('topvisor');
        
        // Кэш для project_engine_id
        this.projectEngineCache = new Map();
        // Кэш для snippet_id
        this.snippetCache = new Map();
        
        // Словарь поисковиков
        this.searchEngineMap = {
            "7": "Google",
            "5": "Yandex",
            "159": "Google",
            "701": "Bing"
        };

        // Словарь проектов
        this.projectMap = {
            "11430357": "Термины",
            "7093082": "Блог",
            "7063718": "DDG-EN",
            "7063822": "DDG-RU"
        };
    }

    /**
     * Хеширование сниппета для уникальности
     */
    hashSnippet(snippet) {
        return crypto.createHash('md5').update(snippet || '').digest('hex');
    }

    /**
     * Получение или создание project_engine_id
     */
    async getProjectEngineId(projectName, searchEngine) {
        const cacheKey = `${projectName}|${searchEngine}`;
        
        // Проверка кэша
        if (this.projectEngineCache.has(cacheKey)) {
            return this.projectEngineCache.get(cacheKey);
        }

        try {
            // Проверяем существует ли запись
            const existingResult = await this.dbManager.query(
                `SELECT id FROM common.dim_projects_engines 
                 WHERE project_name = $1 AND search_engine = $2`,
                [projectName, searchEngine]
            );

            if (existingResult.rows.length > 0) {
                const id = existingResult.rows[0].id;
                this.projectEngineCache.set(cacheKey, id);
                return id;
            }

            // Создаем новую запись
            const insertResult = await this.dbManager.query(
                `INSERT INTO common.dim_projects_engines (project_name, search_engine) 
                 VALUES ($1, $2) 
                 ON CONFLICT (project_name, search_engine) DO UPDATE 
                 SET created_at = CURRENT_TIMESTAMP
                 RETURNING id`,
                [projectName, searchEngine]
            );

            const id = insertResult.rows[0].id;
            this.projectEngineCache.set(cacheKey, id);
            return id;
        } catch (error) {
            this.logger.error(`Ошибка получения project_engine_id: ${error.message}`);
            throw error;
        }
    }

    /**
     * Получение или создание snippet_id
     */
    async getSnippetId(snippet) {
        const snippetHash = this.hashSnippet(snippet);
        
        // Проверка кэша
        if (this.snippetCache.has(snippetHash)) {
            const cachedData = this.snippetCache.get(snippetHash);
            // Увеличиваем счетчик использования
            await this.dbManager.query(
                `UPDATE topvisor.dim_snippets 
                 SET uses = uses + 1, updated = CURRENT_TIMESTAMP 
                 WHERE id = $1`,
                [cachedData.id]
            );
            return cachedData.id;
        }

        try {
            // Проверяем существует ли сниппет
            const existingResult = await this.dbManager.query(
                `SELECT id FROM topvisor.dim_snippets WHERE snippet_hash = $1`,
                [snippetHash]
            );

            if (existingResult.rows.length > 0) {
                const id = existingResult.rows[0].id;
                this.snippetCache.set(snippetHash, { id });
                
                // Увеличиваем счетчик использования
                await this.dbManager.query(
                    `UPDATE topvisor.dim_snippets 
                     SET uses = uses + 1, updated = CURRENT_TIMESTAMP 
                     WHERE id = $1`,
                    [id]
                );
                
                return id;
            }

            // Создаем новую запись
            const insertResult = await this.dbManager.query(
                `INSERT INTO topvisor.dim_snippets (snippet_hash, snippet, uses) 
                 VALUES ($1, $2, 1) 
                 RETURNING id`,
                [snippetHash, snippet || '']
            );

            const id = insertResult.rows[0].id;
            this.snippetCache.set(snippetHash, { id });
            return id;
        } catch (error) {
            this.logger.error(`Ошибка получения snippet_id: ${error.message}`);
            throw error;
        }
    }

    /**
     * Проверка подключения к API
     */
    async checkApiConnection() {
        this.logger.info('Проверка подключения к TopVisor API');
        
        try {
            const response = await axios.post(
                process.env.TOPVISOR_API_URL,
                { "show": "info" },
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
    }

    /**
     * Получение данных из API
     */
    async fetchData(startDate, endDate) {
        this.logger.info(`Получение данных TopVisor за период ${startDate} - ${endDate}`);
        
        const allResults = [];
        const projects = Object.keys(this.projectMap);
        
        for (const projectId of projects) {
            const projectName = this.projectMap[projectId];
            this.logger.info(`Обработка проекта: ${projectName} (ID: ${projectId})`);
            
            try {
                const requestData = {
                    project_id: projectId,
                    dates: [startDate, endDate],
                    show_exists_only: 1,
                    show_headers: 0,
                    fields: ["request", "date", "position", "relevant_url", "snippet", "project_id", "search_engine"]
                };

                const response = await axios.post(
                    process.env.TOPVISOR_API_URL,
                    requestData,
                    {
                        headers: {
                            Authorization: `Bearer ${process.env.TOPVISOR_API_KEY}`,
                            "User-Id": process.env.TOPVISOR_USER_ID,
                            "Content-Type": "application/json"
                        },
                        timeout: 30000
                    }
                );

                if (response.data && response.data.result) {
                    const result = response.data.result;
                    const dataLength = Object.keys(result).length;
                    
                    this.logger.info(`Получено ${dataLength} записей для проекта ${projectName}`);
                    
                    for (const key in result) {
                        const item = result[key];
                        const searchEngineName = this.searchEngineMap[item.search_engine] || item.search_engine;
                        
                        allResults.push({
                            request: item.request,
                            event_date: item.date,
                            project_name: projectName,
                            search_engine: searchEngineName,
                            position: item.position,
                            relevant_url: item.relevant_url || '',
                            snippet: item.snippet || ''
                        });
                    }
                } else {
                    this.logger.warn(`Нет данных для проекта ${projectName}`);
                }

                // Задержка между запросами
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                this.logger.error(`Ошибка получения данных для проекта ${projectName}:`, error);
                if (error.response && error.response.status === 429) {
                    this.logger.warn('Лимит API достигнут, ждем 60 секунд...');
                    await new Promise(resolve => setTimeout(resolve, 60000));
                }
            }
        }
        
        this.logger.info(`Всего получено ${allResults.length} записей из TopVisor API`);
        return allResults;
    }

    /**
     * Проверка существования записи (с новой структурой)
     */
    async recordExists(record, forceOverride = false) {
        if (forceOverride) return false;

        try {
            // Получаем project_engine_id для проверки
            const projectEngineId = await this.getProjectEngineId(
                record.project_name, 
                record.search_engine
            );

            const result = await this.dbManager.query(
                `SELECT 1 FROM topvisor.positions 
                 WHERE request = $1 
                   AND event_date = $2 
                   AND project_engine_id = $3`,
                [record.request, record.event_date, projectEngineId]
            );
            
            return result.rows.length > 0;
        } catch (error) {
            this.logger.error('Ошибка проверки существования записи:', error);
            return false;
        }
    }

    /**
     * Вставка записи (с новой структурой)
     */
    async insertRecord(record) {
        try {
            // Получаем или создаем project_engine_id
            const projectEngineId = await this.getProjectEngineId(
                record.project_name, 
                record.search_engine
            );
            
            // Получаем или создаем snippet_id
            const snippetId = await this.getSnippetId(record.snippet);
            
            // Вставляем запись в основную таблицу
            await this.dbManager.query(
                `INSERT INTO topvisor.positions 
                 (request, event_date, position, relevant_url, snippet_id, project_engine_id) 
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (request, event_date, project_engine_id) 
                 DO UPDATE SET 
                    position = EXCLUDED.position,
                    relevant_url = EXCLUDED.relevant_url,
                    snippet_id = EXCLUDED.snippet_id,
                    updated_at = CURRENT_TIMESTAMP`,
                [
                    record.request,
                    record.event_date,
                    record.position,
                    record.relevant_url || '',
                    snippetId,
                    projectEngineId
                ]
            );
            
            return true;
        } catch (error) {
            this.logger.error('Ошибка вставки записи:', error);
            this.logger.error('Данные записи:', record);
            return false;
        }
    }

    /**
     * Очистка кэшей после завершения работы
     */
    async cleanup() {
        this.projectEngineCache.clear();
        this.snippetCache.clear();
        this.logger.info('Кэши очищены');
    }

    /**
     * Переопределение метода run для добавления очистки кэшей
     */
    async run(options = {}) {
        try {
            const result = await super.run(options);
            await this.cleanup();
            return result;
        } catch (error) {
            await this.cleanup();
            throw error;
        }
    }
}

module.exports = TopVisorCollector;