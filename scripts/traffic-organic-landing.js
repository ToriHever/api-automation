// scripts/traffic-organic-landing.js
// Органический трафик по страницам входа (landing page) по месяцам. Нужен, чтобы связать трафик на
// страницы продуктовых групп (L7, L3-4, DS, VDS, Хостинг) с покупками и считать конверсию на 1000 сессий.
//   GA4:      канал Organic Search, hostName == домен (EXACT); измерения yearMonth + landingPage + sessionSource
//   Метрика:  lastTrafficSource == 'organic', startURLDomain == домен; измерения datePeriodmonth + startURLPath + lastSearchEngineRoot
// Берутся только ПОЛНЫЕ месяцы (текущий не собирается). Каждый месяц пересобирается целиком (повторный запуск безопасен).
// Результат: reports.traffic_organic_landing (схема — services/reports/traffic_landing_schema.sql, создаётся автоматически).
// Настройки .env — те же, что у scripts/traffic-organic-engines.js.
//
// Запуск:
//   node scripts/traffic-organic-landing.js                              # GA4 и Метрика, ru, с 2024-10
//   node scripts/traffic-organic-landing.js --source ga4 --from 2025-10  # только GA4, с октября 2025
//   node scripts/traffic-organic-landing.js --dry-run                    # без записи в БД, покажет топ страниц

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { normalizeEngine } = require('./traffic-organic-engines');
const { SITES, GA4_URL, METRIKA_URL, arg, withRetry } = require('./traffic-history-36m');

const SCHEMA_FILES = ['schema.sql', 'organic_engine_schema.sql', 'traffic_landing_schema.sql', 'purchases_schema.sql']
    .map(f => path.join(__dirname, '..', 'services', 'reports', f));
const MIN_SESSIONS = 1;   // страницы с меньшим числом сессий за месяц и поисковик отбрасываются

/** Путь страницы входа -> https://домен/путь (нижний регистр, без параметров, якоря и / на конце). null — не страница. */
function normalizePage(host, rawPath) {
    let p = String(rawPath || '').trim();
    if (!p || p === '(not set)' || p === '(not provided)') return null;
    p = p.replace(/^https?:\/\/[^/]+/i, '').split('#')[0].split('?')[0];
    if (!p.startsWith('/')) p = '/' + p;
    p = p.toLowerCase().replace(/\/+$/, '');
    return `https://${host}${p}`;
}

/** [{month, page, engine, sessions}] -> суммирует одинаковые (месяц, страница, поисковик). */
function mergeRows(rows) {
    const m = new Map();
    for (const r of rows) {
        const k = `${r.month}|${r.page}|${r.engine}`;
        const e = m.get(k);
        if (e) e.sessions += r.sessions; else m.set(k, { ...r });
    }
    return [...m.values()];
}

