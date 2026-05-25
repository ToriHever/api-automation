const BaseCollector = require('../../core/BaseCollector');
const axios = require('axios');
const crypto = require('crypto');

class TopVisorCollector extends BaseCollector {
    constructor() {
        super('topvisor');
        this.projectEngineCache = new Map();
        this.urlMappingCache = new Map();

        if (!process.env.TOPVISOR_API_KEY || !process.env.TOPVISOR_USER_ID) {
            throw new Error('TOPVISOR_API_KEY and TOPVISOR_USER_ID environment variables are required');
        }
    }

    cleanUrl(url) {
        if (!url || typeof url !== 'string') return '';
        return url.split('#:~:text')[0].trim();
    }

    async loadProjectEngineMap() {
        try {
            const result = await this.dbManager.query(
                `SELECT topvisor_project_id, topvisor_region_id, id as project_engine_id
                 FROM common.dim_projects_engines 
                 WHERE topvisor_project_id IS NOT NULL AND topvisor_region_id IS NOT NULL`
            );

            this.projectEngineCache.clear();
            for (const row of result.rows) {
                const key = `${row.topvisor_project_id}:${row.topvisor_region_id}`;
                this.projectEngineCache.set(key, row.project_engine_id);
            }

            this.logger.info(`Загружено ${this.projectEngineCache.size} маппингов`);
        } catch (error) {
            this.logger.error('Ошибка загрузки маппинга проектов', error);
        }
    }

    async getProjectEngineId(topvisorProjectId, topvisorRegionId) {
        const key = `${topvisorProjectId}:${topvisorRegionId}`;
        if (this.projectEngineCache.has(key)) {
            return this.projectEngineCache.get(key);
        }

        const result = await this.dbManager.query(
            `SELECT id FROM common.dim_projects_engines 
             WHERE topvisor_project_id = $1 AND topvisor_region_id = $2`,
            [topvisorProjectId, topvisorRegionId]
        );

        if (result.rows.length > 0) {
            const id = result.rows[0].id;
            this.projectEngineCache.set(key, id);
            return id;
        }

        throw new Error(`Не найден маппинг для ${key}`);
    }

    /**
     * МАССОВАЯ нормализация URL
     */
    async normalizeBulkUrls(urls) {
        const cleanedUrls = urls.map(url => this.cleanUrl(url || '')).filter(url => url !== '');
        if (cleanedUrls.length === 0) return new Map();

        const uniqueUrls = [...new Set(cleanedUrls)];
        this.logger.info(`Нормализация ${uniqueUrls.length} URL`);

        const values = uniqueUrls.map((url, i) => `($${i + 1})`).join(',');
        const query = `
            INSERT INTO common.site_map (url) 
            VALUES ${values}
            ON CONFLICT (url) DO UPDATE SET url = EXCLUDED.url
            RETURNING id, url
        `;

        const result = await this.dbManager.query(query, uniqueUrls);

        const urlMapping = new Map();
        for (const row of result.rows) {
            urlMapping.set(row.url, row.id);
            this.urlMappingCache.set(row.url, row.id);
        }

        return urlMapping;
    }

    async preloadUrlMappings() {
        try {
            const result = await this.dbManager.query(`SELECT id, url FROM common.site_map`);
            this.urlMappingCache.clear();
            for (const row of result.rows) {
                this.urlMappingCache.set(row.url, row.id);
            }
            this.logger.info(`Загружено ${this.urlMappingCache.size} URL в кэш`);
        } catch (error) {
            this.logger.warn(`Не удалось загрузить URL: ${error.message}`);
        }
    }

    async checkApiConnection() {
        this.logger.info('Проверка подключения к TopVisor API');
        await axios.post(process.env.TOPVISOR_API_URL, { "show": "info" }, {
            headers: {
                Authorization: `Bearer ${process.env.TOPVISOR_API_KEY}`,
                "User-Id": process.env.TOPVISOR_USER_ID,
                "Content-Type": "application/json"
            },
            timeout: 10000
        });
        this.logger.info('TopVisor API подключение успешно');
        return true;
    }

