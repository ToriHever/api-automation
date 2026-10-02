// scripts/ga4-customer-journey.js
// Клиентский путь из GA4 по customer_id (совпадает с id клиента в админке): события регистрации, корзины, оформления,
// способа оплаты и оплаты с каналом ПЕРВОГО визита пользователя; оплаты с купоном, валютой, суммой, способом оплаты.
// Пишет в reports.ga4_customer_events и reports.ga4_customer_purchases (схема — services/reports/ga4_customer_schema.sql,
// создаётся автоматически). Месяц пересобирается целиком: повторный запуск безопасен.
// customer_id — внутренний идентификатор: в отчёты наружу не выводится.
//
//   node scripts/ga4-customer-journey.js --dry-run                    # без записи, покажет число строк по месяцам
//   node scripts/ga4-customer-journey.js                              # 2026-01 .. прошлый месяц и текущий (неполный)
//   node scripts/ga4-customer-journey.js --from 2025-10

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { GA4_URL, arg, withRetry } = require('./traffic-history-36m');

const EVENTS = ['registration', 'add_to_cart', 'begin_checkout', 'add_payment_info', 'purchase'];
const NOT_SET = new Set(['(not set)', '', '(none)']);
const pad = n => String(n).padStart(2, '0');

/** Месяцы с `from` (YYYY-MM) по текущий включительно: [{ key:'2026-01', start, end }] (end не позже вчера). */
function monthsFrom(from, today = new Date()) {
    const out = [];
    let [y, m] = from.split('-').map(Number);
    const yesterday = new Date(today.getTime() - 86400000);
    while (y < yesterday.getUTCFullYear() || (y === yesterday.getUTCFullYear() && m <= yesterday.getUTCMonth() + 1)) {
        const last = new Date(Date.UTC(y, m, 0));
        const end = last > yesterday ? yesterday : last;
        out.push({ key: `${y}-${pad(m)}`, start: `${y}-${pad(m)}-01`, end: end.toISOString().slice(0, 10) });
        m++; if (m > 12) { m = 1; y++; }
    }
    return out;
}

const ymd = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const clean = v => (NOT_SET.has(v) ? '' : v);

async function runReport(auth, propertyId, body) {
    const rows = [];
    let offset = 0;
    while (true) {
        const data = await withRetry(async () => {
            const headers = await auth.getAuthHeaders();
            return (await axios.post(`${GA4_URL}/${propertyId}:runReport`, { ...body, limit: 100000, offset }, { headers, timeout: 120000 })).data;
        }, 'ga4 customer');
        const r = data.rows || [];
        rows.push(...r);
        if (r.length < 100000) break;
        offset += 100000;
    }
    return rows;
}

// GA4 считает в лимит «9 измерений» и измерения из фильтров: у запроса оплат 8 измерений + eventName = 9, фильтр по хосту не добавляем
// (purchase приходит с сервера, хост «(not set)», тестовых стендов в нём нет)
const baseFilter = (events, withHost = true) => [
    { filter: { fieldName: 'eventName', inListFilter: { values: events } } },
    { notExpression: { filter: { fieldName: 'customEvent:customer_id', stringFilter: { matchType: 'EXACT', value: '(not set)' } } } },
    ...(withHost ? [
        { notExpression: { filter: { fieldName: 'hostName', stringFilter: { matchType: 'CONTAINS', value: 'web-dev' } } } },
        { notExpression: { filter: { fieldName: 'hostName', stringFilter: { matchType: 'CONTAINS', value: 'localhost' } } } }
    ] : [])
];

