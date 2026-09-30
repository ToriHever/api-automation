// scripts/traffic-history-36m.js
// Выгрузка трафика за N месяцев (по умолчанию 36) из GA4 и Яндекс.Метрики
// отдельно для ru (ddos-guard.ru) и en (ddos-guard.net). Строго эти хосты, без поддоменов:
//   GA4:      hostName == домен (EXACT)
//   Метрика:  ym:s:startURLDomain == домен (точное совпадение)
// Гранулярность: день × канал трафика. Результат — таблица reports.traffic_daily (схема
// services/reports/schema.sql создаётся автоматически, повторный запуск = upsert).
//
// .env:
//   GA4_PROPERTY_ID            — если ru и en в одном property (фильтр по hostName разведёт их)
//   GA4_PROPERTY_ID_RU / _EN   — если property разные (имеют приоритет)
//   YANDEX_METRIKA_TOKEN       — OAuth-токен со scope metrika:read (токен Wordstat не подойдёт)
//   YANDEX_METRIKA_COUNTER_ID  — один счётчик на оба сайта (фильтр по домену разведёт их)
//   YANDEX_METRIKA_COUNTER_ID_RU / _EN — если счётчики разные (имеют приоритет)
//
// Запуск:
//   node scripts/traffic-history-36m.js                     # всё, 36 месяцев
//   node scripts/traffic-history-36m.js --source ga4 --site ru
//   node scripts/traffic-history-36m.js --months 12

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const GoogleAuthManager = require('../core/GoogleAuthManager');
const DatabaseManager = require('../core/DatabaseManager');

const SITES = {
    ru: { host: 'ddos-guard.ru' },
    en: { host: 'ddos-guard.net' }
};

const GA4_URL = 'https://analyticsdata.googleapis.com/v1beta/properties';
const METRIKA_URL = 'https://api-metrica.yandex.net/stat/v1/data';
const SCHEMA_FILE = path.join(__dirname, '..', 'services', 'reports', 'schema.sql');

function arg(name, def) {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : def;
}

// Локальные компоненты даты: toISOString() в поясе UTC+3 сдвигает полночь на предыдущий день
const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Период: с 1-го числа месяца N месяцев назад по вчера
function getRange(months) {
    const end = new Date();
    end.setDate(end.getDate() - 1);
    const start = new Date(end.getFullYear(), end.getMonth() - months + 1, 1);
    return { start: fmt(start), end: fmt(end) };
}

// Разбивка периода на куски по полгода — чтобы не упереться в лимиты строк/сэмплирование
function chunkRange(startStr, endStr, monthsPerChunk = 6) {
    const chunks = [];
    let cur = new Date(startStr + 'T00:00:00');
    const end = new Date(endStr + 'T00:00:00');
    while (cur <= end) {
        const next = new Date(cur.getFullYear(), cur.getMonth() + monthsPerChunk, 1);
        const chunkEnd = new Date(Math.min(next.getTime() - 86400000, end.getTime()));
        chunks.push({ start: fmt(cur), end: fmt(chunkEnd) });
        cur = next;
    }
    return chunks;
}

async function withRetry(fn, label, retries = 4) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (e) {
            const status = e.response && e.response.status;
            const retriable = !status || status === 429 || status >= 500;
            if (!retriable || attempt >= retries) {
                if (e.response) console.error(`[${label}] HTTP ${status}:`, JSON.stringify(e.response.data));
                throw e;
            }
            const wait = 2000 * attempt;
            console.warn(`[${label}] ${status || e.code}, повтор ${attempt}/${retries - 1} через ${wait}мс`);
            await sleep(wait);
        }
    }
}

// ---------------- GA4 ----------------
async function fetchGA4(auth, siteKey, range) {
    const propertyId = process.env[`GA4_PROPERTY_ID_${siteKey.toUpperCase()}`] || process.env.GA4_PROPERTY_ID;
    if (!propertyId) throw new Error('Не задан GA4_PROPERTY_ID (или GA4_PROPERTY_ID_RU/_EN)');
    const host = SITES[siteKey].host;
    const rows = [];

    for (const ch of chunkRange(range.start, range.end)) {
        let offset = 0;
        while (true) {
            const body = {
                dateRanges: [{ startDate: ch.start, endDate: ch.end }],
                dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
                metrics: [
                    { name: 'sessions' },
                    { name: 'engagedSessions' },
                    { name: 'totalUsers' },
                    { name: 'newUsers' },
                    { name: 'screenPageViews' }
                ],
                dimensionFilter: {
                    filter: { fieldName: 'hostName', stringFilter: { matchType: 'EXACT', value: host } }
                },
                orderBys: [{ dimension: { dimensionName: 'date' } }],
                limit: 100000,
                offset
            };
            const data = await withRetry(async () => {
                const headers = await auth.getAuthHeaders();
                return (await axios.post(`${GA4_URL}/${propertyId}:runReport`, body, { headers, timeout: 60000 })).data;
            }, `ga4 ${siteKey} ${ch.start}`);

            const r = data.rows || [];
            for (const row of r) {
                const d = row.dimensionValues[0].value;
                const m = row.metricValues.map(v => Number(v.value));
                rows.push({
                    event_date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
                    channel: row.dimensionValues[1].value,
                    sessions: m[0], engaged_sessions: m[1], users: m[2], new_users: m[3], pageviews: m[4]
                });
            }
            console.log(`  GA4 ${siteKey} ${ch.start}..${ch.end}: +${r.length} (offset ${offset})`);
            if (r.length < 100000) break;
            offset += 100000;
        }
    }
    return rows;
}

