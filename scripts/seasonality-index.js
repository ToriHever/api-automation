// scripts/seasonality-index.js
// Сезонные индексы органического трафика (основа для «Нормы трафика SEO»).
//
// Метод: индекс месяца = значение месяца / среднемесячное за календарный год;
// индексы одного и того же месяца усредняются по годам. Исключаются из расчёта:
//   - неполные месяцы (текущий месяц, месяцы с пропусками дней в traffic_daily);
//   - годы, где нет 12 полных месяцев (порог --min-months);
//   - аномальные месяцы: автоматически (отклонение от медианы соседних месяцев) и
//     по ручному списку reports.seasonality_events (exclude/keep).
// Источник: reports.traffic_daily (см. scripts/traffic-history-36m.js).
// Ряды: seo_traffic_ga4 (основной, канал Organic Search) и seo_traffic_metrika
// (для сверки, «Переходы из поисковых систем»).
// Результат: reports.seasonality_monthly и reports.seasonality_index (схема —
// services/reports/seasonality_schema.sql, создаётся автоматически).
//
// Запуск:
//   node scripts/seasonality-index.js
//   node scripts/seasonality-index.js --series seo_traffic_ga4 --site ru
//   node scripts/seasonality-index.js --min-months 12 --dry-run   # без записи в БД

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const DatabaseManager = require('../core/DatabaseManager');

const SCHEMA_FILES = ['schema.sql', 'seasonality_schema.sql']
    .map(f => path.join(__dirname, '..', 'services', 'reports', f));

const SERIES = {
    seo_traffic_ga4: { source: 'ga4', channel: 'Organic Search' },
    seo_traffic_metrika: { source: 'metrika', channel: 'Переходы из поисковых систем' }
};

// Параметры автоопределения аномалий
const MAD_K = 3.5;      // порог в «робастных сигмах»
const MIN_DEV = 0.30;   // минимальное отклонение в ln (~ +35% / −26%) — мельче не считаем аномалией
const NEIGHBORS = 2;    // сколько полных месяцев с каждой стороны берём для сравнения

const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : def;
};
const flag = name => process.argv.includes(`--${name}`);

const median = a => {
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

const monthKey = (y, m) => `${y}-${String(m).padStart(2, '0')}-01`;
const parseMonth = s => ({ y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)) });
const monthIdx = s => { const { y, m } = parseMonth(s); return y * 12 + m - 1; };

/**
 * Чистая функция расчёта (без БД — чтобы тестировать отдельно).
 * rows:   [{ month: 'YYYY-MM-01', value: number, complete: boolean }]
 * events: [{ month_from, month_to, action: 'exclude'|'keep', description }] — уже отфильтрованы по сайту
 */
