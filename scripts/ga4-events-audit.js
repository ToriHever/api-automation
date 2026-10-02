// scripts/ga4-events-audit.js
// Разведка перед построением клиентского пути из GA4: только чтение, в БД ничего не пишет.
// Показывает: какие события есть за период (с числом событий и пользователей), помесячную динамику
// «ключевых» по смыслу событий (регистрация, оплата, заявка, триал, форма…), какие пользовательские
// параметры и идентификаторы доступны в API (customUser:/customEvent:, user_id и др.).
// Нужно, чтобы понять, из чего можно строить путь (посадочная -> регистрация -> оплата) и можно ли
// связать его с платежами (user_id), либо нужна выгрузка в BigQuery.
//
//   node scripts/ga4-events-audit.js                     # 2026-01-01 .. вчера, сайт ru
//   node scripts/ga4-events-audit.js --from 2026-01-01 --to 2026-09-30
//   node scripts/ga4-events-audit.js --host-only    # только ddos-guard.ru (по умолчанию — ВСЕ хосты, в т.ч. личный кабинет)
//   node scripts/ga4-events-audit.js --top 150      # сколько событий печатать (по умолчанию 80)
// Регистрация, оплата и шаги мастера подключения L3-4 идут из личного кабинета (другой хост), поэтому по умолчанию
// фильтра по хосту нет, а ниже печатается разбивка интересных событий по хостам.

require('dotenv').config();
const axios = require('axios');
const GoogleAuthManager = require('../core/GoogleAuthManager');
const { SITES, GA4_URL, arg, withRetry } = require('./traffic-history-36m');

const INTERESTING = /sign|regist|login|lead|purchase|payment|pay|order|trial|form|submit|click|cta|invoice|checkout|cart|generate|begin|start|conf|contact|demo|test|шаг|wizard|activate|tariff/i;

async function main() {
    const siteKey = arg('site', 'ru');
    const host = SITES[siteKey].host;
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const from = arg('from', '2026-01-01'), to = arg('to', yesterday);
    const propertyId = process.env[`GA4_PROPERTY_ID_${siteKey.toUpperCase()}`] || process.env.GA4_PROPERTY_ID;
    if (!propertyId) throw new Error('Не задан GA4_PROPERTY_ID');
    const auth = new GoogleAuthManager();
    const hostOnly = process.argv.includes('--host-only');
    const top = Number(arg('top', 80));
    const hostFilter = hostOnly
        ? { filter: { fieldName: 'hostName', stringFilter: { matchType: 'EXACT', value: host } } }
        : { filter: { fieldName: 'eventName', stringFilter: { matchType: 'FULL_REGEXP', value: '.+' } } };
    const call = async (path, body) => withRetry(async () => {
        const headers = await auth.getAuthHeaders();
        return (body ? await axios.post(`${GA4_URL}/${propertyId}${path}`, body, { headers, timeout: 60000 })
                     : await axios.get(`${GA4_URL}/${propertyId}${path}`, { headers, timeout: 60000 })).data;
    }, `ga4 ${path}`);

    console.log(`GA4 property ${propertyId}, ${host}, ${from}..${to}\n`);

    // 1. Все события периода
    const ev = await call(':runReport', {
        dateRanges: [{ startDate: from, endDate: to }],
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
        dimensionFilter: hostFilter, orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }], limit: 200
    });
    const events = (ev.rows || []).map(r => ({ name: r.dimensionValues[0].value, count: Number(r.metricValues[0].value), users: Number(r.metricValues[1].value) }));
    console.log(`=== События (топ-${top} по числу; ${hostOnly ? 'только ' + host : 'все хосты'}) ===`);
    for (const e of events.slice(0, top)) console.log(`  ${String(e.count).padStart(9)} соб. ${String(e.users).padStart(8)} польз.  ${e.name}${INTERESTING.test(e.name) ? '   ←' : ''}`);

    // 2. Помесячная динамика «интересных» событий
    const names = events.filter(e => INTERESTING.test(e.name) && !/^(page_view|session_start|first_visit|user_engagement|scroll)$/.test(e.name)).slice(0, 25).map(e => e.name);
    if (names.length) {
        const mo = await call(':runReport', {
            dateRanges: [{ startDate: from, endDate: to }],
            dimensions: [{ name: 'yearMonth' }, { name: 'eventName' }],
            metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
            dimensionFilter: { andGroup: { expressions: [hostFilter, { filter: { fieldName: 'eventName', inListFilter: { values: names } } }] } },
            orderBys: [{ dimension: { dimensionName: 'eventName' } }, { dimension: { dimensionName: 'yearMonth' } }], limit: 1000
        });
        const by = new Map();
        for (const r of mo.rows || []) {
            const n = r.dimensionValues[1].value;
            if (!by.has(n)) by.set(n, []);
            by.get(n).push(`${r.dimensionValues[0].value}:${r.metricValues[0].value}`);
        }
        console.log('\n=== Динамика интересных событий по месяцам (месяц:событий) ===');
        for (const [n, arr] of by) console.log(`  ${n}: ${arr.join(' ')}`);
    }

    // 2b. Хосты, на которых случаются интересные события (личный кабинет и т.п.)
    if (names.length) {
        const hs = await call(':runReport', {
            dateRanges: [{ startDate: from, endDate: to }],
            dimensions: [{ name: 'hostName' }, { name: 'eventName' }],
            metrics: [{ name: 'eventCount' }],
            dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: names } } },
            orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }], limit: 300
        });
        console.log('\n=== Интересные события по хостам (хост — событие — число) ===');
        for (const r of (hs.rows || []).slice(0, 60)) console.log(`  ${String(r.metricValues[0].value).padStart(8)}  ${r.dimensionValues[0].value}  —  ${r.dimensionValues[1].value}`);
    }

    // 3. Метаданные: пользовательские параметры и идентификаторы
    const md = await call('/metadata');
    const custom = (md.dimensions || []).filter(d => /^custom(User|Event):/.test(d.apiName));
    const idLike = (md.dimensions || []).filter(d => /user.?id|client.?id|pseudo|customUser/i.test(d.apiName + d.uiName) && !/^custom(User|Event):/.test(d.apiName));
    console.log(`\n=== Пользовательские параметры (customEvent/customUser): ${custom.length} ===`);
    for (const d of custom) console.log(`  ${d.apiName}  — ${d.uiName}`);
    console.log(`\n=== Стандартные идентификаторы (user_id и т.п.) ===`);
    for (const d of idLike) console.log(`  ${d.apiName}  — ${d.uiName}`);
    console.log('\nПодсказка: если есть регистрация/оплата и пользовательский id, путь можно связать с платежами; иначе — агрегированный путь по каналам и страницам.');
}

main().catch(e => { console.error(e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