    async fetchData(startDate, endDate) {
        if (!startDate) {
            const today = new Date();
            startDate = today.toISOString().split('T')[0];
            endDate = startDate;
        }

        this.logger.info(`Получение данных: ${startDate} - ${endDate}`);
        await this.preloadUrlMappings();

        const existingRecords = await this.checkExistingData(startDate);
        if (existingRecords > 0 && !process.env.FORCE_OVERRIDE) {
            this.logger.warn(`Данные за ${startDate} существуют (${existingRecords})`);
            this.stats.warnings.push(`Данные существуют`);
            return [];
        }

        if (existingRecords > 0 && process.env.FORCE_OVERRIDE === 'true') {
            await this.dbManager.query('DELETE FROM topvisor.positions WHERE event_date = $1', [startDate]);
        }

        const apiRequests = this.buildApiRequests(startDate, endDate);
        const batches = this.chunkArray(apiRequests, 4);
        const allData = [];

        for (let i = 0; i < batches.length; i++) {
            this.logger.info(`Батч ${i + 1}/${batches.length}`);

            const promises = batches[i].map(cfg =>
                this.makeApiRequest(cfg)
                    .then(data => ({ success: true, data, cfg }))
                    .catch(error => ({ success: false, error, cfg }))
            );

            const results = await Promise.all(promises);

            for (const res of results) {
                if (res.success && res.data.result?.keywords) {
                    const data = await this.transformApiData(res.data, res.cfg.name);
                    allData.push(...data);
                } else if (!res.success) {
                    this.logger.error(`Ошибка "${res.cfg.name}"`, res.error);
                    this.stats.errors++;
                }
            }

            if (i < batches.length - 1) await this.delay(5000);
        }

        return allData;
    }

    /**
     * ОПТИМИЗИРОВАННАЯ массовая запись
     */
    async processAndSaveData(data, forceOverride = false) {
        if (!data || data.length === 0) {
            this.logger.warn('Нет данных для сохранения');
            return;
        }

        this.logger.info(`Массовая обработка ${data.length} записей`);

        // 1. Массовая нормализация URL
        const allUrls = data.map(r => r.relevant_url).filter(Boolean);
        const urlMapping = await this.normalizeBulkUrls(allUrls);

        // 2. Подготовка записей (без snippet_id)
        const records = data.map(r => {
            const cleanUrl = this.cleanUrl(r.relevant_url || '');
            const urlId = urlMapping.get(cleanUrl) || null;

            return {
                request: r.request,
                event_date: r.event_date,
                position: r.position,
                relevant_url_id: urlId,
                project_engine_id: r.project_engine_id,
                cluster_topvisor_id: r.cluster_topvisor_id || null
            };
        });

        // 3. Массовая вставка
        await this.bulkInsertRecords(records, forceOverride);

        this.stats.processed = records.length;
        this.stats.inserted = records.length;
        this.logger.info(`✅ Вставлено: ${records.length}`);
    }

    /**
     * BULK INSERT в БД
     */
    async bulkInsertRecords(records, forceOverride = false) {
        const chunkSize = 1000;
        const chunks = this.chunkArray(records, chunkSize);

        this.logger.info(`Bulk insert: ${chunks.length} чанков`);

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];

            const values = [];
            const params = [];
            let idx = 1;

