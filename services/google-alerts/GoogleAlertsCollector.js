// services/google-alerts/GoogleAlertsCollector.js
// Google Alerts (RSS) → common.google_alerts (сырые упоминания) +
// common.notes (лента событий Telegram-бота, категория "Google Alerts").
//
// Настройка алертов — на стороне Google (https://www.google.com/alerts):
// для каждого алерта включи доставку "RSS-канал" и возьми оттуда URL фида.
// Публичный, авторизация не нужна.

const BaseCollector = require('../../core/BaseCollector');
const Parser = require('rss-parser');

class GoogleAlertsCollector extends BaseCollector {
    constructor() {
        super('google-alerts');
        this.config = this.getConfig();
        this.parser = new Parser({ timeout: 20000 });
        this.notesCategoryId = null; // резолвится лениво, см. resolveNotesCategoryId()

        this.feeds = (process.env.GOOGLE_ALERTS_FEEDS || '')
            .split(';')
            .map(s => s.trim())
            .filter(Boolean)
            .map(s => {
                const [name, url] = s.split('|').map(x => x.trim());
                return { name, url };
            });

        if (this.feeds.length === 0) {
            throw new Error('GOOGLE_ALERTS_FEEDS не задан (формат: "Имя|url;Имя2|url2")');
        }

        this.stopwords = (process.env.GOOGLE_ALERTS_STOPWORDS || '')
            .split(',')
            .map(s => s.trim().toLowerCase())
            .filter(Boolean);
    }

    // ============================================================
    // БАЗОВЫЕ МЕТОДЫ (BaseCollector interface)
    // ============================================================

    async checkApiConnection() {
        this.logger.info('Проверка конфигурации Google Alerts');
        // RSS-фиды публичные и бесплатные — реальный тестовый запрос не нужен,
        // fetchData всё равно дёрнет все фиды по-настоящему.
        this.logger.info(`Настроено фидов: ${this.feeds.length}`);
        return true;
    }

    async fetchData() {
        const allRecords = [];

        for (const feed of this.feeds) {
            try {
                this.logger.info(`Читаю фид "${feed.name}"`);
                const data = await this.parser.parseURL(feed.url);

                for (const item of data.items) {
                    const url = this.resolveUrl(item.link);
                    const domain = this.getDomain(url);
                    const publishedAt = new Date(item.isoDate || item.pubDate || Date.now());

                    allRecords.push({
                        _type: 'alert',
                        entryId: item.id || item.guid || url,
                        alertName: feed.name,
                        publishedAt,
                        eventDate: this.toLocalDate(publishedAt),
                        domain,
                        url,
                        title: this.stripHtml(item.title || ''),
                        snippet: this.stripHtml(item.content || item.contentSnippet || '')
                    });
                }

                this.logger.info(`  -> ${data.items.length} элементов`);
            } catch (error) {
                this.logger.error(`Ошибка чтения фида "${feed.name}"`, { error: error.message });
                this.stats.errors++;
            }
        }

        return allRecords;
    }

    async validateRecord(record) {
        if (!record || typeof record !== 'object') return null;

        if (!record.domain) {
            this.logger.warn(`Пропуск — не удалось распознать домен: "${record.url}"`);
            return null;
        }

        if (this.isStopped(`${record.title} ${record.snippet}`)) {
            this.logger.debug(`Пропуск по стоп-слову: "${record.title}"`);
            return null;
        }

        return record;
    }

    getRecordKey(record) {
        return `alert|${record.entryId}`;
    }

    /**
     * Дедуп по entry_id ИЛИ url — так же, как в UNIQUE-констрейнтах таблицы
     * (см. schema.sql). Проверка по обоим полям не даёт словить нарушение
     * UNIQUE(url), если одна и та же статья попала под два разных алерта
     * с разными entry_id — она просто будет считаться уже существующей.
     */
    async recordExists(record) {
        const result = await this.dbManager.query(
            `SELECT 1 FROM common.google_alerts WHERE entry_id = $1 OR url = $2`,
            [record.entryId, record.url]
        );
        return result.rows.length > 0;
    }

    async insertRecord(record) {
        await this.dbManager.query(
            `INSERT INTO common.google_alerts
                (entry_id, alert_name, published_at, event_date, domain, url, title, snippet)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT DO NOTHING`,
            [record.entryId, record.alertName, record.publishedAt, record.eventDate,
                record.domain, record.url, record.title, record.snippet]
        );

        await this.insertNote(record);
    }

    async updateRecord(record) {
        // Упоминания неизменны после первой фиксации (URL/дата/домен не
        // меняются) — updateRecord вызывается только с --force, обновляем
        // на случай, если title/snippet в фиде уточнились задним числом.
        await this.dbManager.query(
            `UPDATE common.google_alerts
             SET title = $2, snippet = $3
             WHERE entry_id = $1 OR url = $4`,
            [record.entryId, record.title, record.snippet, record.url]
        );
    }

    // ============================================================
    // ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ
    // ============================================================

    /**
     * Пишет то же упоминание в ленту событий Telegram-бота (common.notes),
     * категория "Google Alerts" (см. schema.sql). Не роняет весь insertRecord,
     * если по какой-то причине не получилось — упоминание в
     * common.google_alerts уже сохранено к этому моменту отдельным запросом
     * (не в общей транзакции), так что сырые данные не теряются даже если
     * запись в notes не удалась.
     */
    async insertNote(record) {
        try {
            const categoryId = await this.resolveNotesCategoryId();
            // alertName всегда виден в заголовке — раньше он проявлялся только
            // когда у RSS-элемента не было своего title (то есть почти никогда).
            const title = `[${record.alertName}] ${record.title || record.domain}`;
            const description = record.snippet
                ? `${record.snippet}\n\n${record.url}`
                : record.url;

            await this.dbManager.query(
                `INSERT INTO common.notes (title, description, event_date, category_id, created_by)
                 VALUES ($1, $2, $3, $4, $5)`,
                [title, description, record.eventDate, categoryId, 'google-alerts-collector']
            );
        } catch (error) {
            this.logger.error(`Не удалось записать в common.notes: "${record.title}"`, { error: error.message });
        }
    }

    async resolveNotesCategoryId() {
        if (this.notesCategoryId) return this.notesCategoryId;

        const result = await this.dbManager.query(
            `SELECT category_id FROM common.notes_categories WHERE category_name = 'Google Alerts'`
        );

        if (result.rows.length === 0) {
            throw new Error('Категория "Google Alerts" не найдена в common.notes_categories — проверь, что schema.sql применён');
        }

        this.notesCategoryId = result.rows[0].category_id;
        return this.notesCategoryId;
    }

    stripHtml(s = '') {
        return s
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /** Извлекает реальный URL из редиректа google.com/url?...&url=... */
    resolveUrl(link) {
        try {
            const u = new URL(link);
            if (u.hostname.endsWith('google.com') && u.pathname === '/url') {
                return u.searchParams.get('url') || u.searchParams.get('q') || link;
            }
            return link;
        } catch {
            return link;
        }
    }

    getDomain(url) {
        try {
            return new URL(url).hostname.replace(/^www\./, '');
        } catch {
            return '';
        }
    }

    /** Дата в формате YYYY-MM-DD по таймзоне из config.json (по умолчанию Europe/Moscow) */
    toLocalDate(date) {
        const tz = this.config.timezone || 'Europe/Moscow';
        return new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(date);
    }

    isStopped(text) {
        const t = text.toLowerCase();
        return this.stopwords.some(w => t.includes(w));
    }
}

module.exports = GoogleAlertsCollector;
