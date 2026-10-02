// scripts/ga4-journey-probe.js
// Проверка, можно ли собрать путь посетителя по страницам (включая информационные) через API GA4 без BigQuery.
// Идея: customUser:cid_ga4 — пользовательское свойство с client id браузера (его ставит GTM), а customer_id приходит в
// регистрации и оплате. Если cid_ga4 есть и в page_view, и в регистрации вместе с customer_id, то страницы до регистрации можно
// сшить с клиентом. Скрипт ТОЛЬКО ЧИТАЕТ и считает покрытие, ничего не пишет.
//
//   node scripts/ga4-journey-probe.js                       # 2026-05-01 .. вчера (с мая customer_id есть в регистрации)
//   node scripts/ga4-journey-probe.js --from 2026-07-01 --to 2026-07-31

require('dotenv').config();
const axios = require('axios');
const GoogleAuthManager = require('../core/GoogleAuthManager');
const { GA4_URL, arg, withRetry } = require('./traffic-history-36m');

const notSet = (field) => ({ notExpression: { filter: { fieldName: field, stringFilter: { matchType: 'EXACT', value: '(not set)' } } } });
const ev = (name) => ({ filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: name } } });

async function main() {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const from = arg('from', '2026-05-01'), to = arg('to', yesterday);
    const propertyId = process.env.GA4_PROPERTY_ID_RU || process.env.GA4_PROPERTY_ID;
    if (!propertyId) throw new Error('Не задан GA4_PROPERTY_ID');
    const auth = new GoogleAuthManager();
    const call = (body) => withRetry(async () => {
        const headers = await auth.getAuthHeaders();
        return (await axios.post(`${GA4_URL}/${propertyId}:runReport`, { dateRanges: [{ startDate: from, endDate: to }], ...body }, { headers, timeout: 90000 })).data;
    }, 'ga4 probe');
    const total = async (expressions) => {
        const d = await call({ metrics: [{ name: 'eventCount' }], dimensionFilter: { andGroup: { expressions } } });
        return d.rows && d.rows[0] ? Number(d.rows[0].metricValues[0].value) : 0;
    };
    const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '—');

    console.log(`GA4 property ${propertyId}, ${from}..${to}\n`);

    const pv = await total([ev('page_view')]);
    const pvCid = await total([ev('page_view'), notSet('customUser:cid_ga4')]);
    console.log(`page_view всего: ${pv}; с cid_ga4: ${pvCid} (${pct(pvCid, pv)})`);

    const reg = await total([ev('registration')]);
    const regCust = await total([ev('registration'), notSet('customEvent:customer_id')]);
    const regCid = await total([ev('registration'), notSet('customUser:cid_ga4')]);
    const regBoth = await total([ev('registration'), notSet('customEvent:customer_id'), notSet('customUser:cid_ga4')]);
    console.log(`registration всего: ${reg}; с customer_id: ${regCust} (${pct(regCust, reg)}); с cid_ga4: ${regCid} (${pct(regCid, reg)}); с обоими: ${regBoth} (${pct(regBoth, reg)})`);

    const pu = await total([ev('purchase')]);
    const puCid = await total([ev('purchase'), notSet('customUser:cid_ga4')]);
    console.log(`purchase всего: ${pu}; с cid_ga4: ${puCid} (${pct(puCid, pu)})`);

    // Кардинальность и «(other)»: берём один день, смотрим страницы по cid_ga4
    const day = to;
    const d = await withRetry(async () => {
        const headers = await auth.getAuthHeaders();
        return (await axios.post(`${GA4_URL}/${propertyId}:runReport`, {
            dateRanges: [{ startDate: day, endDate: day }],
            dimensions: [{ name: 'customUser:cid_ga4' }, { name: 'pagePath' }],
            metrics: [{ name: 'eventCount' }],
            dimensionFilter: { andGroup: { expressions: [ev('page_view'), notSet('customUser:cid_ga4')] } },
            limit: 100000
        }, { headers, timeout: 90000 })).data;
    }, 'ga4 probe day');
    const rows = d.rows || [];
    const other = rows.filter(r => r.dimensionValues.some(x => x.value === '(other)')).length;
    const users = new Set(rows.map(r => r.dimensionValues[0].value));
    console.log(`\nОдин день (${day}): строк «посетитель × страница» ${rows.length}, посетителей ${users.size}, строк с «(other)»: ${other}, rowCount API: ${d.rowCount}`);
    console.log('Если «(other)» много, посетители усечены (высокая кардинальность): тогда путь надо собирать через Метрику (Logs API).');
    console.log('\nВывод: путь по страницам через API возможен, если покрытие cid_ga4 в page_view и в регистрации высокое (> 80%) и «(other)» мало.');
}

main().catch(e => { console.error(e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