/** Полные месяцы с from (YYYY-MM) до прошлого месяца включительно: [{month:'2025-10-01', start, end}] */
function monthsList(from, today = new Date()) {
    const out = [];
    let [y, m] = from.split('-').map(Number);
    const lastY = today.getUTCMonth() === 0 ? today.getUTCFullYear() - 1 : today.getUTCFullYear();
    const lastM = today.getUTCMonth() === 0 ? 12 : today.getUTCMonth();
    while (y < lastY || (y === lastY && m <= lastM)) {
        const pad = n => String(n).padStart(2, '0');
        const endDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        out.push({ month: `${y}-${pad(m)}-01`, start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(endDay)}` });
        m++; if (m > 12) { m = 1; y++; }
    }
    return out;
}

async function fetchGA4(auth, siteKey, months, onMonth) {
    const propertyId = process.env[`GA4_PROPERTY_ID_${siteKey.toUpperCase()}`] || process.env.GA4_PROPERTY_ID;
    if (!propertyId) throw new Error('Не задан GA4_PROPERTY_ID (или GA4_PROPERTY_ID_RU/_EN)');
    const host = SITES[siteKey].host;
    for (const mo of months) {
        const rows = [];
        let offset = 0;
        while (true) {
            const body = {
                dateRanges: [{ startDate: mo.start, endDate: mo.end }],
                dimensions: [{ name: 'landingPage' }, { name: 'sessionSource' }],
                metrics: [{ name: 'sessions' }],
                dimensionFilter: { andGroup: { expressions: [
                    { filter: { fieldName: 'hostName', stringFilter: { matchType: 'EXACT', value: host } } },
                    { filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { matchType: 'EXACT', value: 'Organic Search' } } }
                ] } },
                limit: 100000, offset
            };
            const data = await withRetry(async () => {
                const headers = await auth.getAuthHeaders();
                return (await axios.post(`${GA4_URL}/${propertyId}:runReport`, body, { headers, timeout: 60000 })).data;
            }, `ga4 landing ${mo.month}`);
            const r = data.rows || [];
            for (const row of r) {
                const page = normalizePage(host, row.dimensionValues[0].value);
                if (!page) continue;
                rows.push({ month: mo.month, page, engine: normalizeEngine(row.dimensionValues[1].value), sessions: Number(row.metricValues[0].value) });
            }
            if (r.length < 100000) break;
            offset += 100000;
        }
        await onMonth(mo, rows);
    }
}

async function fetchMetrika(siteKey, months, onMonth) {
    const counterId = process.env[`YANDEX_METRIKA_COUNTER_ID_${siteKey.toUpperCase()}`] || process.env.YANDEX_METRIKA_COUNTER_ID;
    const token = process.env.YANDEX_METRIKA_TOKEN;
    if (!counterId) throw new Error('Не задан YANDEX_METRIKA_COUNTER_ID (или YANDEX_METRIKA_COUNTER_ID_RU/_EN)');
    if (!token) throw new Error('Не задан YANDEX_METRIKA_TOKEN');
    const host = SITES[siteKey].host;
    for (const mo of months) {
        const rows = [];
        let offset = 1;
        while (true) {
            const params = {
                ids: counterId, date1: mo.start, date2: mo.end,
                dimensions: 'ym:s:startURLPath,ym:s:lastSearchEngineRoot',
                metrics: 'ym:s:visits',
                filters: `ym:s:lastTrafficSource=='organic' AND ym:s:startURLDomain=='${host}'`,
                accuracy: 'full', lang: 'ru', limit: 100000, offset
            };
            const data = await withRetry(async () =>
                (await axios.get(METRIKA_URL, { params, headers: { Authorization: `OAuth ${token}` }, timeout: 60000 })).data,
                `metrika landing ${mo.month}`);
            const r = data.data || [];
            for (const row of r) {
                const page = normalizePage(host, row.dimensions[0].name || row.dimensions[0].id);
                if (!page) continue;
                const d = row.dimensions[1];
                const eng = normalizeEngine(d.id) !== 'Other' ? normalizeEngine(d.id) : normalizeEngine(d.name);
                rows.push({ month: mo.month, page, engine: eng, sessions: Math.round(row.metrics[0]) });
            }
            if (r.length < 100000) break;
            offset += 100000;
        }
        await onMonth(mo, rows);
    }
}

async function saveMonth(db, source, site, mo, rows) {
    const list = mergeRows(rows).filter(r => r.sessions >= MIN_SESSIONS);
    await db.query('BEGIN');
    try {
        await db.query('DELETE FROM reports.traffic_organic_landing WHERE source = $1 AND site = $2 AND month = $3', [source, site, mo.month]);
        const BATCH = 500;
        for (let i = 0; i < list.length; i += BATCH) {
            const part = list.slice(i, i + BATCH), params = [];
            const values = part.map((r, j) => {
                params.push(source, site, r.month, r.page, r.engine, r.sessions);
                const o = j * 6;
                return `(${[1, 2, 3, 4, 5, 6].map(k => `$${o + k}`).join(',')})`;
            });
            await db.query(
                `INSERT INTO reports.traffic_organic_landing (source, site, month, page, engine, sessions) VALUES ${values.join(',')}
                 ON CONFLICT (source, site, month, page, engine) DO UPDATE SET sessions = EXCLUDED.sessions, updated_at = CURRENT_TIMESTAMP`, params);
        }
        await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK'); throw e; }
    return list.length;
}

module.exports = { normalizePage, mergeRows, monthsList };

async function main() {
    const from = arg('from', '2024-10');
    const sourceArg = arg('source', 'all');
    const siteArg = arg('site', 'ru');
    const dry = process.argv.includes('--dry-run');
    const months = monthsList(from);
    const sources = sourceArg === 'all' ? ['ga4', 'metrika'] : [sourceArg];
    const sites = siteArg === 'all' ? Object.keys(SITES) : [siteArg];
    console.log(`Месяцы: ${months[0].month}..${months[months.length - 1].month} (${months.length}); источники: ${sources}; сайты: ${sites.map(s => SITES[s].host)}${dry ? '; DRY-RUN' : ''}`);

    const GoogleAuthManager = require('../core/GoogleAuthManager');
    const DatabaseManager = require('../core/DatabaseManager');
    const auth = sources.includes('ga4') ? new GoogleAuthManager() : null;
    let db = null;
    if (!dry) {
        db = new DatabaseManager('traffic-organic-landing');
        await db.connect();
        for (const f of SCHEMA_FILES) await db.query(fs.readFileSync(f, 'utf8'));
    }
    let failed = 0;
    try {
        for (const site of sites) for (const source of sources) {
            console.log(`\n=== ${source} / ${site} (${SITES[site].host}) ===`);
            const total = new Map();
            const onMonth = async (mo, rows) => {
                const merged = mergeRows(rows);
                const sum = merged.reduce((s, r) => s + r.sessions, 0);
                for (const r of merged) total.set(r.page, (total.get(r.page) || 0) + r.sessions);
                const n = dry ? merged.length : await saveMonth(db, source, site, mo, rows);
                console.log(`  ${mo.month.slice(0, 7)}: страниц×поисковиков ${n}, сессий ${sum}`);
            };
            try {
                if (source === 'ga4') await fetchGA4(auth, site, months, onMonth);
                else await fetchMetrika(site, months, onMonth);
                const top = [...total.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
                console.log('Топ страниц входа за период:\n' + top.map(([p, v]) => `  ${v}\t${p}`).join('\n'));
            } catch (e) {
                failed++;
                console.error(`✗ ${source}/${site}: ${e.message}`);
            }
        }
    } finally {
        if (db) await db.disconnect();
    }
    if (failed) process.exitCode = 1;
}

if (require.main === module) main();
