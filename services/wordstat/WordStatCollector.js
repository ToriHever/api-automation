// services/wordstat/WordStatCollector.js
const BaseCollector = require('../../core/BaseCollector');
const axios = require('axios');

class WordStatCollector extends BaseCollector {
    constructor() {
        super('wordstat');
        this.apiBaseUrl = 'https://searchapi.api.cloud.yandex.net/v2/wordstat';
        this.apiKey = process.env.WORDSTAT_API_KEY;
        this.folderId = process.env.WORDSTAT_FOLDER_ID;
        this.batchSize = 10;
        this.method = process.env.WORDSTAT_METHOD || 'all';
        this.maxRequestsPerRun = parseInt(process.env.WORDSTAT_MAX_PER_RUN || '80', 10);

        if (!this.apiKey || !this.folderId) {
            throw new Error('WORDSTAT_API_KEY и WORDSTAT_FOLDER_ID обязательны');
        }
    }

    // ============================================================
    // БАЗОВЫЕ МЕТОДЫ (BaseCollector interface)
    // ============================================================

    async checkApiConnection() {
        this.logger.info('Проверка подключения к WordStat API');

        try {
            const response = await this.apiPost('/topRequests', {
                phrase: 'защита от ddos',
                numPhrases: 10,
                regions: ['213'],
                devices: ['DEVICE_ALL']
            });

            if (response && (response.results || response.associations)) {
                this.logger.info('WordStat API подключение успешно');
                return true;
            }

            throw new Error('Unexpected API response format');
        } catch (error) {
            if (error.response) {
                console.log('RAW API ERROR:', JSON.stringify(error.response.data, null, 2));
            }
            throw new Error(`WordStat API недоступен: ${error.message}`);
        }
    }

    /**
     * Точка входа — запускает методы в зависимости от this.method
     */
    async fetchData(startDate, endDate) {
        const allRecords = [];

        if (this.method === 'dynamics' || this.method === 'all') {
            this.logger.info('=== Запуск метода: dynamics ===');
            const dynamicsRecords = await this.fetchDynamics(startDate, endDate);
            allRecords.push(...dynamicsRecords);

            this.logger.info(`Dynamics: подготовлено ${dynamicsRecords.length} записей`);

            if (this.method === 'all') {
                await this.delay(2000);
            }
        }

        if (this.method === 'top' || this.method === 'all') {
            this.logger.info('=== Запуск метода: topRequests ===');
            const topRecords = await this.fetchTopRequests(startDate);
            allRecords.push(...topRecords);
            this.logger.info(`TopRequests: подготовлено ${topRecords.length} записей`);
        }

        this.logger.info(`Всего подготовлено записей: ${allRecords.length}`);
        return allRecords;
    }

    async validateRecord(record) {
        if (!record || typeof record !== 'object') return null;

        if (record._type === 'dynamics') {
            return this.validateDynamicsRecord(record);
        }

        if (record._type === 'top') {
            return this.validateTopRecord(record);
        }

        return null;
    }

    async recordExists(record) {
        if (!record) return false;

        try {
            if (record._type === 'top') {
                const result = await this.dbManager.query(
                    `SELECT 1 FROM wordstat.top_requests 
                     WHERE base_phrase_id = $1 
                       AND related_phrase_id = $2 
                       AND check_date = $3`,
                    [record.base_phrase_id, record.related_phrase_id, record.check_date]
                );
                return result.rows.length > 0;
            } else {
                const result = await this.dbManager.query(
                    `SELECT 1 FROM wordstat.tmp_dynamics 
                     WHERE request_id = $1 AND month = $2`,
                    [record.request_id, record.month]
                );
                return result.rows.length > 0;
            }
        } catch (error) {
            this.logger.error('Ошибка проверки существования записи', error);
            return false;
        }
    }

