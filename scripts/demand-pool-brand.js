// scripts/demand-pool-brand.js
// Ряд спроса по бренду («Бренд») — частотность Wordstat брендовых фраз из common.brand_keywords.
// Бренд держим ОТДЕЛЬНО от продуктов: продуктовый спрос показывает рынок, брендовый — узнаваемость.
// Фразы, которых нет в common.requests, добавляются туда (обязательное поле — только текст).
// Варианты написания, у которых Wordstat отдаёт одинаковые значения («ddos guard» / «ddos-guard»),
// после сбора отсекаются scripts/demand-pool-dedupe.js.
//
// Запуск:
//   node scripts/demand-pool-brand.js            # показать, что будет добавлено
//   node scripts/demand-pool-brand.js --apply
// Дальше: node scripts/wordstat-product-demand.js (соберёт частотность), node scripts/demand-pool-dedupe.js --apply,
//         node scripts/seasonality-index.js --series demand_Бренд --min-months 6, node scripts/seo-traffic-norm.js

require('dotenv').config();
const DatabaseManager = require('../core/DatabaseManager');

const BRAND_PRODUCT = 'Бренд';
const flag = name => process.argv.includes(`--${name}`);

async function main() {
    const db = new DatabaseManager('demand-pool-brand');
    await db.connect();
    try {
        const kw = (await db.query('SELECT DISTINCT lower(trim(keyword)) AS keyword FROM common.brand_keywords WHERE trim(keyword) <> \'\' ORDER BY 1')).rows.map(r => r.keyword);
        console.log(`Брендовых фраз в common.brand_keywords: ${kw.length}`);
        if (!flag('apply')) {
            kw.forEach(k => console.log(`  ${k}`));
            console.log('\n(без --apply: в БД ничего не записано)');
            return;
        }
        let created = 0, added = 0;
        await db.query('BEGIN');
        try {
            for (const k of kw) {
                const ins = await db.query('INSERT INTO common.requests (request) VALUES ($1) ON CONFLICT (request) DO NOTHING', [k]);
                created += ins.rowCount;
                const id = (await db.query('SELECT request_id FROM common.requests WHERE request = $1', [k])).rows[0].request_id;
                const dp = await db.query(
                    `INSERT INTO reports.demand_phrases (request_id, product, topvisor_group, source)
                     VALUES ($1, $2, NULL, 'brand') ON CONFLICT (request_id, product) DO NOTHING`, [id, BRAND_PRODUCT]);
                added += dp.rowCount;
            }
            await db.query('COMMIT');
        } catch (e) {
            await db.query('ROLLBACK');
            throw e;
        }
        console.log(`Новых фраз в common.requests: ${created}; привязано к «${BRAND_PRODUCT}»: ${added}`);
        console.log('Дальше: node scripts/wordstat-product-demand.js, затем node scripts/demand-pool-dedupe.js --apply');
    } finally {
        await db.disconnect();
    }
}

main().catch(e => { console.error(e.message); process.exit(1); });
