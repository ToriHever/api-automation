// scripts/ga4-event-params.js
// Разбор параметров конкретных событий GA4 (только чтение, в БД ничего не пишет): какие значения
// принимают tariff/period/payment_type/coupon/currency и т.п., заполнены ли customer_id / transaction_id,
// сколько событий приходит от авторизованных пользователей (signedInWithUserId).
// Персональные поля (email, phone, ip, user_name, customer_id, transaction_id) НЕ печатаются:
// только сколько событий их содержит.
//
//   node scripts/ga4-event-params.js --event add_to_cart
//   node scripts/ga4-event-params.js --event l3_trial --from 2026-01-01 --to 2026-09-30
//   node scripts/ga4-event-params.js --event l3_activate

require('dotenv').config();
const axios = require('axios');
const GoogleAuthManager = require('../core/GoogleAuthManager');
const { SITES, GA4_URL, arg, withRetry } = require('./traffic-history-36m');

const SHOW = ['tariff', 'period', 'payment_type', 'coupon', 'currency', 'server_system', 'site', 'country', 'source', 'medium', 'campaign',
    'action', 'event_category', 'event_label', 'event_type', 'event_method', 'btn_text', 'signup_url', 'cta_url', 'wizard_id', 'domain_zone', 'value'];
const SENSITIVE = ['customer_id', 'transaction_id', 'email', 'user_email', 'phone', 'ip', 'user_name', 'name', 'company', 'ddg_cookie'];
const EMPTY = new Set(['(not set)', '', '(none)']);

async function main() {
    const event = arg('event');
    if (!event) throw new Error('Укажите событие: --event add_to_cart');
    const siteKey = arg('site', 'ru');
    const host = SITES[siteKey].host;
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const from = arg('from', '2026-01-01'), to = arg('to', yesterday);
    const propertyId = process.env[`GA4_PROPERTY_ID_${siteKey.toUpperCase()}`] || process.env.GA4_PROPERTY_ID;
    if (!propertyId) throw new Error('Не задан GA4_PROPERTY_ID');
    const auth = new GoogleAuthManager();
    const evFilter = { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: event } } };
    // По умолчанию все хосты (ЛК живёт на другом хосте); --host-only — только основной сайт
    const filter = process.argv.includes('--host-only')
        ? { andGroup: { expressions: [{ filter: { fieldName: 'hostName', stringFilter: { matchType: 'EXACT', value: host } } }, evFilter] } }
        : evFilter;
    const run = async (dimension) => withRetry(async () => {
        const headers = await auth.getAuthHeaders();
        return (await axios.post(`${GA4_URL}/${propertyId}:runReport`, {
            dateRanges: [{ startDate: from, endDate: to }], dimensions: [{ name: dimension }],
            metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }], dimensionFilter: filter,
            orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }], limit: 1000
        }, { headers, timeout: 60000 })).data.rows || [];
    }, `ga4 ${dimension}`);

    console.log(`Событие «${event}», ${host}, ${from}..${to}\n`);
    const total = (await run('eventName')).reduce((s, r) => s + Number(r.metricValues[0].value), 0);
    console.log(`Всего событий: ${total}\n`);

    const signed = await run('signedInWithUserId');
    console.log('Авторизованные (signedInWithUserId): ' + (signed.map(r => `${r.dimensionValues[0].value}: ${r.metricValues[0].value} соб.`).join('; ') || '—') + '\n');

    for (const p of SHOW) {
        let rows;
        try { rows = await run(`customEvent:${p}`); } catch (e) { continue; }
        const real = rows.filter(r => !EMPTY.has(r.dimensionValues[0].value));
        if (!real.length) continue;
        const sum = real.reduce((s, r) => s + Number(r.metricValues[0].value), 0);
        console.log(`${p}: заполнен в ${sum} из ${total} событий; значений ${real.length}`);
        for (const r of real.slice(0, 8)) console.log(`    ${String(r.metricValues[0].value).padStart(6)}  ${String(r.dimensionValues[0].value).slice(0, 80)}`);
    }
    console.log('\nПерсональные/идентифицирующие поля (значения не показываются):');
    for (const p of SENSITIVE) {
        let rows;
        try { rows = await run(`customEvent:${p}`); } catch (e) { continue; }
        const real = rows.filter(r => !EMPTY.has(r.dimensionValues[0].value));
        const sum = real.reduce((s, r) => s + Number(r.metricValues[0].value), 0);
        console.log(`  ${p}: заполнен в ${sum} из ${total} событий (${real.length} разных значений)`);
    }
}

main().catch(e => { console.error(e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
