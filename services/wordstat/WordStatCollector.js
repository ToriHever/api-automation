// services/wordstat/WordStatCollector.js
const BaseCollector = require('../../core/BaseCollector');
const axios = require('axios');

class WordStatCollector extends BaseCollector {
    constructor() {
        super('wordstat');
        // ✅ Правильный URL и токен (как в рабочем скрипте)
        this.apiUrl = 'https://api.wordstat.yandex.net/v1/dynamics';
        this.apiToken = process.env.WORDSTAT_API_TOKEN; // ✅ Изменено с WORDSTAT_API_KEY
        this.batchSize = 10;
        
        if (!this.apiToken) {
            throw new Error('WORDSTAT_API_TOKEN environment variable is required');
        }
    }

    /**
     * Проверка подключения к WordStat API
     */
    async checkApiConnection() {
        this.logger.info('Проверка подключения к WordStat API');
        
        try {
            // ✅ Тестовый запрос за последний полный месяц (как в вашем рабочем скрипте)
            const testPeriod = this.calculatePreviousMonthPeriod();
            
            const response = await axios.post(
                this.apiUrl,
                {
                    phrase: 'тест',
                    period: 'monthly',
                    fromDate: testPeriod.actualStartDate,
                    toDate: testPeriod.actualEndDate
                },
                {
                    headers: {
                        'Content-Type': 'application/json;charset=utf-8',
                        'Authorization': `Bearer ${this.apiToken}`
                    },
                    timeout: 10000
                }
            );
            
            if (response.data && response.data.dynamics) {
                this.logger.info('WordStat API подключение успешно');
                return true;
            }
            
            throw new Error('Unexpected API response format');
        } catch (error) {
            this.logger.error('Ошибка подключения к WordStat API', error);
            throw new Error(`WordStat API недоступен: ${error.message}`);
        }
    }

    /**
     * Получение данных из WordStat API
     */
    async fetchData(startDate, endDate) {
        try {
            // Автоматически вычисляем период "предыдущий полный месяц"
            const { actualStartDate, actualEndDate } = this.calculatePreviousMonthPeriod(startDate, endDate);
            
            this.logger.info(`Получение данных WordStat за период: ${actualStartDate} - ${actualEndDate}`);

            // 1. Чтение ключевых слов из файлов
            const keywords = await this.readKeywords();

            // 2. Получение динамики для всех ключевых слов
            const allResults = await this.processKeywordsBatch(keywords, actualStartDate, actualEndDate);

            // 3. Трансформация данных для сохранения
            const records = this.transformData(allResults);

            this.logger.info(`Подготовлено записей для сохранения: ${records.length}`);
            
            return records;

        } catch (error) {
            this.logger.error(`Ошибка получения данных WordStat: ${error.message}`, error);
            throw error;
        }
    }

    /**
     * Вычисление периода "предыдущий полный месяц"
     * Возвращает диапазон от 1-го до последнего числа предыдущего месяца
     */
    calculatePreviousMonthPeriod(startDate, endDate) {
        const now = new Date();
        
        // Переходим к предыдущему месяцу
        const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        
        // Первое число предыдущего месяца
        const firstDay = new Date(previousMonth.getFullYear(), previousMonth.getMonth(), 1);
        
        // Последнее число предыдущего месяца
        const lastDay = new Date(previousMonth.getFullYear(), previousMonth.getMonth() + 1, 0);
        
        const actualStartDate = this.formatDate(firstDay);
        const actualEndDate = this.formatDate(lastDay);
        
        this.logger.info(`Автоматический расчет периода: ${actualStartDate} - ${actualEndDate}`);
        this.logger.info(`Предыдущий месяц: ${previousMonth.toLocaleString('ru-RU', { month: 'long', year: 'numeric' })}`);
        this.logger.info(`Дней в месяце: ${lastDay.getDate()}`);
        
        return { actualStartDate, actualEndDate };
    }

    /**
     * Форматирование даты в YYYY-MM-DD
     */
    formatDate(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    /**
     * Чтение ключевых слов из файла dynamics_keywords.txt
     */
    async readKeywords() {
        const fs = require('fs');
        const path = require('path');
        
        const keywordsPath = path.join(__dirname, 'keywords', 'dynamics_keywords.txt');
        
        if (!fs.existsSync(keywordsPath)) {
            this.logger.error(`Файл ${keywordsPath} не найден`);
            this.logger.info('Создайте файл: services/wordstat/keywords/dynamics_keywords.txt');
            this.logger.info('Добавьте в него поисковые запросы (каждый с новой строки)');
            throw new Error('Файл с ключевыми словами не найден');
        }

        const content = fs.readFileSync(keywordsPath, 'utf-8');
        const keywords = content
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && !line.startsWith('#'));

        if (keywords.length === 0) {
            this.logger.warn('Файл с ключевыми словами пуст');
            throw new Error('Файл dynamics_keywords.txt пуст');
        }

        this.logger.info(`Загружено ${keywords.length} ключевых слов из файла`);
        return keywords;
    }