async function main() {
    const from = arg('from', '2026-01');
    const dry = process.argv.includes('--dry-run');
    const propertyId = process.env.GA4_PROPERTY_ID_RU || process.env.GA4_PROPERTY_ID;
    if (!propertyId) throw new Error('Не задан GA4_PROPERTY_ID');
    const GoogleAuthManager = require('../core/GoogleAuthManager');
    const auth = new GoogleAuthManager();
    let db = null;
    if (!dry) {
        const DatabaseManager = require('../core/DatabaseManager');
        db = new DatabaseManager('ga4-customer-journey');
        await db.connect();
        await db.query(fs.readFileSync(path.join(__dirname, '../services/reports/ga4_customer_schema.sql'), 'utf8'));
    }
    try {
        for (const mo of monthsFrom(from)) {
            const range = [{ startDate: mo.start, endDate: mo.end }];
            const a = await runReport(auth, propertyId, {
                dateRanges: range,
                dimensions: ['date', 'customEvent:customer_id', 'eventName', 'firstUserDefaultChannelGroup', 'firstUserSource', 'firstUserMedium'].map(name => ({ name })),
                metrics: [{ name: 'eventCount' }],
                dimensionFilter: { andGroup: { expressions: baseFilter(EVENTS) } }
            });
            const b = await runReport(auth, propertyId, {
                dateRanges: range,
                dimensions: ['date', 'customEvent:customer_id', 'customEvent:transaction_id', 'customEvent:coupon', 'customEvent:currency',
                    'customEvent:value', 'customEvent:payment_type', 'customEvent:period'].map(name => ({ name })),
                metrics: [{ name: 'eventCount' }],
                dimensionFilter: { andGroup: { expressions: baseFilter(['purchase'], false) } }
            });
            console.log(`${mo.key}: событий путь ${a.length} строк, оплат ${b.length} строк${dry ? ' (dry-run)' : ''}`);
            if (dry) continue;
            await db.query('BEGIN');
            try {
                await db.query('DELETE FROM reports.ga4_customer_events WHERE event_date BETWEEN $1 AND $2', [mo.start, mo.end]);
                await db.query('DELETE FROM reports.ga4_customer_purchases WHERE event_date BETWEEN $1 AND $2', [mo.start, mo.end]);
                const merge = new Map();
                for (const r of a) {
                    const d = r.dimensionValues.map(x => x.value);
                    const key = [ymd(d[0]), d[1], d[2], clean(d[3]), clean(d[4]), clean(d[5])].join('\u0001');
                    merge.set(key, (merge.get(key) || 0) + Number(r.metricValues[0].value));
                }
                const evRows = [...merge.entries()].map(([k, n]) => [...k.split('\u0001'), n]);
                for (let i = 0; i < evRows.length; i += 500) {
                    const part = evRows.slice(i, i + 500), params = [];
                    const values = part.map((r, j) => { params.push(...r); const o = j * 7; return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7})`; });
                    await db.query(`INSERT INTO reports.ga4_customer_events (event_date, customer_id, event_name, first_channel, first_source, first_medium, event_count)
                        VALUES ${values.join(',')} ON CONFLICT DO NOTHING`, params);
                }
                const pm = new Map();
                for (const r of b) {
                    const d = r.dimensionValues.map(x => x.value);
                    const value = NOT_SET.has(d[5]) ? 0 : Number(d[5]);
                    const key = [ymd(d[0]), d[1], clean(d[2]), clean(d[3]), clean(d[4]), Number.isNaN(value) ? 0 : value, clean(d[6]), clean(d[7])].join('\u0001');
                    pm.set(key, (pm.get(key) || 0) + Number(r.metricValues[0].value));
                }
                const puRows = [...pm.entries()].map(([k, n]) => { const p = k.split('\u0001'); return [p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], n]; });
                for (let i = 0; i < puRows.length; i += 500) {
                    const part = puRows.slice(i, i + 500), params = [];
                    const values = part.map((r, j) => { params.push(...r); const o = j * 9; return `(${Array.from({ length: 9 }, (_, k) => `$${o + k + 1}`).join(',')})`; });
                    await db.query(`INSERT INTO reports.ga4_customer_purchases (event_date, customer_id, transaction_id, coupon, currency, value, payment_type, period, event_count)
                        VALUES ${values.join(',')} ON CONFLICT DO NOTHING`, params);
                }
                await db.query('COMMIT');
            } catch (e) { await db.query('ROLLBACK'); throw e; }
        }
    } finally {
        if (db) await db.disconnect();
    }
}

module.exports = { monthsFrom };

if (require.main === module) main().catch(e => { console.error(e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
