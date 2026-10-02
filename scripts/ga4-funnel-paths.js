// scripts/ga4-funnel-paths.js
// «Путь от страницы до регистрации и оплаты» через GA4 Funnel API (runFunnelReport, v1alpha, только чтение, в БД ничего не пишет).
// Исследование пути в интерфейсе GA4 строится по пользователям внутри GA4 и через Data API недоступно; воронка по шагам — доступна:
// GA4 сам сшивает шаги по одному пользователю (cookie браузера), без нашего идентификатора. Нужные шаги:
//   1) просмотр страницы выбранного типа (информационные / главная / продукты / любая) ->
//   2) регистрация (событие registration) -> 3) оплата (событие purchase).
// Воронка закрытая (пользователь прошёл шаги по порядку), разбивка по каналу первого визита пользователя.
// Привязки к customer_id нет: это доли пользователей, а не клиенты биллинга.
//
//   node scripts/ga4-funnel-paths.js                          # 2026-01-01 .. вчера
//   node scripts/ga4-funnel-paths.js --from 2026-05-01 --to 2026-09-30
//   node scripts/ga4-funnel-paths.js --within 30              # (дни) шаг должен произойти не позже чем через N дней после предыдущего

require('dotenv').config();
const axios = require('axios');
const GoogleAuthManager = require('../core/GoogleAuthManager');
const { arg, withRetry } = require('./traffic-history-36m');

const URL_ALPHA = 'https://analyticsdata.googleapis.com/v1alpha/properties';
const HOST = '^https://ddos-guard\\.ru';
const PAGE_TYPES = {
    'Информационные страницы': `${HOST}/(blog|terms|tutorials|technologies|case-studies|osi-model)(/|\\?|$)`,
    'Главная': `${HOST}/?(\\?.*)?$`,
    'Продуктовые страницы': `${HOST}/(web-protection|network-protection|vds-vps|server|hosting|waf|bot-mitigation)(/|\\?|$)`,
    'Любая страница сайта ddos-guard.ru': `${HOST}(/|\\?|$)`
};

const pageView = (regex) => ({ funnelEventFilter: { eventName: 'page_view', funnelParameterFilterExpression: {
    funnelParameterFilter: { eventParameterName: 'page_location', stringFilter: { matchType: 'PARTIAL_REGEXP', value: regex } } } } });
const event = (name) => ({ funnelEventFilter: { eventName: name } });

async function main() {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const from = arg('from', '2026-01-01'), to = arg('to', yesterday), within = arg('within', null);
    const propertyId = process.env.GA4_PROPERTY_ID_RU || process.env.GA4_PROPERTY_ID;
    if (!propertyId) throw new Error('Не задан GA4_PROPERTY_ID');
    const auth = new GoogleAuthManager();
    const withinObj = within ? { withinDurationFromPriorStep: `${Number(within) * 86400}s` } : {};

    console.log(`GA4 Funnel API, ${from}..${to}${within ? `, шаги в пределах ${within} дн.` : ''}\n`);
    for (const [name, regex] of Object.entries(PAGE_TYPES)) {
        const body = {
            dateRanges: [{ startDate: from, endDate: to }],
            funnel: { isOpenFunnel: false, steps: [
                { name: `1. ${name}`, filterExpression: pageView(regex) },
                { name: '2. Регистрация', filterExpression: event('registration'), ...withinObj },
                { name: '3. Оплата', filterExpression: event('purchase'), ...withinObj }
            ] },
            funnelBreakdown: { breakdownDimension: { name: 'firstUserDefaultChannelGroup' }, limit: 6 }
        };
        let data;
        try {
            data = await withRetry(async () => {
                const headers = await auth.getAuthHeaders();
                return (await axios.post(`${URL_ALPHA}/${propertyId}:runFunnelReport`, body, { headers, timeout: 120000 })).data;
            }, `funnel ${name}`);
        } catch (e) {
            console.error(`✗ ${name}: ${e.response ? JSON.stringify(e.response.data) : e.message}`);
            continue;
        }
        const rows = (data.funnelTable && data.funnelTable.rows) || [];
        const byChannel = new Map();
        for (const r of rows) {
            const step = r.dimensionValues[0].value, ch = r.dimensionValues[1] ? r.dimensionValues[1].value : 'все';
            if (!byChannel.has(ch)) byChannel.set(ch, {});
            byChannel.get(ch)[step[0]] = Number(r.metricValues[0].value);
        }
        console.log(`=== ${name} ===`);
        console.log('  канал первого визита        1.просмотр  2.регистрация (% от 1)  3.оплата (% от 1)');
        for (const [ch, s] of [...byChannel.entries()].sort((a, b) => (b[1]['1'] || 0) - (a[1]['1'] || 0))) {
            const a = s['1'] || 0, b = s['2'] || 0, c = s['3'] || 0;
            const p = (x) => (a ? `${(100 * x / a).toFixed(2)}%` : '—');
            console.log(`  ${ch.padEnd(26)} ${String(a).padStart(9)}  ${String(b).padStart(9)} (${p(b).padStart(6)})  ${String(c).padStart(8)} (${p(c).padStart(6)})`);
        }
        console.log('');
    }
    console.log('Примечание: воронка закрытая (шаги по порядку, один пользователь/браузер); оплата приходит с сервера и учитывается, если GA4 связал её с тем же пользователем.');
}

main().catch(e => { console.error(e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
