// scripts/traffic-organic-engines.js
// Органический трафик по поисковым системам (Яндекс / Google / прочие), по дням, отдельно для
// ru (ddos-guard.ru) и en (ddos-guard.net), без поддоменов. Нужен, чтобы понять, откуда идёт
// падение/рост органики и считать сезонные индексы по каждой поисковой системе отдельно.
//   GA4:      канал Organic Search, hostName == домен (EXACT), группировка sessionSource
//   Метрика:  lastTrafficSource == 'organic', startURLDomain == домен, группировка lastSearchEngineRoot
// Результат: reports.traffic_organic_engine (схема — services/reports/organic_engine_schema.sql,
// создаётся автоматически; повторный запуск = upsert).
// Настройки .env — те же, что у scripts/traffic-history-36m.js.
//
// Запуск:
//   node scripts/traffic-organic-engines.js
//   node scripts/traffic-organic-engines.js --source ga4 --site ru --months 24

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const GoogleAuthManager = require('../core/GoogleAuthManager');
const DatabaseManager = require('../core/DatabaseManager');
const { SITES, GA4_URL, METRIKA_URL, arg, getRange, chunkRange, withRetry } = require('./traffic-history-36m');

const SCHEMA_FILES = ['schema.sql', 'organic_engine_schema.sql']
    .map(f => path.join(__dirname, '..', 'services', 'reports', f));

// Сводит название источника из GA4/Метрики к Yandex / Google / Other
function normalizeEngine(raw) {
    const s = String(raw || '').toLowerCase();
    if (s.includes('yandex') || s.includes('яндекс') || s === 'ya.ru' || s.startsWith('ya.')) return 'Yandex';
    if (s.includes('google')) return 'Google';
    return 'Other';
}

async function fetchGA4(auth, siteKey, range, rawSeen) {
    const propertyId = process.env[`GA4_PROPERTY_ID_${siteKey.toUpperCase()}`] || process.env.GA4_PROPERTY_ID;
    if (!propertyId) throw new Error('Не задан GA4_PROPERTY_ID (или GA4_PROPERTY_ID_RU/_EN)');
    const host = SITES[siteKey].host;
    const rows = [];

    for (const ch of chunkRange(range.start, range.end)) {
        let offset = 0;
        while (true) {
            const body = {
                dateRanges: [{ startDate: ch.start, endDate: ch.end }],
                dimensions: [{ name: 'date' }, { name: 'sessionSource' }],
                metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'newUsers' }, { name: 'screenPageViews' }],
                dimensionFilter: {
                    andGroup: {
                        expressions: [
                            { filter: { fieldName: 'hostName', stringFilter: { matchType: 'EXACT', value: host } } },
                            { filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { matchType: 'EXACT', value: 'Organic Search' } } }
                        ]
                    }
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
                const raw = row.dimensionValues[1].value;
                const m = row.metricValues.map(x => Number(x.value));
                rawSeen.set(`${normalizeEngine(raw)} ← ${raw}`, (rawSeen.get(`${normalizeEngine(raw)} ← ${raw}`) || 0) + m[0]);
                rows.push({ event_date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, engine: normalizeEngine(raw),
                    sessions: m[0], users: m[1], new_users: m[2], pageviews: m[3] });
            }
            console.log(`  GA4 ${siteKey} ${ch.start}..${ch.end}: +${r.length} (offset ${offset})`);
            if (r.length < 100000) break;
            offset += 100000;
        }
    }
    return rows;
}