            for (const r of chunk) {
                values.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5})`);
                params.push(r.request, r.event_date, r.position, r.relevant_url_id,
                    r.project_engine_id, r.cluster_topvisor_id);
                idx += 6;
            }

            const conflict = forceOverride
                ? `ON CONFLICT (request, event_date, project_engine_id)
               DO UPDATE SET position = EXCLUDED.position, relevant_url_id = EXCLUDED.relevant_url_id,
                             cluster_topvisor_id = EXCLUDED.cluster_topvisor_id`
                : `ON CONFLICT (request, event_date, project_engine_id) DO NOTHING`;

            const query = `
            INSERT INTO topvisor.positions
            (request, event_date, position, relevant_url_id, project_engine_id, cluster_topvisor_id)
            VALUES ${values.join(',')} ${conflict}
        `;

            await this.dbManager.query(query, params);
            this.logger.info(`Чанк ${i + 1}/${chunks.length}: ${chunk.length} записей`);
        }
    }

    buildApiRequests(startDate, endDate) {
        return [
            { name: "RU Яндекс", body: { project_id: "7063822", regions_indexes: ["5"], date1: startDate, date2: endDate, positions_fields: ["relevant_url", "position"], show_groups: true } },
            { name: "RU Google", body: { project_id: "7063822", regions_indexes: ["7"], date1: startDate, date2: endDate, positions_fields: ["relevant_url", "position"], show_groups: true } },
            { name: "EN Google", body: { project_id: "7063718", regions_indexes: ["159"], date1: startDate, date2: endDate, positions_fields: ["relevant_url", "position"], show_groups: true } },
            { name: "EN Bing", body: { project_id: "7063718", regions_indexes: ["701"], date1: startDate, date2: endDate, positions_fields: ["relevant_url", "position"], show_groups: true } },
            { name: "Блог Яндекс", body: { project_id: "7093082", regions_indexes: ["5"], date1: startDate, date2: endDate, positions_fields: ["relevant_url", "position"], show_groups: true } },
            { name: "Блог Google", body: { project_id: "7093082", regions_indexes: ["7"], date1: startDate, date2: endDate, positions_fields: ["relevant_url", "position"], show_groups: true } },
            { name: "Термины Яндекс", body: { project_id: "11430357", regions_indexes: ["5"], date1: startDate, date2: endDate, positions_fields: ["relevant_url", "position"], show_groups: true } },
            { name: "Термины Google", body: { project_id: "11430357", regions_indexes: ["7"], date1: startDate, date2: endDate, positions_fields: ["relevant_url", "position"], show_groups: true } }
        ];
    }

    async makeApiRequest(cfg, retries = 3) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await axios.post(process.env.TOPVISOR_API_URL, cfg.body, {
                    headers: {
                        Authorization: `Bearer ${process.env.TOPVISOR_API_KEY}`,
                        "User-Id": process.env.TOPVISOR_USER_ID,
                        "Content-Type": "application/json"
                    },
                    timeout: 30000
                });
                return response.data;
            } catch (error) {
                if (error.response?.status === 429 && attempt < retries) {
                    await this.delay(attempt * 10000);
                    continue;
                }
                if (attempt === retries) throw error;
                await this.delay(5000);
            }
        }
    }

    async transformApiData(data, requestName) {
        const records = [];
        if (!data.result?.keywords) return records;
        if (this.projectEngineCache.size === 0) await this.loadProjectEngineMap();

        for (const kw of data.result.keywords) {
            if (!kw.positionsData) continue;

            for (const key in kw.positionsData) {
                const [date, projId, regId] = key.split(":");
                const pos = kw.positionsData[key];

                let position = pos.position === "--" ? null : parseInt(pos.position, 10);
                const engineId = await this.getProjectEngineId(projId, regId);

                records.push({
                    request: kw.name,
                    event_date: date,
                    position,
                    relevant_url: pos.relevant_url || '',
                    snippet: pos.snippet,
                    project_engine_id: engineId,
                    cluster_topvisor_id: null
                });
            }
        }

        return records;
    }

    async checkExistingData(date) {
        const result = await this.dbManager.query(
            'SELECT COUNT(*) FROM topvisor.positions WHERE event_date = $1', [date]
        );
        return parseInt(result.rows[0].count, 10);
    }

    chunkArray(arr, size) {
        const chunks = [];
        for (let i = 0; i < arr.length; i += size) {
            chunks.push(arr.slice(i, i + size));
        }
        return chunks;
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = TopVisorCollector;