    /**
     * Обработка ключевых слов пакетами
     */
    async processKeywordsBatch(keywords, fromDate, toDate) {
        const results = [];
        let successCount = 0;
        let errorCount = 0;

        this.logger.info(`Обработка пакетами по ${this.batchSize} запросов`);

        for (let i = 0; i < keywords.length; i += this.batchSize) {
            const batch = keywords.slice(i, i + this.batchSize);
            const batchNumber = Math.floor(i / this.batchSize) + 1;
            const totalBatches = Math.ceil(keywords.length / this.batchSize);

            this.logger.info(`Пакет ${batchNumber}/${totalBatches} (${batch.length} запросов)`);

            // Параллельная обработка пакета
            const batchPromises = batch.map((keyword, index) => 
                this.getWordstatDynamics(keyword, fromDate, toDate, i + index + 1, keywords.length)
            );

            const batchResults = await Promise.all(batchPromises);

            // Сбор результатов
            batchResults.forEach(result => {
                if (result.success && result.monthlyData) {
                    results.push(result);
                    successCount++;
                } else {
                    errorCount++;
                }
            });

            // Задержка между пакетами (WordStat лимит: 10 req/sec)
            if (i + this.batchSize < keywords.length) {
                this.logger.debug(`Пауза 1 секунда между пакетами`);
                await this.delay(1000);
            }
        }

        this.logger.info(`Успешно: ${successCount}, Ошибок: ${errorCount}`);
        this.stats.warnings.push(`Успешно: ${successCount}, Ошибок: ${errorCount}`);

        return results;
    }

    /**
     * Получение динамики для одного ключевого слова
     */
   async getWordstatDynamics(phrase, fromDate, toDate, index, total) {
    const requestBody = {
        phrase: phrase,
        period: 'monthly',
        fromDate: fromDate,
        toDate: toDate
    };

    try {
        const response = await axios.post(
            this.apiUrl,
            requestBody,
            {
                headers: {
                    'Content-Type': 'application/json;charset=utf-8',
                    'Authorization': `Bearer ${this.apiToken}`
                },
                timeout: 30000
            }
        );

        if (response.data && response.data.dynamics) {
            const dynamics = response.data.dynamics;
            
            // ✅ ИСПРАВЛЕНО: Сохраняем оригинальную дату из API
            const monthlyData = {};
            let totalCount = 0;

            dynamics.forEach(item => {
                // item.date уже в формате "YYYY-MM-DD" или "YYYY-MM"
                let monthKey = item.date;
                
                // Если пришло только "YYYY-MM", добавляем "-01"
                if (monthKey.length === 7) { // формат "YYYY-MM"
                    monthKey = `${monthKey}-01`;
                }
                
                monthlyData[monthKey] = item.count;
                totalCount += item.count;
            });

            this.logger.debug(`[${index}/${total}] "${phrase}" - ${totalCount.toLocaleString()} показов`);

            return {
                phrase,
                monthlyData,
                totalCount,
                requestPhrase: response.data.requestPhrase,
                success: true
            };
        }

        this.logger.warn(`[${index}/${total}] "${phrase}" - нет данных`);
        return { phrase, success: false };

    } catch (error) {
        if (error.response?.status === 429) {
            this.logger.warn(`[${index}/${total}] "${phrase}" - превышен лимит, повтор через 2с`);
            await this.delay(2000);
            return this.getWordstatDynamics(phrase, fromDate, toDate, index, total);
        }

        this.logger.error(`[${index}/${total}] "${phrase}" - ${error.response?.data?.message || error.message}`);
        return { phrase, success: false, error: error.message };
    }
}

    /**
     * Трансформация данных API в формат для БД
     */
   transformData(results) {
    const records = [];

    for (const result of results) {
        const { phrase, monthlyData } = result;

        // monthlyData уже содержит правильные ключи в формате YYYY-MM-DD
        Object.keys(monthlyData).forEach(monthDate => {
            records.push({
                request: phrase,
                month: monthDate,  // ✅ Используем как есть из API
                frequency: monthlyData[monthDate],
                group: 'Нет группы'
            });
        });
    }

    this.logger.debug(`Примеры дат в records: ${records.slice(0, 3).map(r => r.month).join(', ')}`);
    
    return records;
}

    /**
     * Проверка существования записи
     */
    async recordExists(record) {
        try {
            const result = await this.dbManager.query(
                `SELECT 1 FROM wordstat.tmp_dynamics 
                 WHERE request = $1 AND month = $2`,
                [record.request, record.month]
            );
            return result.rows.length > 0;
        } catch (error) {
            this.logger.error('Ошибка проверки существования записи', error);
            return false;
        }
    }

    /**
     * Вставка новой записи
     */
    async insertRecord(record) {
        await this.dbManager.query(
            `INSERT INTO wordstat.tmp_dynamics (request, month, frequency, "group")
             VALUES ($1, $2, $3, $4)`,
            [record.request, record.month, record.frequency, record.group]
        );
    }

    /**
     * Обновление существующей записи
     */
    async updateRecord(record) {
        await this.dbManager.query(
            `UPDATE wordstat.tmp_dynamics 
             SET frequency = $3, "group" = $4, updated_at = CURRENT_TIMESTAMP
             WHERE request = $1 AND month = $2`,
            [record.request, record.month, record.frequency, record.group]
        );
    }

    /**
     * Получение ключа записи для логирования
     */
    getRecordKey(record) {
        return `${record.request}|${record.month}`;
    }

    /**
     * Задержка
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Статистика по собранным данным
     */
    async getStats(startDate, endDate) {
        try {
            const result = await this.dbManager.query(
                `SELECT 
                    COUNT(*) as total_records,
                    COUNT(DISTINCT request) as unique_requests,
                    COUNT(DISTINCT month) as unique_months,
                    SUM(frequency::INTEGER) as total_frequency,
                    MIN(month) as first_month,
                    MAX(month) as last_month
                 FROM wordstat.tmp_dynamics
                 WHERE month BETWEEN $1 AND $2`,
                [startDate, endDate]
            );

            return {
                service: 'wordstat',
                period: { startDate, endDate },
                ...result.rows[0]
            };
        } catch (error) {
            this.logger.error('Ошибка получения статистики', error);
            return {
                service: 'wordstat',
                period: { startDate, endDate },
                total_records: 0
            };
        }
    }
}

module.exports = WordStatCollector;