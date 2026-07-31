// services/checkhost/CheckHostCollector.js
const BaseCollector = require('../../core/BaseCollector');
const axios = require('axios');

class CheckHostCollector extends BaseCollector {
    constructor() {
        super('checkhost');
        this.config = this.getConfig();
        this.siteTypeFilter = process.env.CHECKHOST_SITE_TYPE || this.config.siteTypeFilter;
    }

    async checkApiConnection() {
        await axios.get(`${this.config.checkHostBaseUrl}/nodes/hosts`, {
            headers: { Accept: 'application/json' },
            timeout: this.config.requestTimeout
        });

        const geoResp = await axios.get(`${this.config.geoIpApiUrl}/8.8.8.8`, {
            params: { fields: this.config.geoIpFields },
            timeout: this.config.requestTimeout
        });
        if (!geoResp.data || geoResp.data.status !== 'success') {
            throw new Error('ip-api.com недоступен или вернул ошибку');
        }

        this.logger.info('Check-Host и ip-api.com доступны');
        return true;
    }

    /**
     * Список доменов для обработки — из l7.clients, за вычетом мусора
     * (запрещённые, IP-адреса, домены с цифрами), отфильтрованных по категории
     * site_type (проставляется коллектором domains-meta по последней доступной
     * классификации — не обязательно за сегодня). checkhost не завязан на
     * расписание/статус domains-meta и не пропускает домены по дате: каждый
     * прогон обрабатывает весь список и перезаписывает (upsert) свою строку
     * по домену — см. upsertRecord.
     *
     * Один clean_domain может встречаться у нескольких клиентов (client_id),
     * поэтому берём DISTINCT по домену — иначе один и тот же домен
     * обрабатывался бы несколько раз (в l7.checkhost_scan он всё равно один,
     * т.к. там уникальность по domain, но лишние прогоны check-host/ip-api
     * тратятся впустую).
     */
    async fetchData() {
        const result = await this.dbManager.query(
            `SELECT DISTINCT c.clean_domain AS domain
             FROM l7.clients c
             WHERE c.is_forbidden = false
               AND c.has_digits = false
               AND c.is_ip = false
               AND c.clean_domain IS NOT NULL
               AND EXISTS (
                   SELECT 1 FROM l7.domains_meta_scan m
                   WHERE m.domain = c.clean_domain AND m.site_type = $1
               )`,
            [this.siteTypeFilter]
        );

        this.logger.info(`К обработке: ${result.rows.length} доменов (категория: ${this.siteTypeFilter})`);
        return result.rows;
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async submitDnsCheck(domain) {
        const resp = await axios.get(`${this.config.checkHostBaseUrl}/check-dns`, {
            params: { host: domain, max_nodes: this.config.maxNodes },
            headers: { Accept: 'application/json' },
            timeout: this.config.requestTimeout
        });

        if (!resp.data || resp.data.ok !== 1 || !resp.data.request_id) {
            throw new Error('Check-Host отклонил запрос check-dns');
        }
        return resp.data.request_id;
    }

    isResultComplete(resultData) {
        return Object.values(resultData || {}).every(v => v !== null);
    }

    /**
     * Проверка результата — асинхронная на стороне Check-Host: пока не все
     * ноды закончили резолв, соответствующие значения приходят как null.
     * Опрашиваем с интервалом, пока не соберём ответы со всех нод либо не
     * исчерпаем попытки (тогда используем то, что успело прийти).
     */
    async pollDnsResult(requestId) {
        let lastData = null;
        for (let attempt = 0; attempt < this.config.dnsPollMaxAttempts; attempt++) {
            await this.delay(this.config.dnsPollIntervalMs);

            const resp = await axios.get(`${this.config.checkHostBaseUrl}/check-result/${requestId}`, {
                headers: { Accept: 'application/json' },
                timeout: this.config.requestTimeout
            });
            lastData = resp.data;

            if (lastData && this.isResultComplete(lastData)) {
                return lastData;
            }
        }
        return lastData;
    }

    extractIps(resultData) {
        const counts = new Map();
        for (const nodeResult of Object.values(resultData || {})) {
            if (!Array.isArray(nodeResult) || !nodeResult[0]) continue;
            const entry = nodeResult[0];
            const ips = [...(entry.A || []), ...(entry.AAAA || [])];
            for (const ip of ips) {
                counts.set(ip, (counts.get(ip) || 0) + 1);
            }
        }
        return [...counts.entries()]
            .map(([ip, count]) => ({ ip, count }))
            .sort((a, b) => b.count - a.count);
    }

    parseAsField(asField) {
        if (!asField) return { asNumber: null, asName: null };
        const match = asField.match(/^(AS\d+)\s*(.*)$/i);
        if (!match) return { asNumber: null, asName: asField };
        return { asNumber: match[1].toUpperCase(), asName: match[2] || null };
    }

    async geoIpLookup(ip) {
        const resp = await axios.get(`${this.config.geoIpApiUrl}/${ip}`, {
            params: { fields: this.config.geoIpFields },
            timeout: this.config.requestTimeout
        });
        return resp.data;
    }

    /**
     * IP резолвится через Check-Host (check-dns). Ноды Check-Host сами по
     * себе не ограничивают частоту запросов, поэтому этот шаг вызывается
     * параллельно пачками (см. processAndSaveData) — в отличие от geoip-
     * обогащения, которое упирается в реальный rate limit ip-api.com.
     */
    async resolveDns(client) {
        const record = {
            domain: client.domain, request_id: null,
            resolved_ips: JSON.stringify([]), ip: null, country: null, region: null, city: null,
            isp: null, org: null, as_number: null, as_name: null,
            dns_success: false, geoip_success: false, error_message: null
        };

        try {
            const requestId = await this.submitDnsCheck(client.domain);
            record.request_id = requestId;

            const resultData = await this.pollDnsResult(requestId);
            const resolvedIps = this.extractIps(resultData);
            record.resolved_ips = JSON.stringify(resolvedIps);

            if (resolvedIps.length === 0) {
                record.error_message = 'Check-Host не резолвил ни одного IP';
                return record;
            }

            record.dns_success = true;
            record.ip = resolvedIps[0].ip;
        } catch (error) {
            record.error_message = error.message;
        }

        return record;
    }

    /**
     * Location/AS/ISP-Org — отдельным запросом к ip-api.com по каноничному
     * IP (Check-Host отдаёт геоданные только своих проверяющих нод, не
     * целевого хоста). Вызывается строго последовательно с паузой перед
     * каждым запросом — свободный тариф ip-api.com ограничен 45 запросами
     * в минуту, распараллелить этот шаг нельзя.
     */
    async enrichGeoIp(record) {
        try {
            const geo = await this.geoIpLookup(record.ip);
            if (geo && geo.status === 'success') {
                record.geoip_success = true;
                record.country = geo.country || null;
                record.region = geo.regionName || null;
                record.city = geo.city || null;
                record.isp = geo.isp || null;
                record.org = geo.org || null;

                const { asNumber, asName } = this.parseAsField(geo.as);
                record.as_number = asNumber;
                record.as_name = asName;
            } else {
                record.error_message = `ip-api.com: ${geo?.message || 'неуспешный ответ'}`;
            }
        } catch (error) {
            record.error_message = error.message;
        }

        return record;
    }

    chunkArray(arr, size) {
        const chunks = [];
        for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
        return chunks;
    }

    /**
     * Домены резолвятся пачками параллельно (dnsParallelLimit) — это и есть
     * узкое место, которое раньше делалось строго по одному. GeoIP-запросы
     * внутри пачки идут последовательно с паузой geoIpDelayMs — этот шаг
     * принципиально нельзя ускорить параллелизмом, не упершись в лимит
     * ip-api.com. Пишем в БД сразу после каждого домена (upsertRecord), а не
     * копим всё до конца прогона — если скрипт упадёт на середине списка,
     * уже собранные данные не потеряются.
     */
    async processAndSaveData(clients) {
        if (!clients || clients.length === 0) {
            this.logger.warn('Нет доменов для обработки');
            return;
        }

        const batches = this.chunkArray(clients, this.config.dnsParallelLimit);

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            const dnsRecords = await Promise.all(batch.map(client => this.resolveDns(client)));

            for (const record of dnsRecords) {
                if (record.dns_success) {
                    // ip-api.com free tier: до 45 запросов в минуту
                    await this.delay(this.config.geoIpDelayMs);
                    await this.enrichGeoIp(record);
                }

                await this.upsertRecord(record);

                this.stats.processed++;
                this.stats.inserted++;
                if (!record.dns_success || !record.geoip_success) {
                    this.stats.warnings.push(`${record.domain}: ${record.error_message}`);
                }
            }

            this.logger.info(`Обработано ${this.stats.processed}/${clients.length} доменов`);

            if (i < batches.length - 1) {
                await this.delay(this.config.delayBetweenBatches);
            }
        }

        this.logger.info(`✅ Записано: ${this.stats.inserted} строк`);
    }

    async upsertRecord(record) {
        const columns = [
            'domain', 'request_id', 'resolved_ips', 'ip', 'country', 'region', 'city',
            'isp', 'org', 'as_number', 'as_name', 'dns_success', 'geoip_success', 'error_message'
        ];
        const values = columns.map(col => record[col]);
        const placeholders = values.map((_, idx) => `$${idx + 1}`);
        const updateSet = columns
            .filter(col => col !== 'domain')
            .map(col => `${col} = EXCLUDED.${col}`)
            .concat('checked_at = CURRENT_TIMESTAMP')
            .join(', ');

        await this.dbManager.query(
            `INSERT INTO l7.checkhost_scan (${columns.join(', ')}) VALUES (${placeholders.join(', ')})
             ON CONFLICT (domain) DO UPDATE SET ${updateSet}`,
            values
        );
    }
}

module.exports = CheckHostCollector;