    async insertRecord(record) {
        if (record._type === 'top') {
            await this.dbManager.query(
                `INSERT INTO wordstat.top_requests 
                    (base_phrase_id, related_phrase_id, count, check_date)
                 VALUES ($1, $2, $3, $4)`,
                [record.base_phrase_id, record.related_phrase_id, record.count, record.check_date]
            );
        } else {
            await this.dbManager.query(
                `INSERT INTO wordstat.tmp_dynamics 
                    (request_id, group_id, month, frequency)
                 VALUES ($1, $2, $3, $4)`,
                [record.request_id, record.group_id, record.month, record.frequency]
            );
        }
    }

    async updateRecord(record) {
        if (record._type === 'top') {
            await this.dbManager.query(
                `UPDATE wordstat.top_requests 
                 SET count = $4, updated_at = CURRENT_TIMESTAMP
                 WHERE base_phrase_id = $1 
                   AND related_phrase_id = $2 
                   AND check_date = $3`,
                [record.base_phrase_id, record.related_phrase_id, record.check_date, record.count]
            );
        } else {
            await this.dbManager.query(
                `UPDATE wordstat.tmp_dynamics 
                 SET frequency = $3, group_id = $4, updated_at = CURRENT_TIMESTAMP
                 WHERE request_id = $1 AND month = $2`,
                [record.request_id, record.month, record.frequency, record.group_id]
            );
        }
    }

    async getNextQueueBatch(method, allKeywords, periodKey) {
        const limit = this.maxRequestsPerRun;
        const isDynamics = method === 'dynamics';

        const whereExtra = isDynamics ? 'period_start = $2' : 'check_date = $2';
        const keyValue = isDynamics ? periodKey.periodStart : periodKey.checkDate;

        const existing = await this.dbManager.query(
            `SELECT COUNT(*)::int AS cnt FROM wordstat.collection_queue WHERE method = $1 AND ${whereExtra}`,
            [method, keyValue]
        );

        if (existing.rows[0].cnt === 0) {
            this.logger.info(`Очередь для ${method} (${keyValue}) не создана — добавляю ${allKeywords.length} фраз`);

            for (const phrase of allKeywords) {
                if (isDynamics) {
                    await this.dbManager.query(
                        `INSERT INTO wordstat.collection_queue (method, phrase, period_start, period_end)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (method, phrase, period_start, period_end, check_date) DO NOTHING`,
                        [method, phrase, periodKey.periodStart, periodKey.periodEnd]
                    );
                } else {
                    await this.dbManager.query(
                        `INSERT INTO wordstat.collection_queue (method, phrase, check_date)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (method, phrase, period_start, period_end, check_date) DO NOTHING`,
                        [method, phrase, periodKey.checkDate]
                    );
                }
            }
        }

        const pending = await this.dbManager.query(
            `SELECT id, phrase FROM wordstat.collection_queue
         WHERE method = $1 AND ${whereExtra} AND status IN ('pending', 'error') AND attempts < 5
         ORDER BY attempts ASC, id ASC
         LIMIT $3`,
            [method, keyValue, limit]
        );

        const remaining = await this.dbManager.query(
            `SELECT COUNT(*)::int AS cnt FROM wordstat.collection_queue
         WHERE method = $1 AND ${whereExtra} AND status IN ('pending', 'error') AND attempts < 5`,
            [method, keyValue]
        );

        this.logger.info(`[${method}] Осталось в очереди: ${remaining.rows[0].cnt}, беру в этот запуск: ${pending.rows.length}`);

        return pending.rows;
    }

