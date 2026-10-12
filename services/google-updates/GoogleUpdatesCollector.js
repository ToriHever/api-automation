// services/google-updates/GoogleUpdatesCollector.js
// Google Search Status Dashboard (incidents.json) → common.google_updates (апдейты
// алгоритмов: core/spam/Discover и т.п.) + common.notes (лента событий Telegram-бота,
// категория "Google Updates").
//
// Источник публичный, без ключа: https://status.search.google.com/incidents.json
// (то же самое отдаётся в Atom: https://status.search.google.com/en/feed.atom).
// Фильтруем по полю service_name (по умолчанию только "Ranking" — апдейты ранжирования).

const axios = require('axios');
const BaseCollector = require('../../core/BaseCollector');

const DEFAULT_FEED_URL = 'https://status.search.google.com/incidents.json';
const STATUS_BASE_URL = 'https://status.search.google.com/';

class GoogleUpdatesCollector extends BaseCollector {
    constructor() {
        super('google-updates');
        this.config = this.getConfig();
        this.feedUrl = process.env.GOOGLE_UPDATES_FEED_URL || this.config.feed_url || DEFAULT_FEED_URL;
        this.services = (process.env.GOOGLE_UPDATES_SERVICES || (this.config.services || ['Ranking']).join(','))
            .split(',')
            .map(s => s.trim().toLowerCase())
            .filter(Boolean);
        this.notesCategoryId = null; // резолвится лениво, см. resolveNotesCategoryId()
    }

    // ============================================================
    // БАЗОВЫЕ МЕТОДЫ (BaseCollector interface)
    // ============================================================

    async checkApiConnection() {
        this.logger.info(`Источник: ${this.feedUrl}, сервисы: ${this.services.join(', ')}`);
        return true;
    }

    async fetchData() {
        const response = await axios.get(this.feedUrl, { timeout: 20000 });
        const incidents = Array.isArray(response.data) ? response.data : [];
        this.logger.info(`Получено инцидентов: ${incidents.length}`);

        return incidents
            .filter(i => this.services.includes(String(i.service_name || '').toLowerCase()))
            .map(i => this.toRecord(i));
    }

    async validateRecord(record) {
        if (!record || !record.incidentId || !record.beginAt || Number.isNaN(record.beginAt.getTime())) {
            this.logger.warn(`Пропуск — нет id или даты начала: ${JSON.stringify(record).substring(0, 100)}`);
            return null;
        }
        return record;
    }

    getRecordKey(record) {
        return `update|${record.incidentId}`;
    }

    /**
     * Запись считается "уже есть" только если Google не обновлял инцидент с прошлого
     * запуска (modified совпадает) — иначе пропустим завершение раскатки (end появляется
     * позже, чем begin) и новые статусы.
     */
    async recordExists(record) {
        const result = await this.dbManager.query(
            `SELECT modified_at FROM common.google_updates WHERE incident_id = $1`,
            [record.incidentId]
        );
        if (result.rows.length === 0) return false;
        const stored = result.rows[0].modified_at;
        return !!stored && new Date(stored).getTime() === record.modifiedAt.getTime();
    }

    async insertRecord(record) {
        const prev = await this.dbManager.query(
            `SELECT end_at FROM common.google_updates WHERE incident_id = $1`,
            [record.incidentId]
        );

        await this.upsert(record);

        if (prev.rows.length === 0) {
            await this.insertNote(record, 'start');
        } else if (!prev.rows[0].end_at && record.endAt) {
            await this.insertNote(record, 'end');
        }
    }

    async updateRecord(record) {
        // --force: перезаписываем поля, но заметки в ленту не дублируем.
        await this.upsert(record);
    }

    // ============================================================
    // ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ
    // ============================================================

