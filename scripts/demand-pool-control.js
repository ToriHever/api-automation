// scripts/demand-pool-control.js
// Контрольная корзина спроса: общие запросы, не связанные с DDoS-защитой. Нужна, чтобы отличить изменение спроса
// в нашей теме от общего эффекта (меньше поисков в Яндексе вообще, изменение учёта в Wordstat): если корзина упала
// так же, как продуктовые ряды, это не рынок защиты. Ряд называется «Контроль» (demand_Контроль) и в продукты не входит.
// Список фиксированный; фразы, которых нет в common.requests, добавляются туда (обязательное поле — только текст).
//
// Запуск:
//   node scripts/demand-pool-control.js            # показать список
//   node scripts/demand-pool-control.js --apply
// Дальше: node scripts/wordstat-product-demand.js (соберёт частотность), seasonality-index.js --series demand, seo-traffic-norm.js

require('dotenv').config();
const DatabaseManager = require('../core/DatabaseManager');

const CONTROL_PRODUCT = 'Контроль';
const PHRASES = [
    'погода', 'курс доллара', 'новости', 'авито', 'вайлдберриз', 'яндекс карты',
    'калькулятор', 'переводчик', 'расписание электричек', 'кинопоиск', 'озон', 'гороскоп'
];
const flag = name => process.argv.includes(`--${name}`);

async function main() {
    console.log(`Контрольных фраз: ${PHRASES.length}`);
    if (!flag('apply')) {
        PHRASES.forEach(p => console.log(`  ${p}`));
        console.log('\n(без --apply: в БД ничего не записано)');
        return;
    }
    const db = new DatabaseManager('demand-pool-control');
    await db.connect();
    try {
        let created = 0, added = 0;
        await db.query('BEGIN');
        try {
            for (const p of PHRASES) {
                const ins = await db.query('INSERT INTO common.requests (request) VALUES ($1) ON CONFLICT (request) DO NOTHING', [p]);
                created += ins.rowCount;
                const id = (await db.query('SELECT request_id FROM common.requests WHERE request = $1', [p])).rows[0].request_id;
                const dp = await db.query(
                    `INSERT INTO reports.demand_phrases (request_id, product, topvisor_group, source)
                     VALUES ($1, $2, NULL, 'control') ON CONFLICT (request_id, product) DO NOTHING`, [id, CONTROL_PRODUCT]);
                added += dp.rowCount;
            }
            await db.query('COMMIT');
        } catch (e) {
            await db.query('ROLLBACK');
            throw e;
        }
        console.log(`Новых фраз в common.requests: ${created}; привязано к «${CONTROL_PRODUCT}»: ${added}`);
        console.log('Дальше: node scripts/wordstat-product-demand.js, затем seasonality-index.js --series demand и seo-traffic-norm.js');
    } finally {
        await db.disconnect();
    }
}

main().catch(e => { console.error(e.message); process.exit(1); });
