// services/yandex-serp/YandexSerpCollector.js
const BaseCollector = require('../../core/BaseCollector');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const API_URL = 'https://searchapi.api.cloud.yandex.net/v2/web/search';

class YandexSerpCollector extends BaseCollector {
    constructor() {
        super('yandex-serp');
        this.config = this.getConfig();

        if (!process.env.YANDEX_SEARCH_API_KEY || !process.env.YANDEX_SEARCH_FOLDER_ID) {
            throw new Error('YANDEX_SEARCH_API_KEY and YANDEX_SEARCH_FOLDER_ID environment variables are required');
        }

        // preserveOrder: true — обязателен для смешанного контента вида
        // "Защита от <hlword>ddos</hlword> — DDoS-Guard": без него порядок текста
        // и вложенных тегов подсветки перемешивается при сборке title/snippet.
        this.xmlParser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: '@_',
            textNodeName: '#text',
            preserveOrder: true,
            trimValues: false
        });
    }

    /**
     * Проверка подключения — только валидация наличия ключей.
     * Реальный тестовый запрос не делаем: API платный, каждый запрос стоит денег.
     */
    async checkApiConnection() {
        this.logger.info('Проверка конфигурации Yandex Search API');
        if (!process.env.YANDEX_SEARCH_API_KEY || !process.env.YANDEX_SEARCH_FOLDER_ID) {
            throw new Error('Отсутствуют учётные данные Yandex Search API');
        }
        this.logger.info('Конфигурация Yandex Search API в порядке (реальный запрос не отправлялся — API платный)');
        return true;
    }

    /**
     * Список запросов для проверки. Пока — фиксированный файл
     * services/yandex-serp/keywords/target_keywords.txt.
     * Позже можно переключить на топ-N по частотности из wordstat.tmp_dynamics.
     */
    loadKeywords() {
        const filePath = path.join(__dirname, 'keywords', 'target_keywords.txt');
        const raw = fs.readFileSync(filePath, 'utf8');
        const keywords = raw
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);

        const limit = this.config.maxKeywordsPerRun || 100;
        return keywords.slice(0, limit);
    }

    /**
     * В режиме preserveOrder каждый элемент — массив объектов вида { tagName: [...] },
     * плюс служебный ключ ':@' для атрибутов. Текстовые узлы — { '#text': 'строка' }.
     * findChildren достаёт все дочерние узлы с нужным тегом (в порядке появления).
     */
    findChildren(node, tagName) {
        if (!Array.isArray(node)) return [];
        return node
            .filter(entry => Object.prototype.hasOwnProperty.call(entry, tagName))
            .map(entry => entry[tagName]);
    }

    findChild(node, tagName) {
        const children = this.findChildren(node, tagName);
        return children.length ? children[0] : undefined;
    }

    /**
     * Собирает текст узла с сохранением порядка, включая текст внутри вложенных
     * тегов подсветки (<hlword>ddos</hlword>) — иначе "Защита от ddos" превращается
     * в "ddosЗащита от" из-за произвольного порядка ключей объекта.
     */
    extractText(node) {
        if (!Array.isArray(node)) return '';
        let result = '';
        for (const entry of node) {
            if (Object.prototype.hasOwnProperty.call(entry, '#text')) {
                result += entry['#text'];
                continue;
            }
            for (const key of Object.keys(entry)) {
                if (key === ':@') continue;
                result += this.extractText(entry[key]);
            }
        }
        return result;
    }

    /**
     * Схлопывает переносы строк/лишние пробелы (в реальном ответе API их не должно
     * быть много, но береженого бог бережёт) и обрезает края.
     */
    cleanText(text) {
        return (text || '').replace(/\s+/g, ' ').trim();
    }

    isOwnDomain(domain) {
        if (!domain) return false;
        const normalized = domain.toLowerCase().replace(/^www\./, '');
        return (this.config.ownDomains || []).some(own => normalized === own || normalized.endsWith('.' + own));
    }

    normalizeUrlForMatch(url) {
        if (!url) return '';
        let u = url.split('?')[0].split('#')[0];
        u = u.replace(/^http:\/\//, 'https://');
        u = u.replace(/\/$/, '');
        return u;
    }

    async makeApiRequest(body, retries = null) {
        const maxRetries = retries || this.config.retries || 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await axios.post(API_URL, body, {
                    headers: {
                        Authorization: `Api-Key ${process.env.YANDEX_SEARCH_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: this.config.timeout || 30000
                });
                return response.data;
            } catch (error) {
                const status = error.response?.status;
                if ((status === 429 || status >= 500) && attempt < maxRetries) {
                    this.logger.warn(`Повтор запроса (попытка ${attempt}/${maxRetries})`, { status });
                    await this.delay(attempt * 5000);
                    continue;
                }
                throw error;
            }
        }
    }

    /**
     * Парсинг XML-ответа Yandex Search API в плоский список документов.
     */
    parseSerpXml(xml, request) {
        const root = this.xmlParser.parse(xml);
        const yandexsearch = this.findChild(root, 'yandexsearch');
        const response = this.findChild(yandexsearch, 'response');

        if (!response) {
            this.logger.warn(`Пустой/некорректный ответ для запроса "${request}"`);
            return [];
        }

        const errorNode = this.findChild(response, 'error');
        if (errorNode) {
            this.logger.error(`Ошибка API для запроса "${request}"`, { error: this.extractText(errorNode) });
            return [];
        }

        const results = this.findChild(response, 'results');
        const grouping = this.findChild(results, 'grouping');
        const groups = this.findChildren(grouping, 'group');
        const records = [];
        let overallPosition = 0;

        groups.forEach((group, groupIdx) => {
            const docs = this.findChildren(group, 'doc');
            docs.forEach((doc, docIdx) => {
                overallPosition += 1;

                const passagesNode = this.findChild(doc, 'passages');
                const passages = this.findChildren(passagesNode, 'passage');
                const snippet = this.cleanText(passages.map(p => this.extractText(p)).join(' … '));
                const domain = this.cleanText(this.extractText(this.findChild(doc, 'domain')));
                const url = this.cleanText(this.extractText(this.findChild(doc, 'url')));

                records.push({
                    request,
                    overall_position: overallPosition,
                    group_position: groupIdx + 1,
                    doc_position_in_group: docIdx + 1,
                    domain,
                    url,
                    title: this.cleanText(this.extractText(this.findChild(doc, 'title'))),
                    snippet,
                    is_own_domain: this.isOwnDomain(domain)
                });
            });
        });

        return records;
    }

    async fetchData(startDate) {
        const eventDate = startDate || new Date().toISOString().split('T')[0];
        const keywords = this.loadKeywords();

        this.logger.info(`Получение SERP по ${keywords.length} запросам за ${eventDate}`);

        const allRecords = [];

        for (let i = 0; i < keywords.length; i++) {
            const keyword = keywords[i];
            this.logger.info(`[${i + 1}/${keywords.length}] "${keyword}"`);

            try {
                const body = {
                    query: {
                        searchType: this.config.searchType,
                        queryText: keyword,
                        familyMode: 'FAMILY_MODE_NONE',
                        page: 0
                    },
                    groupSpec: {
                        groupMode: 'GROUP_MODE_DEEP',
                        groupsOnPage: this.config.resultsPerQuery || 20,
                        docsInGroup: 1
                    },
                    maxPassages: 1,
                    l10n: this.config.l10n || 'LOCALIZATION_RU',
                    folderId: process.env.YANDEX_SEARCH_FOLDER_ID,
                    responseFormat: 'FORMAT_XML'
                };

                const data = await this.makeApiRequest(body);
                const xml = Buffer.from(data.rawData, 'base64').toString('utf8');
                const records = this.parseSerpXml(xml, keyword).map(r => ({ ...r, event_date: eventDate }));

                allRecords.push(...records);
                this.logger.info(`  -> ${records.length} документов`);
            } catch (error) {
                this.logger.error(`Ошибка запроса "${keyword}"`, { error: error.message });
                this.stats.errors++;
            }

            if (i < keywords.length - 1) {
                await this.delay(this.config.delayBetweenRequests || 3000);
            }
        }

        return allRecords;
    }

    /**
     * Резолв target_url_id для наших доменов через common.site_map (без вставки новых строк —
     * site_map используется другими сервисами для нормализованных GSC/TopVisor-страниц).
     */
    async resolveTargetUrlIds(records) {
        const ownUrls = [...new Set(
            records.filter(r => r.is_own_domain).map(r => this.normalizeUrlForMatch(r.url))
        )];

        if (ownUrls.length === 0) return new Map();

        const result = await this.dbManager.query(
            `SELECT id, url FROM common.site_map WHERE rtrim(url, '/') = ANY($1::text[])`,
            [ownUrls]
        );

        const map = new Map();
        for (const row of result.rows) {
            map.set(row.url.replace(/\/$/, ''), row.id);
        }
        return map;
    }

    async processAndSaveData(data) {
        if (!data || data.length === 0) {
            this.logger.warn('Нет данных для сохранения');
            return;
        }

        const urlIdMap = await this.resolveTargetUrlIds(data);

        const records = data.map(r => ({
            ...r,
            target_url_id: r.is_own_domain
                ? (urlIdMap.get(this.normalizeUrlForMatch(r.url)) || null)
                : null
        }));

        await this.bulkInsertRecords(records);

        this.stats.processed = records.length;
        this.stats.inserted = records.length;
        this.logger.info(`✅ Сохранено: ${records.length} строк выдачи`);
    }

    async bulkInsertRecords(records) {
        const chunkSize = 500;
        for (let i = 0; i < records.length; i += chunkSize) {
            const chunk = records.slice(i, i + chunkSize);
            const values = [];
            const params = [];
            let idx = 1;

            for (const r of chunk) {
                values.push(
                    `($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, $${idx + 8}, $${idx + 9}, $${idx + 10}, $${idx + 11})`
                );
                params.push(
                    r.event_date, r.request, this.config.searchType,
                    r.overall_position, r.group_position, r.doc_position_in_group,
                    r.domain, r.url, r.title, r.snippet,
                    r.is_own_domain, r.target_url_id
                );
                idx += 12;
            }

            const query = `
                INSERT INTO yandex.serp_results
                (event_date, request, search_type, overall_position, group_position,
                 doc_position_in_group, domain, url, title, snippet, is_own_domain, target_url_id)
                VALUES ${values.join(',')}
                ON CONFLICT (event_date, request, search_type, url)
                DO UPDATE SET
                    overall_position = EXCLUDED.overall_position,
                    group_position = EXCLUDED.group_position,
                    doc_position_in_group = EXCLUDED.doc_position_in_group,
                    title = EXCLUDED.title,
                    snippet = EXCLUDED.snippet,
                    is_own_domain = EXCLUDED.is_own_domain,
                    target_url_id = EXCLUDED.target_url_id
            `;

            await this.dbManager.query(query, params);
        }
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = YandexSerpCollector;