function computeSeasonality(rows, events, { minMonths = 12 } = {}) {
    const byIdx = new Map(rows.map(r => [monthIdx(r.month), r]));
    const status = new Map();   // month -> { status, note }

    // 1. Полнота месяцев
    for (const r of rows) {
        if (!r.complete) status.set(r.month, { status: 'incomplete_month', note: 'месяц неполный (текущий или есть пропуски дней)' });
    }

    // 2. Авто-аномалии: отклонение от медианы соседних полных месяцев
    const complete = rows.filter(r => r.complete);
    const devs = [];
    for (const r of complete) {
        const i = monthIdx(r.month);
        const neigh = [];
        for (let d = 1; d <= NEIGHBORS; d++) {
            for (const j of [i - d, i + d]) {
                const n = byIdx.get(j);
                if (n && n.complete) neigh.push(n.value);
            }
        }
        if (neigh.length < 2) continue;
        const base = median(neigh);
        if (base <= 0) continue;
        if (r.value === 0) { devs.push({ month: r.month, d: -Infinity }); continue; }
        devs.push({ month: r.month, d: Math.log(r.value / base) });
    }
    const finite = devs.filter(x => Number.isFinite(x.d)).map(x => x.d);
    if (finite.length >= 4) {
        const med = median(finite);
        const mad = median(finite.map(d => Math.abs(d - med)));
        const thr = Math.max(MIN_DEV, MAD_K * 1.4826 * mad);
        for (const x of devs) {
            if (!Number.isFinite(x.d) || Math.abs(x.d - med) > thr) {
                const pct = Number.isFinite(x.d) ? `${Math.round((Math.exp(x.d) - 1) * 100)}%` : 'нулевой трафик';
                status.set(x.month, { status: 'anomaly_auto', note: `отклонение от соседних месяцев: ${pct}` });
            }
        }
    }

    // 3. Ручные события: exclude добавляет аномалию, keep снимает авто-флаг
    for (const r of rows) {
        const i = monthIdx(r.month);
        for (const e of events) {
            if (i >= monthIdx(e.month_from) && i <= monthIdx(e.month_to)) {
                if (e.action === 'exclude') status.set(r.month, { status: 'anomaly_manual', note: e.description || 'ручной список' });
                else if (status.get(r.month)?.status === 'anomaly_auto') status.delete(r.month);
            }
        }
    }

    // 4. Годы с полным набором (>= minMonths полных месяцев) и их базы
    const completeByYear = new Map();
    for (const r of complete) {
        const y = parseMonth(r.month).y;
        if (!completeByYear.has(y)) completeByYear.set(y, []);
        completeByYear.get(y).push(r);
    }
    const yearBase = new Map();
    for (const [y, list] of completeByYear) {
        if (list.length < minMonths) continue;
        const ok = list.filter(r => !status.has(r.month));
        if (ok.length) yearBase.set(y, mean(ok.map(r => r.value)));
    }

    // 5. Индексы месяцев и итоговое усреднение по годам
    const monthly = [];
    const byMonthNum = new Map();
    for (const r of rows) {
        const { y, m } = parseMonth(r.month);
        let st = status.get(r.month);
        const base = yearBase.get(y) ?? null;
        if (!st && base === null) {
            st = { status: 'incomplete_year', note: `в ${y} году меньше ${minMonths} полных месяцев — год не участвует в расчёте` };
        }
        const used = !st && base > 0;
        const idx = used ? r.value / base : null;
        monthly.push({
            month: r.month, value: r.value,
            status: used ? 'used' : (st ? st.status : 'incomplete_year'),
            note: used ? null : (st ? st.note : null),
            year_baseline: base, month_index: idx
        });
        if (used) {
            if (!byMonthNum.has(m)) byMonthNum.set(m, []);
            byMonthNum.get(m).push({ y, idx });
        }
    }

    const index = [];
    for (let m = 1; m <= 12; m++) {
        const list = byMonthNum.get(m) || [];
        index.push({
            month_num: m,
            seasonal_index: list.length ? mean(list.map(x => x.idx)) : null,
            years_used: list.length,
            years_list: list.map(x => x.y).sort().join(',')
        });
    }
    return { monthly, index };
}

function daysInMonth(monthStr) {
    const { y, m } = parseMonth(monthStr);
    return new Date(y, m, 0).getDate();
}

async function loadRows(db, series, site) {
    const { source, channel } = SERIES[series];
    const values = await db.query(
        `SELECT to_char(date_trunc('month', event_date), 'YYYY-MM-DD') AS month, SUM(sessions)::bigint AS value
         FROM reports.traffic_daily WHERE source = $1 AND site = $2 AND channel = $3 GROUP BY 1`,
        [source, site, channel]
    );
    const cover = await db.query(
        `SELECT to_char(date_trunc('month', event_date), 'YYYY-MM-DD') AS month, COUNT(DISTINCT event_date)::int AS days
         FROM reports.traffic_daily WHERE source = $1 AND site = $2 GROUP BY 1 ORDER BY 1`,
        [source, site]
    );
    const val = new Map(values.rows.map(r => [r.month, Number(r.value)]));
    const now = new Date();
    const currentMonth = monthKey(now.getFullYear(), now.getMonth() + 1);
    return cover.rows.map(c => ({
        month: c.month,
        value: val.get(c.month) || 0,
        complete: c.month < currentMonth && c.days === daysInMonth(c.month)
    }));
}

