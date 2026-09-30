// scripts/seo-traffic-norm.js
// «Норма трафика SEO» (и спроса) по месяцам на основе сезонных индексов.
//   норма в день = уровень × сезонный индекс месяца;   норма за месяц = норма в день × число дней
//   уровень      = среднее по последним N пригодных месяцам (значение в день / сезонный индекс)
//   коридор      = ± max(10%, 2 сигмы) разброса пригодных месяцев вокруг нормы
// Пригодные месяцы и индексы берутся из reports.seasonality_monthly / seasonality_index —
// поэтому СНАЧАЛА пересчитайте индексы (node scripts/seasonality-index.js), если менялся список
// аномалий reports.seasonality_events. Аномальные месяцы в уровень не входят, но сравниваются
// с нормой (отклонение по ним — как раз то, что нужно в отчёте).
// Результат: reports.seo_traffic_norm (схема — services/reports/norm_schema.sql, создаётся сама).
//
// Запуск:
//   node scripts/seo-traffic-norm.js                          # все ряды, оба сайта
//   node scripts/seo-traffic-norm.js --series seo_traffic_ga4 --site ru
//   node scripts/seo-traffic-norm.js --level-months 6 --horizon 12 --dry-run

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const DatabaseManager = require('../core/DatabaseManager');

const SCHEMA_FILES = ['schema.sql', 'seasonality_schema.sql', 'norm_schema.sql']
    .map(f => path.join(__dirname, '..', 'services', 'reports', f));

const MIN_BAND = 0.10;   // допуск не меньше ±10%
const BAND_SIGMAS = 2;

const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : def;
};
const flag = name => process.argv.includes(`--${name}`);

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const std = a => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const monthKey = (y, m) => `${y}-${String(m).padStart(2, '0')}-01`;
const parseMonth = s => ({ y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)) });
const daysIn = s => { const { y, m } = parseMonth(s); return new Date(y, m, 0).getDate(); };
const addMonths = (s, n) => {
    const { y, m } = parseMonth(s);
    const idx = y * 12 + (m - 1) + n;
    return monthKey(Math.floor(idx / 12), (idx % 12) + 1);
};

/**
 * Чистая функция (без БД).
 * monthly: [{ month:'YYYY-MM-01', value, value_per_day, status }]   (reports.seasonality_monthly)
 * index:   [{ month_num, seasonal_index, seasons_used }]           (reports.seasonality_index)
 * fallbackIndex: индекс того же сайта из другого источника (Метрика для GA4) — только для месяцев,
 *          по которым у основного ряда нет ни одного пригодного наблюдения (например, сбой GA4).
 */
function computeNorm(monthly, index, { levelMonths = 12, horizon = 12, fallbackIndex = [] } = {}) {
    const toMap = arr => new Map(arr.map(r => [Number(r.month_num), {
        seasonal_index: r.seasonal_index === null ? null : Number(r.seasonal_index),
        seasons_used: Number(r.seasons_used)
    }]));
    const idx = toMap(index);
    const fb = toMap(fallbackIndex);
    const idxOf = month => {
        const m = parseMonth(month).m;
        const p = idx.get(m);
        if (p && p.seasonal_index > 0) return { ...p, fallback: false };
        const f = fb.get(m);
        if (f && f.seasonal_index > 0) return { ...f, fallback: true };
        return p ? { ...p, fallback: false } : null;
    };
    const rows = [...monthly].sort((a, b) => a.month.localeCompare(b.month));

    const used = rows.filter(r => r.status === 'used' && idxOf(r.month) && idxOf(r.month).seasonal_index > 0);
    if (!used.length) return null;

    const ref = used.slice(-levelMonths);
    const level = mean(ref.map(r => Number(r.value_per_day) / idxOf(r.month).seasonal_index));

    // Разброс пригодных месяцев вокруг нормы -> коридор
    const resid = used.map(r => Number(r.value_per_day) / (level * idxOf(r.month).seasonal_index) - 1);
    const band = Math.max(MIN_BAND, BAND_SIGMAS * std(resid));

    const excluded = rows.filter(r => r.status.startsWith('anomaly')).length;
    const basis = `уровень ${level.toFixed(1)}/день по ${ref.length} пригодным мес. (${ref[0].month.slice(0, 7)}…${ref[ref.length - 1].month.slice(0, 7)}), коридор ±${(band * 100).toFixed(0)}%, аномальных месяцев исключено: ${excluded}`;

    const build = (month, actualRow, isForecast) => {
        const ix = idxOf(month);
        const days = daysIn(month);
        const hasIndex = ix && ix.seasonal_index > 0;
        const expPd = hasIndex ? level * ix.seasonal_index : null;
        const actualOk = actualRow && actualRow.status !== 'incomplete_month';
        const actualPd = actualOk ? Number(actualRow.value_per_day) : null;
        const dev = (actualOk && expPd) ? (actualPd / expPd - 1) : null;
        let status;
        if (!hasIndex) status = 'no_norm';
        else if (isForecast) status = 'forecast';
        else if (!actualOk) status = 'no_actual';
        else status = Math.abs(dev) <= band ? 'in_norm' : (dev < 0 ? 'below_norm' : 'above_norm');
        return {
            month, is_forecast: isForecast || !actualOk, days_in_month: days,
            level_per_day: level,
            seasonal_index: hasIndex ? ix.seasonal_index : null,
            seasons_used: ix ? ix.seasons_used : 0,
            confidence: !hasIndex ? 'none' : (ix.fallback ? 'fallback' : (ix.seasons_used >= 2 ? 'normal' : 'low')),
            expected_per_day: expPd,
            expected_total: expPd ? Math.round(expPd * days) : null,
            band_pct: band * 100,
            expected_low: expPd ? Math.round(expPd * (1 - band) * days) : null,
            expected_high: expPd ? Math.round(expPd * (1 + band) * days) : null,
            actual_total: actualOk ? Number(actualRow.value) : null,
            actual_per_day: actualPd,
            deviation_pct: dev === null ? null : dev * 100,
            status, basis
        };
    };

    const out = rows.map(r => build(r.month, r, false));
    const last = rows[rows.length - 1].month;
    for (let i = 1; i <= horizon; i++) out.push(build(addMonths(last, i), null, true));
    const nFallback = out.filter(r => r.confidence === 'fallback').length;
    const fullBasis = basis + (nFallback ? `; индекс из другого источника (Метрика) для ${nFallback} мес., где у основного ряда нет пригодных наблюдений` : '');
    out.forEach(r => { r.basis = fullBasis; });
    return { level, band, rows: out, basis: fullBasis };
}

