// scripts/gsc-segments-monthly.js
// Состав Google-трафика ddos-guard.ru по сегментам (бренд / продукты / информационные / прочее)
// по месяцам из gsc.search_console -> reports.gsc_segment_monthly. Нужен как «состав» рядом с
// нормой трафика (scripts/seo-traffic-norm.js): показывает, за счёт чего растёт/падает органика.
// Данные GSC полноценны только с 2025-09 (до этого в базе неполный набор), поэтому по умолчанию
// --from 2025-09-01. Пересчёт идемпотентен: месяцы с даты --from удаляются и считаются заново.
//
// Запуск:
//   node scripts/gsc-segments-monthly.js
//   node scripts/gsc-segments-monthly.js --from 2025-09-01

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const DatabaseManager = require('../core/DatabaseManager');

const REPORTS = path.join(__dirname, '..', 'services', 'reports');

const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : def;
};

async function main() {
    const from = arg('from', '2025-09-01');
    const db = new DatabaseManager('gsc-segments-monthly');
    await db.connect();
    try {
        await db.query(fs.readFileSync(path.join(REPORTS, 'gsc_segments_schema.sql'), 'utf8'));
        await db.query('BEGIN');
        try {
            await db.query('DELETE FROM reports.gsc_segment_monthly WHERE month >= date_trunc(\'month\', $1::date)', [from]);
            const ins = await db.query(fs.readFileSync(path.join(REPORTS, 'gsc_segments_load.sql'), 'utf8'), [from]);
            await db.query('COMMIT');
            console.log(`reports.gsc_segment_monthly: записано строк ${ins.rowCount} (с ${from})`);
        } catch (e) {
            await db.query('ROLLBACK');
            throw e;
        }

        const res = await db.query(
            `SELECT to_char(month, 'YYYY-MM') AS m, segment, clicks_per_day, clicks_share_pct, avg_position, days_with_data, days_in_month
             FROM reports.v_gsc_segment_share WHERE month >= date_trunc('month', $1::date) ORDER BY month, segment`, [from]);
        console.log('\nВсе месяцы (клики в день, доля, позиция):');
        for (const r of res.rows) {
            const partial = r.days_with_data < r.days_in_month ? `  ⚠ данные за ${r.days_with_data} из ${r.days_in_month} дней` : '';
            console.log(`  ${r.m}  ${String(r.segment).padEnd(14)} ${String(r.clicks_per_day).padStart(6)}/день  ${String(r.clicks_share_pct).padStart(5)}%  поз. ${r.avg_position}${partial}`);
        }
    } finally {
        await db.disconnect();
    }
}

main().catch(e => { console.error(e.message); process.exit(1); });
