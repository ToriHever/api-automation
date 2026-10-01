// scripts/demand-pool-dedupe.js
// Убирает из пула спроса фразы-дубли. Wordstat не различает порядок слов и словоформы: «vds сервер»,
// «сервера vds», «сервер vds» отдают ОДНУ И ТУ ЖЕ частотность, и при суммировании по продукту она
// попадала бы в спрос несколько раз (дубли раздувают сумму и сдвигают её в сторону этих фраз).
//
// Дубль = внутри одного продукта у фразы побуквенно та же помесячная частотность, что у другой (сумма >= --min-total).
// Из группы дублей остаётся одна: сначала фраза из Топвизора, потом самая короткая. Остальные получают
// is_active = false (история в wordstat.dynamics_range не удаляется, отключение обратимо:
// UPDATE reports.demand_phrases SET is_active = true WHERE ...).
// После --apply пересчитайте индексы и норму: seasonality-index.js --series demand, seo-traffic-norm.js.
//
// Запуск:
//   node scripts/demand-pool-dedupe.js                 # показать дубли и концентрацию спроса, ничего не пишет
//   node scripts/demand-pool-dedupe.js --apply
//   node scripts/demand-pool-dedupe.js --min-total 100

require('dotenv').config();
const DatabaseManager = require('../core/DatabaseManager');

const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : def;
};
const flag = name => process.argv.includes(`--${name}`);

const SERIES_SQL = `
    SELECT dp.product, dp.request_id, dp.source, r.request,
           md5(string_agg(d.month::text || ':' || d.frequency::text, ',' ORDER BY d.month)) AS sig,
           SUM(d.frequency)::bigint AS total
    FROM reports.demand_phrases dp
    JOIN common.requests r ON r.request_id = dp.request_id
    JOIN wordstat.dynamics_range d ON d.request_id = dp.request_id
    WHERE dp.is_active
    GROUP BY dp.product, dp.request_id, dp.source, r.request
    HAVING SUM(d.frequency) >= $1
`;

// Последний полный месяц: доля фраз в спросе продукта (для контроля концентрации)
const SHARE_SQL = `
    SELECT dp.product, dp.request_id, r.request, d.frequency::bigint AS frequency
    FROM reports.demand_phrases dp
    JOIN common.requests r ON r.request_id = dp.request_id
    JOIN wordstat.dynamics_range d ON d.request_id = dp.request_id
    WHERE dp.is_active AND d.month = date_trunc('month', current_date - interval '1 month')::date
`;

/**
 * Чистая функция. rows: [{ product, request_id, source, request, sig, total }].
 * Возвращает { keep: [...], drop: [{...row, keptRequest}] }.
 */
function findDuplicates(rows) {
    const groups = new Map();
    for (const r of rows) {
        const key = `${r.product}\u0000${r.sig}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    }
    const keep = [], drop = [];
    for (const list of groups.values()) {
        list.sort((a, b) =>
            (b.source === 'topvisor') - (a.source === 'topvisor') ||
            a.request.length - b.request.length ||
            a.request_id - b.request_id);
        keep.push(list[0]);
        for (const r of list.slice(1)) drop.push({ ...r, keptRequest: list[0].request });
    }
    return { keep, drop };
}

async function main() {
    const minTotal = Number(arg('min-total', 50));
    const db = new DatabaseManager('demand-pool-dedupe');
    await db.connect();
    try {
        const rows = (await db.query(SERIES_SQL, [minTotal])).rows;
        const { drop } = findDuplicates(rows);

        const products = [...new Set(rows.map(r => r.product))].sort();
        for (const p of products) {
            const d = drop.filter(x => x.product === p);
            const total = rows.filter(r => r.product === p).length;
            console.log(`\n=== ${p}: фраз ${total}, дублей к отключению ${d.length} ===`);
            const byKept = new Map();
            for (const x of d) {
                if (!byKept.has(x.keptRequest)) byKept.set(x.keptRequest, []);
                byKept.get(x.keptRequest).push(x.request);
            }
            for (const [kept, list] of byKept) console.log(`  «${kept}» = ${list.map(x => `«${x}»`).join(', ')}`);
        }

        // Концентрация спроса после чистки: доля трёх крупнейших фраз в последнем полном месяце
        const dropIds = new Set(drop.map(x => `${x.product}:${x.request_id}`));
        const share = (await db.query(SHARE_SQL)).rows.filter(r => !dropIds.has(`${r.product}:${r.request_id}`));
        console.log('\nКонцентрация спроса (последний полный месяц, после чистки дублей):');
        for (const p of [...new Set(share.map(r => r.product))].sort()) {
            const list = share.filter(r => r.product === p).sort((a, b) => b.frequency - a.frequency);
            const sum = list.reduce((s, r) => s + Number(r.frequency), 0);
            const top = list.slice(0, 3).map(r => `«${r.request}» ${Math.round(100 * r.frequency / sum)}%`).join(', ');
            console.log(`  ${p}: фраз ${list.length}; крупнейшие: ${top}`);
        }
        console.log('  (если одна фраза даёт больше ~50% — спрос продукта фактически повторяет её динамику)');

        if (flag('apply')) {
            await db.query('BEGIN');
            try {
                for (const x of drop) {
                    await db.query('UPDATE reports.demand_phrases SET is_active = false WHERE request_id = $1 AND product = $2', [x.request_id, x.product]);
                }
                await db.query('COMMIT');
            } catch (e) {
                await db.query('ROLLBACK');
                throw e;
            }
            console.log(`\nОтключено дублей: ${drop.length}. Дальше: node scripts/seasonality-index.js --series demand --min-months 6 ; node scripts/seo-traffic-norm.js --dry-run`);
        } else {
            console.log(`\n(без --apply: в БД ничего не записано; к отключению ${drop.length} фраз)`);
        }
    } finally {
        await db.disconnect();
    }
}

module.exports = { findDuplicates };

if (require.main === module) {
    main().catch(e => { console.error(e.message); process.exit(1); });
}
