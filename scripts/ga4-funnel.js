// scripts/ga4-funnel.js
// Воронка по каналу ПЕРВОГО визита пользователя (GA4, только чтение, в БД ничего не пишет):
// регистрация -> корзина -> оформление -> способ оплаты -> оплата, по месяцам, отдельно органика и остальные каналы.
// Канал берётся по пользователю (firstUserDefaultChannelGroup), а не по сессии: оплата приходит с сервера
// (хост «(not set)») и по сессии не атрибутируется. Тестовые стенды (*.web-dev.*) исключены.
// Считаются события и уникальные пользователи. Это воронка по событиям GA4 — не по клиентам биллинга:
// один клиент может дать несколько оплат (повторные, пополнения).
//
//   node scripts/ga4-funnel.js                       # 2026-01-01 .. вчера, таблица в консоль
//   node scripts/ga4-funnel.js --from 2025-10-01 --csv /tmp/funnel.csv
//   node scripts/ga4-funnel.js --coupon L3_PAID_TEST_99   # только покупки по купону (тест L3-4)

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const GoogleAuthManager = require('../core/GoogleAuthManager');
const { GA4_URL, arg, withRetry } = require('./traffic-history-36m');

const EVENTS = ['registration', 'add_to_cart', 'begin_checkout', 'add_payment_info', 'purchase'];
const pad = n => String(n).padStart(2, '0');

async function main() {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const from = arg('from', '2026-01-01'), to = arg('to', yesterday), coupon = arg('coupon', null);
    const csv = arg('csv', null);
    const propertyId = process.env.GA4_PROPERTY_ID_RU || process.env.GA4_PROPERTY_ID;
    if (!propertyId) throw new Error('Не задан GA4_PROPERTY_ID');
    const auth = new GoogleAuthManager();

    const expressions = [
        { filter: { fieldName: 'eventName', inListFilter: { values: coupon ? ['purchase'] : EVENTS } } },
        { notExpression: { filter: { fieldName: 'hostName', stringFilter: { matchType: 'CONTAINS', value: 'web-dev' } } } },
        { notExpression: { filter: { fieldName: 'hostName', stringFilter: { matchType: 'CONTAINS', value: 'localhost' } } } }
    ];
    if (coupon) expressions.push({ filter: { fieldName: 'customEvent:coupon', stringFilter: { matchType: 'EXACT', value: coupon } } });

    const rows = [];
    let offset = 0;
    while (true) {
        const data = await withRetry(async () => {
            const headers = await auth.getAuthHeaders();
            return (await axios.post(`${GA4_URL}/${propertyId}:runReport`, {
                dateRanges: [{ startDate: from, endDate: to }],
                dimensions: [{ name: 'yearMonth' }, { name: 'firstUserDefaultChannelGroup' }, { name: 'eventName' }],
                metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
                dimensionFilter: { andGroup: { expressions } }, limit: 100000, offset
            }, { headers, timeout: 90000 })).data;
        }, 'ga4 funnel');
        const r = data.rows || [];
        for (const x of r) rows.push({ m: x.dimensionValues[0].value, ch: x.dimensionValues[1].value, ev: x.dimensionValues[2].value, n: Number(x.metricValues[0].value), u: Number(x.metricValues[1].value) });
        if (r.length < 100000) break;
        offset += 100000;
    }

    const months = [...new Set(rows.map(r => r.m))].sort();
    const grp = ch => (ch === 'Organic Search' ? 'Organic' : 'Прочие');
    const agg = new Map();   // month|group|event -> {n,u}
    for (const r of rows) {
        const k = `${r.m}|${grp(r.ch)}|${r.ev}`;
        const e = agg.get(k) || { n: 0, u: 0 };
        e.n += r.n; e.u += r.u;                    // сумма пользователей по каналам — приближённо (пользователь в одном канале первого визита)
        agg.set(k, e);
    }
    const evs = coupon ? ['purchase'] : EVENTS;
    console.log(`Воронка GA4, ${from}..${to}${coupon ? `, купон ${coupon}` : ''}; канал первого визита; события / пользователи\n`);
    const out = [['month', 'group', ...evs.flatMap(e => [e + '_events', e + '_users'])]];
    for (const m of months) for (const g of ['Organic', 'Прочие']) {
        const cells = evs.map(e => agg.get(`${m}|${g}|${e}`) || { n: 0, u: 0 });
        out.push([`${m.slice(0, 4)}-${m.slice(4)}`, g, ...cells.flatMap(c => [c.n, c.u])]);
        console.log(`${m.slice(0, 4)}-${m.slice(4)}  ${g.padEnd(7)}  ` + evs.map((e, i) => `${e}: ${cells[i].n}/${cells[i].u}`).join('  '));
    }
    console.log('\nКаналы первого визита (все месяцы, события purchase):');
    const byCh = new Map();
    for (const r of rows.filter(r => r.ev === 'purchase')) byCh.set(r.ch, (byCh.get(r.ch) || 0) + r.n);
    for (const [ch, n] of [...byCh.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${ch}`);
    if (csv) { fs.writeFileSync(csv, out.map(r => r.join(',')).join('\n'), 'utf8'); console.log(`\nCSV: ${csv}`); }
}

main().catch(e => { console.error(e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