    async markQueueResult(queueId, success, errorMessage = null) {
        if (success) {
            await this.dbManager.query(
                `UPDATE wordstat.collection_queue
             SET status = 'done', processed_at = CURRENT_TIMESTAMP, attempts = attempts + 1
             WHERE id = $1`,
                [queueId]
            );
        } else {
            await this.dbManager.query(
                `UPDATE wordstat.collection_queue
             SET status = 'error', last_error = $2, attempts = attempts + 1, processed_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
                [queueId, errorMessage]
            );
        }
    }

    getRecordKey(record) {
        if (record._type === 'top') {
            return `top|${record.base_phrase_id}|${record.related_phrase_id}|${record.check_date}`;
        }
        return `dynamics|${record.request_id}|${record.month}`;
    }

    // ============================================================
    // МЕТОД: DYNAMICS
    // ============================================================

    async fetchDynamics(startDate, endDate) {
        const { actualStartDate, actualEndDate } = this.calculatePreviousMonthPeriod();

        const allKeywords = await this.readKeywords('dynamics_keywords.txt');
        const batch = await this.getNextQueueBatch('dynamics', allKeywords, {
            periodStart: actualStartDate,
            periodEnd: actualEndDate
        });

        if (batch.length === 0) {
            this.logger.info('Очередь dynamics пуста для этого запуска');
            return [];
        }

        const records = [];
        for (let i = 0; i < batch.length; i++) {
            const { id: queueId, phrase } = batch[i];
            const result = await this.getDynamics(phrase, actualStartDate, actualEndDate, i + 1, batch.length);

            if (result.success) {
                await this.markQueueResult(queueId, true);
                Object.keys(result.monthlyData).forEach(monthDate => {
                    records.push({
                        _type: 'dynamics',
                        phrase: result.phrase,
                        month: monthDate,
                        frequency: result.monthlyData[monthDate]
                    });
                });
            } else {
                await this.markQueueResult(queueId, false, result.error);
            }

            await this.delay(300);
        }

        return records;
    }

    async getDynamics(phrase, fromDate, toDate, index, total) {
        try {
            const response = await this.apiPost('/dynamics', {
                phrase,
                period: 'PERIOD_MONTHLY',
                fromDate: `${fromDate}T00:00:00Z`,
                toDate: `${toDate}T00:00:00Z`,
                regions: ['213'],
                devices: ['DEVICE_ALL']
            });

            if (response && response.results) {
                const monthlyData = {};
                let totalCount = 0;

                response.results.forEach(item => {
                    const monthKey = item.date.substring(0, 10);
                    const count = (item.count === undefined || item.count === null) ? 0 : Number(item.count);

                    if (Number.isNaN(count)) {
                        this.logger.warn(`[${index}/${total}] dynamics "${phrase}" - невалидный count для ${monthKey}, пропуск`, { rawItem: item });
                        return;
                    }

                    monthlyData[monthKey] = count;
                    totalCount += count;
                });

                this.logger.debug(`[${index}/${total}] dynamics "${phrase}" - ${totalCount.toLocaleString()} показов`);
                return { phrase, monthlyData, success: true };
            }

            this.logger.warn(`[${index}/${total}] dynamics "${phrase}" - нет данных`);
            return { phrase, success: false, error: 'empty response' };
        } catch (error) {
            const apiMessage = error.response?.data?.message || error.message;
            this.logger.error(`[${index}/${total}] dynamics "${phrase}" - ${apiMessage}`);
            return { phrase, success: false, error: apiMessage };
        }
    }

    transformDynamicsData(results) {
        const records = [];

        for (const result of results) {
            if (!result.success || !result.monthlyData) continue;

            Object.keys(result.monthlyData).forEach(monthDate => {
                records.push({
                    _type: 'dynamics',
                    phrase: result.phrase,
                    month: monthDate,
                    frequency: result.monthlyData[monthDate]
                });
            });
        }

        return records;
    }

    async validateDynamicsRecord(record) {
        const resolved = await this.resolveRequestIds(record.phrase);

        if (!resolved) {
            this.logger.warn(`Пропуск dynamics — не найден в common.requests: "${record.phrase}"`);
            return null;
        }

        return {
            _type: 'dynamics',
            request_id: resolved.request_id,
            group_id: resolved.group_id,
            phrase: record.phrase,
            month: record.month,
            frequency: record.frequency
        };
    }

    // ============================================================
    // МЕТОД: TOP REQUESTS
    // ============================================================

    async fetchTopRequests(checkDate) {
        const date = checkDate || this.formatDate(new Date());
        this.logger.info(`Дата для topRequests: ${date}`);

        const allKeywords = await this.readKeywords('top_keywords.txt');
        const batch = await this.getNextQueueBatch('top', allKeywords, { checkDate: date });

        if (batch.length === 0) {
            this.logger.info('Очередь top пуста для этого запуска');
            return [];
        }

        const records = [];
        for (let i = 0; i < batch.length; i++) {
            const { id: queueId, phrase } = batch[i];
            const result = await this.getTopRequests(phrase, i + 1, batch.length);

            if (result.success) {
                await this.markQueueResult(queueId, true);
                result.topRequests.forEach(item => {
                    records.push({
                        _type: 'top',
                        basePhrase: result.phrase,
                        relatedPhrase: item.phrase,
                        count: Number(item.count),
                        check_date: date
                    });
                });
            } else {
                await this.markQueueResult(queueId, false, result.error);
            }

            await this.delay(300);
        }

        return records;
    }

    async getTopRequests(phrase, index, total) {
        try {
            const response = await this.apiPost('/topRequests', {
                phrase,
                numPhrases: 100,
                regions: ['213'],
                devices: ['DEVICE_ALL']
            });

            if (response && response.associations) {
                this.logger.debug(`[${index}/${total}] top "${phrase}" - ${response.associations.length} фраз`);
                return { phrase, topRequests: response.associations, success: true };
            }

            this.logger.warn(`[${index}/${total}] top "${phrase}" - нет данных`);
            return { phrase, success: false, error: 'empty response' };
        } catch (error) {
            const apiMessage = error.response?.data?.message || error.message;
            this.logger.error(`[${index}/${total}] top "${phrase}" - ${apiMessage}`);
            return { phrase, success: false, error: apiMessage };
        }
    }
    transformTopData(results, checkDate) {
        const records = [];

        for (const result of results) {
            if (!result.success || !result.topRequests) continue;

            result.topRequests.forEach(item => {
                records.push({
                    _type: 'top',
                    basePhrase: result.phrase,
                    relatedPhrase: item.phrase,
                    count: Number(item.count),   // protobuf int64 → строка, приводим к числу
                    check_date: checkDate
                });
            });
        }

        return records;
    }

    async validateTopRecord(record) {
        // Резолвим или создаём обе фразы в common.wordstat_phrases
        const basePhraseId = await this.resolveOrCreatePhrase(record.basePhrase);
        const relatedPhraseId = await this.resolveOrCreatePhrase(record.relatedPhrase);

        if (!basePhraseId || !relatedPhraseId) {
            this.logger.warn(`Пропуск top — не удалось получить id фраз: "${record.basePhrase}" / "${record.relatedPhrase}"`);
            return null;
        }

        return {
            _type: 'top',
            base_phrase_id: basePhraseId,
            related_phrase_id: relatedPhraseId,
            count: record.count,
            check_date: record.check_date
        };
    }

    // ============================================================
    // ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ
    // ============================================================

    /**
     * Получить или создать фразу в common.wordstat_phrases, вернуть id
     */
    async resolveOrCreatePhrase(phrase) {
        try {
            const result = await this.dbManager.query(
                `INSERT INTO common.wordstat_phrases (phrase)
                 VALUES ($1)
                 ON CONFLICT (phrase) DO UPDATE SET phrase = EXCLUDED.phrase
                 RETURNING id`,
                [phrase]
            );
            return result.rows[0].id;
        } catch (error) {
            this.logger.error(`Ошибка резолва фразы "${phrase}"`, error);
            return null;
        }
    }

    /**
     * Поиск request_id и group_id из common.requests по тексту запроса
     */
    async resolveRequestIds(phrase) {
        try {
            const result = await this.dbManager.query(
                `SELECT request_id, cluster_topvisor_id 
                 FROM common.requests 
                 WHERE request = $1 
                 LIMIT 1`,
                [phrase]
            );

            if (result.rows.length === 0) return null;

            return {
                request_id: result.rows[0].request_id,
                group_id: result.rows[0].cluster_topvisor_id
            };
        } catch (error) {
            this.logger.error(`Ошибка поиска request_id для "${phrase}"`, error);
            return null;
        }
    }

    /**
     * POST запрос к WordStat API
     */
    async apiPost(endpoint, body) {
        const response = await axios.post(
            `${this.apiBaseUrl}${endpoint}`,
            { ...body, folderId: this.folderId },
            {
                headers: {
                    'Content-Type': 'application/json;charset=utf-8',
                    'Authorization': `Api-Key ${this.apiKey}`
                },
                timeout: 30000
            }
        );
        return response.data;
    }

    /**
     * Чтение ключевых слов из файла
     */
    async readKeywords(filename) {
        const fs = require('fs');
        const path = require('path');

        const keywordsPath = path.join(__dirname, 'keywords', filename);

        if (!fs.existsSync(keywordsPath)) {
            throw new Error(`Файл с ключевыми словами не найден: ${keywordsPath}`);
        }

        const content = fs.readFileSync(keywordsPath, 'utf-8');
        const keywords = content
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && !line.startsWith('#'));

        if (keywords.length === 0) {
            throw new Error(`Файл ${filename} пуст`);
        }

        this.logger.info(`Загружено ${keywords.length} ключевых слов из ${filename}`);
        return keywords;
    }

    /**
     * Обработка ключевых слов пакетами
     */
    async processKeywordsBatch(keywords, handler) {
        const results = [];
        let successCount = 0;
        let errorCount = 0;

        for (let i = 0; i < keywords.length; i += this.batchSize) {
            const batch = keywords.slice(i, i + this.batchSize);
            const batchNumber = Math.floor(i / this.batchSize) + 1;
            const totalBatches = Math.ceil(keywords.length / this.batchSize);

            this.logger.info(`Пакет ${batchNumber}/${totalBatches} (${batch.length} запросов)`);

            const batchResults = await Promise.all(
                batch.map((keyword, index) => handler(keyword, i + index + 1, keywords.length))
            );

            batchResults.forEach(result => {
                if (result.success) {
                    results.push(result);
                    successCount++;
                } else {
                    errorCount++;
                }
            });

            if (i + this.batchSize < keywords.length) {
                await this.delay(1000);
            }
        }

        this.logger.info(`Итого — успешно: ${successCount}, ошибок: ${errorCount}`);
        return results;
    }

    /**
     * Вычисление периода "предыдущий полный месяц"
     */
    calculatePreviousMonthPeriod() {
        if (process.env.WORDSTAT_BACKFILL_MONTH) {
            const [year, month] = process.env.WORDSTAT_BACKFILL_MONTH.split('-').map(Number);
            const firstDay = new Date(year, month - 1, 1);
            const lastDay = new Date(year, month, 0);

            const actualStartDate = this.formatDate(firstDay);
            const actualEndDate = this.formatDate(lastDay);

            this.logger.info(`Бэкафилл периода: ${actualStartDate} - ${actualEndDate} (WORDSTAT_BACKFILL_MONTH)`);

            return { actualStartDate, actualEndDate };
        }

        const now = new Date();
        const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const firstDay = new Date(previousMonth.getFullYear(), previousMonth.getMonth(), 1);
        const lastDay = new Date(previousMonth.getFullYear(), previousMonth.getMonth() + 1, 0);

        const actualStartDate = this.formatDate(firstDay);
        const actualEndDate = this.formatDate(lastDay);

        this.logger.info(`Период: ${actualStartDate} - ${actualEndDate} (${previousMonth.toLocaleString('ru-RU', { month: 'long', year: 'numeric' })})`);

        return { actualStartDate, actualEndDate };
    }

    formatDate(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = WordStatCollector;