async function save(db, series, site, result) {
    await db.query('BEGIN');
    try {
        await db.query('DELETE FROM reports.seasonality_monthly WHERE series = $1 AND site = $2', [series, site]);
        await db.query('DELETE FROM reports.seasonality_index WHERE series = $1 AND site = $2', [series, site]);
        for (const r of result.monthly) {
            await db.query(
                `INSERT INTO reports.seasonality_monthly (series, site, month, value, status, note, year_baseline, month_index)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [series, site, r.month, r.value, r.status, r.note, r.year_baseline, r.month_index]
            );
        }
        const note = 'Только полные годы (12 полных месяцев) и полные месяцы; текущий неполный месяц и аномалии исключены';
        for (const r of result.index) {
            await db.query(
                `INSERT INTO reports.seasonality_index (series, site, month_num, seasonal_index, years_used, years_list, method_note)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [series, site, r.month_num, r.seasonal_index, r.years_used, r.years_list, note]
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
    const flagged = result.monthly.filter(r => r.status.startsWith('anomaly'));
    const skippedYears = [...new Set(result.monthly.filter(r => r.status === 'incomplete_year').map(r => r.month.slice(0, 4)))];
    if (skippedYears.length) console.log(`Годы без полного набора (не участвуют): ${skippedYears.join(', ')}`);
    if (flagged.length) {
        console.log('Аномальные месяцы (исключены):');
        for (const r of flagged) console.log(`  ${r.month.slice(0, 7)}  ${r.value}  [${r.status}] ${r.note}`);
    }
    console.log('Индекс по месяцам (1.00 = среднемесячный):');
    console.log(result.index.map(r =>
        `  ${String(r.month_num).padStart(2)}: ${r.seasonal_index === null ? '  —  ' : r.seasonal_index.toFixed(2)}  (лет: ${r.years_used}${r.years_list ? ' ' + r.years_list : ''})`
    ).join('\n'));
    const minYears = Math.min(...result.index.map(r => r.years_used));
    if (minYears <= 1) console.log('⚠ Индекс посчитан по одному году или менее — это разовое наблюдение, а не среднее. Пользоваться осторожно.');
}

async function main() {
    const minMonths = Number(arg('min-months', 12));
    const seriesList = arg('series') ? [arg('series')] : Object.keys(SERIES);
    const sites = arg('site') ? [arg('site')] : ['ru', 'en'];
    const dryRun = flag('dry-run');

    const db = new DatabaseManager('seasonality-index');
    await db.connect();
    try {
        for (const f of SCHEMA_FILES) await db.query(fs.readFileSync(f, 'utf8'));
        const ev = (await db.query(
            `SELECT site, to_char(month_from,'YYYY-MM-DD') AS month_from, to_char(month_to,'YYYY-MM-DD') AS month_to, action, description
             FROM reports.seasonality_events`)).rows;

        for (const series of seriesList) {
            for (const site of sites) {
                const rows = await loadRows(db, series, site);
                if (!rows.length) { console.warn(`\n${series}/${site}: нет данных в reports.traffic_daily`); continue; }
                if (rows.every(r => r.value === 0)) {
                    console.warn(`\n${series}/${site}: канал "${SERIES[series].channel}" не найден. Реальные каналы:`);
                    const ch = await db.query('SELECT DISTINCT channel FROM reports.traffic_daily WHERE source = $1 AND site = $2', [SERIES[series].source, site]);
                    console.warn('  ' + ch.rows.map(r => r.channel).join(' | '));
                    continue;
                }
                const events = ev.filter(e => !e.site || e.site === site);
                const result = computeSeasonality(rows, events, { minMonths });
                printResult(series, site, result);
                if (!dryRun) await save(db, series, site, result);
            }
        }
        if (dryRun) console.log('\n(dry-run: в БД ничего не записано)');
    } finally {
        await db.disconnect();
    }
}

module.exports = { computeSeasonality };

if (require.main === module) {
    main().catch(e => { console.error(e.message); process.exit(1); });
}
