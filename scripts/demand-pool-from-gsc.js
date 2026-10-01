// scripts/demand-pool-from-gsc.js
// Расширение пула фраз спроса (reports.demand_phrases) фразами из Google Search Console.
//
// Зачем: пул из групп Топвизора узкий; в GSC видно, как реально ищут продукты. GSC даёт только СЛОВАРЬ
// фраз — сам спрос (частотность) берётся из Wordstat за весь диапазон (scripts/wordstat-product-demand.js),
// поэтому короткая история фразы в GSC не мешает.
//
// Отбор: небрендовые запросы, по которым показываются страницы продуктовых групп Топвизора
// (analytics.v_topvisor_group_target_urls), с суммой показов >= --min-impr (по умолчанию 100) за период.
// Страница не равна смыслу запроса (на страницу VDS попадают «пентест», на L3-4 — «техподдержка»),
// поэтому каждая фраза размечается правилами (classify):
//   ok     — спрос на защиту / сервер / хостинг продукта -> product = группа (VDS/VPS -> VDS)
//   attack — заказ/покупка атаки -> product = «Заказ атаки» (отдельный ряд, в сумму продуктов не входит;
//            если фраза уже была в пуле продукта, она там отключается: is_active = false)
//   skip   — не по теме или релевантность не подтверждена — в пул не попадает
// Пул фиксированный: после --apply состав не меняется сам, новые фразы добавляются только повторным запуском.
//
// Запуск:
//   node scripts/demand-pool-from-gsc.js                 # только показать разметку (ничего не пишет)
//   node scripts/demand-pool-from-gsc.js --apply         # записать в reports.demand_phrases (source = 'gsc')
//   node scripts/demand-pool-from-gsc.js --from 2024-10-01 --min-impr 100
// Затем собрать Wordstat по новым фразам: node scripts/wordstat-product-demand.js (повторять раз в час,
// пока не скажет, что собирать нечего), после этого seasonality-index.js и seo-traffic-norm.js.

require('dotenv').config();
const DatabaseManager = require('../core/DatabaseManager');

const ATTACK_PRODUCT = 'Заказ атаки';
const PRODUCT_GROUPS = ['L3-4', 'L7', 'VDS/VPS', 'DS', 'Хостинг'];
const productName = group => (group === 'VDS/VPS' ? 'VDS' : group);

// Ручные решения по отдельным фразам: { 'фраза': 'ok' | 'attack' | 'skip' }
const OVERRIDES = {};

const OFFTOPIC = /пент[еэ]ст|пинтест|пин тест|пен тест|pentest|penetration|^ptes$|проникновен|поддержк|программ/i;
const PROTECT = /защит|защищ|protect|anti|анти/i;
const ATTACK_RULES = [
    /^(заказать|заказ|нанять|купить|сколько стоит|цена)\s+(ddos|ддос|дидос)/i,
    /^(ddos|ддос|дидос)[ -]?(атак|услуг|сервер)/i,
    /^(server|сервер)\s+(ddos|ддос)$/i,
    /^(ddos|ддос)\s+server$/i,
    /(^|\s)ez(\s|$)/i,
    /^(ddos|ддос)\s+сайт\S*\s+онлайн/i
];
const PROTECTION = /защит|защищ|ddos|ддос|anti|анти/i;
const RELEVANT = {
    'L3-4': p => /(^|\s)l[34](\s|$)|l3[ -]?l4|уровн/i.test(p) && PROTECTION.test(p),
    'L7': p => /защит|защищ|ddos|ддос|anti|анти|безопасност/i.test(p),
    'VDS/VPS': p => /vds|vps|виртуальн/i.test(p),
    'DS': p => /сервер|дедик|выделенн/i.test(p) && PROTECTION.test(p),
    'Хостинг': p => /хостинг|hosting/i.test(p) && PROTECTION.test(p)
};

/** Чистая функция: решение по фразе. group — группа Топвизора (L3-4 | L7 | VDS/VPS | DS | Хостинг). */
function classify(group, phrase) {
    const p = phrase.trim().toLowerCase();
    if (OVERRIDES[p]) return { decision: OVERRIDES[p], why: 'ручное решение' };
    if (OFFTOPIC.test(p)) return { decision: 'skip', why: 'не по теме' };
    if (!PROTECT.test(p) && ATTACK_RULES.some(r => r.test(p))) return { decision: 'attack', why: 'заказ атаки' };
    if (RELEVANT[group] && RELEVANT[group](p)) return { decision: 'ok', why: '' };
    return { decision: 'skip', why: 'релевантность продукту не подтверждена' };
}

const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : def;
};
const flag = name => process.argv.includes(`--${name}`);