async function loadSeries(db, seriesFilter, siteFilter) {
    const params = [];
    let where = '';
    if (seriesFilter) { params.push(seriesFilter); where += ` AND series = $${params.length}`; }
    if (siteFilter) { params.push(siteFilter); where += ` AND site = $${params.length}`; }
    const res = await db.query(`SELECT DISTINCT series, site FROM reports.seasonality_index WHERE true ${where} ORDER BY 1, 2`, params);
    return res.rows;
}

async function save(db, series, site, result) {
    await db.query('BEGIN');
    try {
        await db.query('DELETE FROM reports.seo_traffic_norm WHERE series = $1 AND site = $2', [series, site]);
        for (const r of result.rows) {
            await db.query(
                `INSERT INTO reports.seo_traffic_norm
                 (series, site, month, is_forecast, days_in_month, level_per_day, seasonal_index, seasons_used, confidence,
                  expected_per_day, expected_total, band_pct, expected_low, expected_high,
                  actual_total, actual_per_day, deviation_pct, status, basis)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
                [series, site, r.month, r.is_forecast, r.days_in_month, r.level_per_day, r.seasonal_index, r.seasons_used, r.confidence,
                    r.expected_per_day, r.expected_total, r.band_pct, r.expected_low, r.expected_high,
                    r.actual_total, r.actual_per_day, r.deviation_pct, r.status, r.basis]
            );
        }
        await db.query('COMMIT');
    } catch (e) {
        await db.query('ROLLBACK');
        throw e;
    }
}

function printResult(series, site, result) {
    console.log(`\n=== ${series} / ${site} ===`);
    console.log(result.basis);
    console.log('Месяц    факт      норма   (коридор)          откл.   статус');
    for (const r of result.rows.filter(x => !x.is_forecast || x.status === 'no_norm').slice(-14)) {
        console.log(`${r.month.slice(0, 7)}  ${String(r.actual_total ?? '—').padStart(7)}  ${String(r.expected_total ?? '—').padStart(7)}  (${r.expected_low ?? '—'}–${r.expected_high ?? '—'})`.padEnd(52)
            + `${r.deviation_pct === null ? '   —' : (r.deviation_pct > 0 ? '+' : '') + r.deviation_pct.toFixed(0) + '%'}`.padStart(7) + `   ${r.status}${r.confidence === 'low' ? ' (низкая уверенность: 1 сезон)' : ''}${r.confidence === 'fallback' ? ' (индекс из Метрики)' : ''}`);
    }
    const fut = result.rows.filter(x => x.status === 'forecast').slice(0, 3);
    if (fut.length) console.log('Ближайшие месяцы, норма: ' + fut.map(r => `${r.month.slice(0, 7)} ${r.expected_total}`).join(', '));
}

async function main() {
    const levelMonths = Number(arg('level-months', 12));
    const horizon = Number(arg('horizon', 12));
    const dryRun = flag('dry-run');

    const db = new DatabaseManager('seo-traffic-norm');
    await db.connect();
    try {
        for (const f of SCHEMA_FILES) await db.query(fs.readFileSync(f, 'utf8'));
        const list = await loadSeries(db, arg('series'), arg('site'));
        if (!list.length) console.warn('Нет рядов в reports.seasonality_index — сначала node scripts/seasonality-index.js');

        for (const { series, site } of list) {
            const monthly = (await db.query(
                `SELECT to_char(month, 'YYYY-MM-DD') AS month, value, value_per_day, status
                 FROM reports.seasonality_monthly WHERE series = $1 AND site = $2 ORDER BY month`, [series, site])).rows;
            const index = (await db.query(
                `SELECT month_num, seasonal_index, seasons_used FROM reports.seasonality_index WHERE series = $1 AND site = $2`, [series, site])).rows;
            // Для рядов GA4 запасной индекс — тот же ряд по Метрике (seo_traffic_ga4_google -> seo_traffic_metrika_google)
            const fbSeries = series.startsWith('seo_traffic_ga4') ? series.replace('seo_traffic_ga4', 'seo_traffic_metrika') : null;
            const fallbackIndex = fbSeries ? (await db.query(
                `SELECT month_num, seasonal_index, seasons_used FROM reports.seasonality_index WHERE series = $1 AND site = $2`, [fbSeries, site])).rows : [];
            const result = computeNorm(monthly, index, { levelMonths, horizon, fallbackIndex });
            if (!result) { console.warn(`\n${series}/${site}: нет пригодных месяцев для уровня — норма не строится`); continue; }
            printResult(series, site, result);
            if (!dryRun) await save(db, series, site, result);
        }
        if (dryRun) console.log('\n(dry-run: в БД ничего не записано)');
    } finally {
        await db.disconnect();
    }
}

module.exports = { computeNorm, main };

if (require.main === module) {
    main().catch(e => { console.error(e.message); process.exit(1); });
}