    toRecord(incident) {
        const last = incident.most_recent_update || (incident.updates || [])[0] || {};
        const title = (incident.external_desc || '').trim();
        return {
            incidentId: incident.id,
            title,
            updateType: this.classify(title),
            serviceName: incident.service_name || null,
            severity: incident.severity || null,
            statusImpact: incident.status_impact || null,
            beginAt: new Date(incident.begin),
            endAt: incident.end ? new Date(incident.end) : null,
            modifiedAt: new Date(incident.modified || incident.begin),
            description: this.cleanText(last.text || ''),
            url: incident.uri ? STATUS_BASE_URL + incident.uri : STATUS_BASE_URL
        };
    }

    classify(title) {
        const t = title.toLowerCase();
        if (t.includes('core update')) return 'core';
        if (t.includes('spam update')) return 'spam';
        if (t.includes('discover')) return 'discover';
        if (t.includes('helpful content')) return 'helpful_content';
        if (t.includes('reviews update')) return 'reviews';
        return 'other';
    }

    async upsert(record) {
        await this.dbManager.query(
            `INSERT INTO common.google_updates
                (incident_id, title, update_type, service_name, severity, status_impact,
                 begin_at, end_at, begin_date, end_date, modified_at, description, url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             ON CONFLICT (incident_id) DO UPDATE SET
                title = EXCLUDED.title,
                update_type = EXCLUDED.update_type,
                service_name = EXCLUDED.service_name,
                severity = EXCLUDED.severity,
                status_impact = EXCLUDED.status_impact,
                begin_at = EXCLUDED.begin_at,
                end_at = EXCLUDED.end_at,
                begin_date = EXCLUDED.begin_date,
                end_date = EXCLUDED.end_date,
                modified_at = EXCLUDED.modified_at,
                description = EXCLUDED.description,
                url = EXCLUDED.url,
                updated_at = now()`,
            [record.incidentId, record.title, record.updateType, record.serviceName,
                record.severity, record.statusImpact, record.beginAt, record.endAt,
                this.toLocalDate(record.beginAt), record.endAt ? this.toLocalDate(record.endAt) : null,
                record.modifiedAt, record.description, record.url]
        );
    }

    /**
     * Пишет событие в ленту Telegram-бота (common.notes), категория "Google Updates".
     * Два события на апдейт: начало раскатки (дата начала) и её завершение (дата конца).
     * Не роняет insertRecord: строка в common.google_updates уже сохранена.
     */
    async insertNote(record, kind) {
        try {
            const categoryId = await this.resolveNotesCategoryId();
            const isStart = kind === 'start';
            const date = this.toLocalDate(isStart ? record.beginAt : record.endAt);
            // Разделитель — тире, не квадратные скобки (в DataLens они зарезервированы под поля).
            const title = `Google — ${record.title}: ${isStart ? 'начало раскатки' : 'раскатка завершена'}`;
            const description = [record.description, record.url].filter(Boolean).join('\n\n');

            await this.dbManager.query(
                `INSERT INTO common.notes (title, description, event_date, category_id, created_by)
                 VALUES ($1, $2, $3, $4, $5)`,
                [title, description, date, categoryId, 'google-updates-collector']
            );
        } catch (error) {
            this.logger.error(`Не удалось записать в common.notes: "${record.title}"`, { error: error.message });
        }
    }

    async resolveNotesCategoryId() {
        if (this.notesCategoryId) return this.notesCategoryId;

        const result = await this.dbManager.query(
            `SELECT category_id FROM common.notes_categories WHERE category_name = 'Google Updates'`
        );

        if (result.rows.length === 0) {
            throw new Error('Категория "Google Updates" не найдена в common.notes_categories — проверь, что services/notes/schema.sql и schema.sql этого сервиса применены');
        }

        this.notesCategoryId = result.rows[0].category_id;
        return this.notesCategoryId;
    }

    cleanText(s = '') {
        return s.replace(/<(https?:[^>\s]+)>/g, '$1').replace(/\s+/g, ' ').trim();
    }

    /** Дата в формате YYYY-MM-DD по таймзоне из config.json (по умолчанию Europe/Moscow) */
    toLocalDate(date) {
        const tz = this.config.timezone || 'Europe/Moscow';
        return new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(date);
    }
}

module.exports = GoogleUpdatesCollector;