// ---------------- Метрика ----------------
async function fetchMetrika(siteKey, range) {
    const counterId = process.env[`YANDEX_METRIKA_COUNTER_ID_${siteKey.toUpperCase()}`] || process.env.YANDEX_METRIKA_COUNTER_ID;
    const token = process.env.YANDEX_METRIKA_TOKEN;
    if (!counterId) throw new Error('Не задан YANDEX_METRIKA_COUNTER_ID (или YANDEX_METRIKA_COUNTER_ID_RU/_EN)');
    if (!token) throw new Error('Не задан YANDEX_METRIKA_TOKEN');
    const host = SITES[siteKey].host;
    const rows = [];

    for (const ch of chunkRange(range.start, range.end)) {
        let offset = 1; // в Метрике offset с 1
        while (true) {
            const params = {
                ids: counterId,
                date1: ch.start,
                date2: ch.end,
                dimensions: 'ym:s:date,ym:s:lastTrafficSource',
                metrics: 'ym:s:visits,ym:s:users,ym:s:newUsers,ym:s:pageviews',
                filters: `ym:s:startURLDomain=='${host}'`,
                accuracy: 'full',
                lang: 'ru',
                limit: 100000,
                offset
            };
            const data = await withRetry(async () =>
                (await axios.get(METRIKA_URL, {
                    params,
                    headers: { Authorization: `OAuth ${token}` },
                    timeout: 60000
                })).data, `metrika ${siteKey} ${ch.start}`);

            const r = data.data || [];
            for (const row of r) {
                // при sampled=true Метрика отдаёт оценки с дробной частью — колонки целочисленные
                const m = row.metrics.map(Math.round);
                rows.push({
                    event_date: row.dimensions[0].name,
                    channel: row.dimensions[1].name,
                    sessions: m[0], engaged_sessions: null, users: m[1], new_users: m[2], pageviews: m[3]
                });
            }
            console.log(`  Metrika ${siteKey} ${ch.start}..${ch.end}: +${r.length} (offset ${offset}), sampled=${data.sampled}`);
            if (r.length < 100000) break;
            offset += 100000;
        }
    }
    return rows;
}

async function saveRows(db, source, site, rows) {
    // GA4/Метрика могут вернуть одинаковый (дата, канал) дважды — суммируем
    const merged = new Map();
    for (const r of rows) {
        const key = `${r.event_date}|${r.channel}`;
        const e = merged.get(key);
        if (!e) { merged.set(key, { ...r }); continue; }
        for (const f of ['sessions', 'users', 'new_users', 'pageviews']) e[f] += r[f];
        if (r.engaged_sessions !== null) e.engaged_sessions = (e.engaged_sessions || 0) + r.engaged_sessions;
    }
    const list = [...merged.values()];
    const BATCH = 500;
    for (let i = 0; i < list.length; i += BATCH) {
        const part = list.slice(i, i + BATCH);
        const params = [];
        const values = part.map((r, j) => {
            params.push(source, site, SITES[site].host, r.event_date, r.channel,
                r.sessions, r.engaged_sessions, r.users, r.new_users, r.pageviews);
            const o = j * 10;
            return `(${Array.from({ length: 10 }, (_, k) => `$${o + k + 1}`).join(',')})`;
        });
        await db.query(
            `INSERT INTO reports.traffic_daily
             (source, site, host, event_date, channel, sessions, engaged_sessions, users, new_users, pageviews)
             VALUES ${values.join(',')}
             ON CONFLICT (source, site, event_date, channel) DO UPDATE SET
               host = EXCLUDED.host, sessions = EXCLUDED.sessions, engaged_sessions = EXCLUDED.engaged_sessions,
               users = EXCLUDED.users, new_users = EXCLUDED.new_users, pageviews = EXCLUDED.pageviews,
               updated_at = CURRENT_TIMESTAMP`,
            params
        );
    }
    console.log(`→ reports.traffic_daily: ${list.length} строк (${source}/${site})`);
}

async function main() {
    const months = Number(arg('months', 36));
    const sourceArg = arg('source', 'all');
    const siteArg = arg('site', 'all');
    const range = getRange(months);
    const sources = sourceArg === 'all' ? ['ga4', 'metrika'] : [sourceArg];
    const sites = siteArg === 'all' ? Object.keys(SITES) : [siteArg];

    console.log(`Период: ${range.start} .. ${range.end}; источники: ${sources}; сайты: ${sites.map(s => SITES[s].host)}`);

    const auth = sources.includes('ga4') ? new GoogleAuthManager() : null;
    let failed = 0;

    const db = new DatabaseManager('traffic-history');
    await db.connect();
    await db.query(fs.readFileSync(SCHEMA_FILE, 'utf8'));

    for (const site of sites) {
        for (const source of sources) {
            console.log(`\n=== ${source} / ${site} (${SITES[site].host}) ===`);
            try {
                const result = source === 'ga4'
                    ? await fetchGA4(auth, site, range)
                    : await fetchMetrika(site, range);
                await saveRows(db, source, site, result);
            } catch (e) {
                failed++;
                console.error(`✗ ${source}/${site}: ${e.message}`);
            }
        }
    }
    await db.disconnect();
    if (failed) process.exitCode = 1;
}

main();
