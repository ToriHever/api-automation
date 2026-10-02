// scripts/metrika-goals-audit.js
// Разведка Яндекс Метрики (только чтение): какие цели настроены (регистрация, оплата, корзина, клики по тарифам…),
// сколько достижений каждой за период. Нужно, чтобы построить путь посетителя по страницам через Logs API Метрики
// (в GA4 cid_ga4 не заполняется, путь по страницам через GA4 API не собрать).
//
//   node scripts/metrika-goals-audit.js                         # 2026-01-01 .. вчера, счётчик RU
//   node scripts/metrika-goals-audit.js --from 2026-05-01

require('dotenv').config();
const axios = require('axios');
const { METRIKA_URL, arg, withRetry } = require('./traffic-history-36m');

async function main() {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const from = arg('from', '2026-01-01'), to = arg('to', yesterday);
    const counterId = process.env.YANDEX_METRIKA_COUNTER_ID_RU || process.env.YANDEX_METRIKA_COUNTER_ID;
    const token = process.env.YANDEX_METRIKA_TOKEN;
    if (!counterId || !token) throw new Error('Не заданы YANDEX_METRIKA_COUNTER_ID(_RU) / YANDEX_METRIKA_TOKEN');
    const headers = { Authorization: `OAuth ${token}` };
    const base = METRIKA_URL.replace(/\/stat\/v1\/data.*$/, '');

    console.log(`Метрика, счётчик ${counterId}, ${from}..${to}\n`);
    const goals = (await withRetry(async () => (await axios.get(`${base}/management/v1/counter/${counterId}/goals`, { headers, timeout: 60000 })).data, 'metrika goals')).goals || [];
    console.log(`Целей: ${goals.length}\n`);

    const visits = (await withRetry(async () => (await axios.get(METRIKA_URL, { params: { ids: counterId, date1: from, date2: to, metrics: 'ym:s:visits,ym:s:users', accuracy: 'full' }, headers, timeout: 60000 })).data, 'metrika visits')).totals;
    console.log(`Визитов за период: ${visits[0]}, посетителей: ${visits[1]}\n`);

    const rows = [];
    for (const g of goals) {
        try {
            const d = await withRetry(async () => (await axios.get(METRIKA_URL, { params: { ids: counterId, date1: from, date2: to, metrics: `ym:s:goal${g.id}reaches,ym:s:goal${g.id}visits`, accuracy: 'full' }, headers, timeout: 60000 })).data, `goal ${g.id}`);
            const cond = (g.conditions || []).map(c => `${c.type}:${c.url}`).join(' | ').slice(0, 70);
            rows.push({ id: g.id, name: g.name, type: g.type, cond, reaches: Number(d.totals[0]), visits: Number(d.totals[1]) });
        } catch (e) { rows.push({ id: g.id, name: g.name, type: g.type, cond: '', reaches: -1, visits: -1 }); }
    }
    rows.sort((a, b) => b.reaches - a.reaches);
    console.log('id\tдостижений\tвизитов\tтип\tназвание\tусловие');
    for (const r of rows) console.log(`${r.id}\t${r.reaches}\t${r.visits}\t${r.type}\t${r.name}\t${r.cond}`);
}

main().catch(e => { console.error(e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