async function fetchMetrika(siteKey, range, rawSeen) {
    const counterId = process.env[`YANDEX_METRIKA_COUNTER_ID_${siteKey.toUpperCase()}`] || process.env.YANDEX_METRIKA_COUNTER_ID;
    const token = process.env.YANDEX_METRIKA_TOKEN;
    if (!counterId) throw new Error('Не задан YANDEX_METRIKA_COUNTER_ID (или YANDEX_METRIKA_COUNTER_ID_RU/_EN)');
    if (!token) throw new Error('Не задан YANDEX_METRIKA_TOKEN');
    const host = SITES[siteKey].host;
    const rows = [];

    for (const ch of chunkRange(range.start, range.end)) {
        let offset = 1;
        while (true) {
            const params = {
                ids: counterId, date1: ch.start, date2: ch.end,
                dimensions: 'ym:s:date,ym:s:lastSearchEngineRoot',
                metrics: 'ym:s:visits,ym:s:users,ym:s:newUsers,ym:s:pageviews',
                filters: `ym:s:lastTrafficSource=='organic' AND ym:s:startURLDomain=='${host}'`,
                accuracy: 'full', lang: 'ru', limit: 100000, offset
            };
            const data = await withRetry(async () =>
                (await axios.get(METRIKA_URL, { params, headers: { Authorization: `OAuth ${token}` }, timeout: 60000 })).data,
                `metrika ${siteKey} ${ch.start}`);

            const r = data.data || [];
            for (const row of r) {
                const dim = row.dimensions[1];
                const raw = dim.id || dim.name || '(not set)';
                const m = row.metrics.map(Math.round);   // при sampled=true — оценки с дробной частью
                const engine = normalizeEngine(dim.id) !== 'Other' ? normalizeEngine(dim.id) : normalizeEngine(dim.name);
                rawSeen.set(`${engine} ← ${raw}`, (rawSeen.get(`${engine} ← ${raw}`) || 0) + m[0]);
                rows.push({ event_date: row.dimensions[0].name, engine, sessions: m[0], users: m[1], new_users: m[2], pageviews: m[3] });
            }
            console.log(`  Metrika ${siteKey} ${ch.start}..${ch.end}: +${r.length} (offset ${offset}), sampled=${data.sampled}`);
            if (r.length < 100000) break;
            offset += 100000;
        }
    }
    return rows;
}

// Несколько сырых источников могут свестись в один engine за один день (например ya.ru + yandex) — суммируем
function mergeRows(rows) {
    const merged = new Map();
    for (const r of rows) {
        const key = `${r.event_date}|${r.engine}`;
        const e = merged.get(key);
        if (!e) { merged.set(key, { ...r }); continue; }
        for (const f of ['sessions', 'users', 'new_users', 'pageviews']) e[f] += r[f];
    }
    return [...merged.values()];
}

async function saveRows(db, source, site, rows) {
    const list = mergeRows(rows);
    const BATCH = 500;
    for (let i = 0; i < list.length; i += BATCH) {
        const part = list.slice(i, i + BATCH);
        const params = [];
        const values = part.map((r, j) => {
            params.push(source, site, SITES[site].host, r.event_date, r.engine, r.sessions, r.users, r.new_users, r.pageviews);
            const o = j * 9;
            return `(${Array.from({ length: 9 }, (_, k) => `$${o + k + 1}`).join(',')})`;
        });
        await db.query(
            `INSERT INTO reports.traffic_organic_engine
             (source, site, host, event_date, engine, sessions, users, new_users, pageviews)
             VALUES ${values.join(',')}
             ON CONFLICT (source, site, event_date, engine) DO UPDATE SET
               host = EXCLUDED.host, sessions = EXCLUDED.sessions, users = EXCLUDED.users,
               new_users = EXCLUDED.new_users, pageviews = EXCLUDED.pageviews, updated_at = CURRENT_TIMESTAMP`,
            params
        );
    }
    console.log(`→ reports.traffic_organic_engine: ${list.length} строк (${source}/${site})`);
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
    const db = new DatabaseManager('traffic-organic-engines');
    await db.connect();
    let failed = 0;
    try {
        for (const f of SCHEMA_FILES) await db.query(fs.readFileSync(f, 'utf8'));
        for (const site of sites) {
            for (const source of sources) {
                console.log(`\n=== ${source} / ${site} (${SITES[site].host}) ===`);
                const rawSeen = new Map();
                try {
                    const rows = source === 'ga4' ? await fetchGA4(auth, site, range, rawSeen) : await fetchMetrika(site, range, rawSeen);
                    await saveRows(db, source, site, rows);
                    // Как сырые названия свелись к движкам (проверить, что «Other» не прячет Яндекс/Google)
                    const top = [...rawSeen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
                    console.log('Источники (сессий за период):\n' + top.map(([k, v]) => `  ${k}: ${v}`).join('\n'));
                } catch (e) {
                    failed++;
                    console.error(`✗ ${source}/${site}: ${e.message}`);
                }
            }
        }
    } finally {
        await db.disconnect();
    }
    if (failed) process.exitCode = 1;
}

module.exports = { normalizeEngine, mergeRows };

if (require.main === module) main();