const CANDIDATES_SQL = `
    WITH product_urls AS (
        SELECT cluster_topvisor_name AS product, url_norm
        FROM analytics.v_topvisor_group_target_urls
        WHERE project_name = 'ddos-guard.ru' AND cluster_topvisor_name = ANY($1)
    ),
    monthly AS (
        SELECT pu.product, sc.request, date_trunc('month', sc.event_date)::date AS month, SUM(sc.impressions) AS impr
        FROM gsc.search_console sc
        JOIN common.site_map sm ON sm.id = sc.target_url
        JOIN product_urls pu ON pu.url_norm = rtrim(lower(sm.url), '/')
        WHERE sc.event_date >= $2::date
          AND NOT EXISTS (SELECT 1 FROM common.brand_keywords bk WHERE sc.request ILIKE '%' || bk.keyword || '%')
        GROUP BY 1, 2, 3
    ),
    per_phrase AS (
        SELECT product, request, COUNT(*) AS months_seen, SUM(impr) AS impr_total
        FROM monthly GROUP BY 1, 2
    ),
    best AS (
        SELECT DISTINCT ON (request) * FROM per_phrase ORDER BY request, impr_total DESC
    )
    SELECT b.product, b.request, b.impr_total::int AS impr_total, b.months_seen::int AS months_seen,
           r.request_id,
           EXISTS (SELECT 1 FROM reports.demand_phrases dp WHERE dp.request_id = r.request_id AND dp.is_active) AS in_pool
    FROM best b
    LEFT JOIN common.requests r ON r.request = b.request
    WHERE b.impr_total >= $3
    ORDER BY b.product, b.impr_total DESC
`;

function printReport(rows) {
    for (const group of PRODUCT_GROUPS) {
        const part = rows.filter(r => r.product === group);
        if (!part.length) continue;
        const total = part.reduce((s, r) => s + r.impr_total, 0);
        console.log(`\n=== ${group} (в пул как «${productName(group)}») — кандидатов ${part.length}, показов ${total} ===`);
        for (const d of ['ok', 'attack', 'skip']) {
            const list = part.filter(r => r.decision === d);
            const sum = list.reduce((s, r) => s + r.impr_total, 0);
            const title = { ok: 'В ПУЛ ПРОДУКТА', attack: `В РЯД «${ATTACK_PRODUCT}»`, skip: 'ОТБРОШЕНЫ' }[d];
            console.log(`\n  ${title}: ${list.length} фраз, ${total ? Math.round(100 * sum / total) : 0}% показов`);
            const shown = d === 'skip' ? list.slice(0, 25) : list;
            for (const r of shown) {
                const note = [r.in_pool ? 'уже в пуле' : '', r.request_id ? '' : 'НЕТ В common.requests', d === 'skip' ? r.why : ''].filter(Boolean).join(', ');
                console.log(`    ${String(r.impr_total).padStart(6)}  ${r.request}${note ? `   [${note}]` : ''}`);
            }
            if (d === 'skip' && list.length > shown.length) console.log(`    … и ещё ${list.length - shown.length} (меньше показов)`);
        }
    }
}

async function apply(db, rows) {
    let added = 0, moved = 0, missing = 0;
    await db.query('BEGIN');
    try {
        for (const r of rows) {
            if (r.decision === 'skip') continue;
            if (!r.request_id) { missing++; continue; }
            const target = r.decision === 'attack' ? ATTACK_PRODUCT : productName(r.product);
            const ins = await db.query(
                `INSERT INTO reports.demand_phrases (request_id, product, topvisor_group, source)
                 VALUES ($1, $2, NULL, 'gsc') ON CONFLICT (request_id, product) DO NOTHING`, [r.request_id, target]);
            added += ins.rowCount;
            if (r.decision === 'attack') {
                // фраза «заказа атаки» не должна считаться спросом продукта: отключаем (история остаётся)
                const off = await db.query(
                    `UPDATE reports.demand_phrases SET is_active = false
                     WHERE request_id = $1 AND product <> $2 AND is_active`, [r.request_id, ATTACK_PRODUCT]);
                moved += off.rowCount;
            }
        }
        await db.query('COMMIT');
    } catch (e) {
        await db.query('ROLLBACK');
        throw e;
    }
    console.log(`\nЗаписано привязок фраза→продукт: ${added}; отключено в продуктах как «заказ атаки»: ${moved}; нет в common.requests (пропущены): ${missing}`);
    console.log('Дальше: node scripts/wordstat-product-demand.js (раз в час, пока не соберёт всё), затем seasonality-index.js --series demand и seo-traffic-norm.js');
}

async function main() {
    const from = arg('from', '2024-10-01');
    const minImpr = Number(arg('min-impr', 100));
    const db = new DatabaseManager('demand-pool-from-gsc');
    await db.connect();
    try {
        const res = await db.query(CANDIDATES_SQL, [PRODUCT_GROUPS, from, minImpr]);
        const rows = res.rows.map(r => ({ ...r, ...classify(r.product, r.request) }));
        printReport(rows);
        const cnt = d => rows.filter(r => r.decision === d).length;
        console.log(`\nИтого: в пул продуктов ${cnt('ok')}, в «${ATTACK_PRODUCT}» ${cnt('attack')}, отброшено ${cnt('skip')} (период с ${from}, показов от ${minImpr}).`);
        if (flag('apply')) await apply(db, rows);
        else console.log('(без --apply: в БД ничего не записано)');
    } finally {
        await db.disconnect();
    }
}

module.exports = { classify };

if (require.main === module) {
    main().catch(e => { console.error(e.message); process.exit(1); });
}
