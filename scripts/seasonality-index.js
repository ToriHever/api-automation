// scripts/seasonality-index.js
// Сезонные индексы органического трафика (основа для «Нормы трафика SEO»).
//
// Данные берутся с 2024-09-16 (--from): с этой даты сайты ru и en разделены, более ранние
// данные несопоставимы.
// Метод: сезон = 12 месяцев подряд, начиная с первого полного месяца после --from
// (сейчас окт 2024 – сен 2025, окт 2025 – сен 2026 ...). База сезона = среднее по «общим»
// месяцам — тем, что есть (полные и не аномальные) во ВСЕХ учитываемых сезонах.
// Индекс месяца = значение месяца / база его сезона; одноимённые месяцы усредняются по
// сезонам. Месяц, которого нет в каком-то сезоне (например, ещё не наступил), получает
// индекс только по тем сезонам, где он есть (seasons_used меньше). Исключаются:
//   - неполные месяцы (текущий месяц, начало периода до --from, пропуски дней);
//   - сезоны, где меньше --min-months пригодных месяцев (по умолчанию 10);
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
//   node scripts/seasonality-index.js --from 2024-09-16 --min-months 10 --dry-run   # без записи в БД

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
const DEFAULT_FROM = '2024-09-16';   // дата разделения сайтов ru / en

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
function computeSeasonality(rows, events, { minMonths = 10 } = {}) {
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

    // 4. Сезоны: 12 месяцев подряд от первого полного месяца
    if (!complete.length) return { monthly: [], index: emptyIndex() };
    const okRows = complete.filter(r => !status.has(r.month));
    const m0 = monthIdx(complete[0].month);
    const seasonOf = r => Math.floor((monthIdx(r.month) - m0) / 12);
    const seasonLabel = k => {
        const idx = m0 + k * 12;
        return monthKey(Math.floor(idx / 12), (idx % 12) + 1).slice(0, 7);
    };

    const usableBySeason = new Map();
    for (const r of okRows) {
        const k = seasonOf(r);
        if (!usableBySeason.has(k)) usableBySeason.set(k, []);
        usableBySeason.get(k).push(r);
    }
    const included = [...usableBySeason.keys()].filter(k => usableBySeason.get(k).length >= minMonths);

    // Общие месяцы (номера 1..12), пригодные во всех учитываемых сезонах
    let common = null;
    for (const k of included) {
        const set = new Set(usableBySeason.get(k).map(r => parseMonth(r.month).m));
        common = common === null ? set : new Set([...common].filter(m => set.has(m)));
    }
    const baseBySeason = new Map();
    if (common && common.size) {
        for (const k of included) {
            const vals = usableBySeason.get(k).filter(r => common.has(parseMonth(r.month).m)).map(r => r.value);
            const b = mean(vals);
            if (b > 0) baseBySeason.set(k, b);
        }
    }

    // 5. Индексы месяцев и итоговое усреднение по сезонам
    const monthly = [];
    const byMonthNum = new Map();
    for (const r of rows) {
        const { m } = parseMonth(r.month);
        const st = status.get(r.month);
        const k = seasonOf(r);
        const base = baseBySeason.get(k) ?? null;
        let out;
        if (st) {
            out = { status: st.status, note: st.note, idx: null };
        } else if (base === null) {
            out = { status: 'incomplete_season', note: `сезон с ${seasonLabel(k)} не набрал ${minMonths} пригодных месяцев — не участвует в расчёте`, idx: null };
        } else {
            out = { status: 'used', note: null, idx: r.value / base };
            if (!byMonthNum.has(m)) byMonthNum.set(m, []);
            byMonthNum.get(m).push({ season: seasonLabel(k), idx: out.idx });
        }
        monthly.push({
            month: r.month, value: r.value, status: out.status, note: out.note,
            season: k >= 0 ? seasonLabel(k) : null,
            season_baseline: base, month_index: out.idx
        });
    }

    const index = [];
    for (let m = 1; m <= 12; m++) {
        const list = byMonthNum.get(m) || [];
        index.push({
            month_num: m,
            seasonal_index: list.length ? mean(list.map(x => x.idx)) : null,
            seasons_used: list.length,
            seasons_list: list.map(x => x.season).sort().join(',')
        });
    }
    return { monthly, index };
}

function emptyIndex() {
    return Array.from({ length: 12 }, (_, i) => ({ month_num: i + 1, seasonal_index: null, seasons_used: 0, seasons_list: '' }));
}

function daysInMonth(monthStr) {
    const { y, m } = parseMonth(monthStr);
    return new Date(y, m, 0).getDate();
}

async function loadRows(db, series, site, from) {
    const { source, channel } = SERIES[series];
    const values = await db.query(
        `SELECT to_char(date_trunc('month', event_date), 'YYYY-MM-DD') AS month, SUM(sessions)::bigint AS value
         FROM reports.traffic_daily WHERE source = $1 AND site = $2 AND channel = $3 AND event_date >= $4 GROUP BY 1`,
        [source, site, channel, from]
    );
    const cover = await db.query(
        `SELECT to_char(date_trunc('month', event_date), 'YYYY-MM-DD') AS month, COUNT(DISTINCT event_date)::int AS days
         FROM reports.traffic_daily WHERE source = $1 AND site = $2 AND event_date >= $3 GROUP BY 1 ORDER BY 1`,
        [source, site, from]
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

async function save(db, series, site, result, from) {
    await db.query('BEGIN');
    try {
        await db.query('DELETE FROM reports.seasonality_monthly WHERE series = $1 AND site = $2', [series, site]);
        await db.query('DELETE FROM reports.seasonality_index WHERE series = $1 AND site = $2', [series, site]);
        for (const r of result.monthly) {
            await db.query(
                `INSERT INTO reports.seasonality_monthly (series, site, month, value, status, note, season, season_baseline, month_index)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [series, site, r.month, r.value, r.status, r.note, r.season, r.season_baseline, r.month_index]
            );
        }
        const note = `Данные с ${from} (разделение ru/en). Сезоны по 12 мес., база = общие для всех сезонов полные месяцы; неполные месяцы и аномалии исключены`;
        for (const r of result.index) {
            await db.query(
                `INSERT INTO reports.seasonality_index (series, site, month_num, seasonal_index, seasons_used, seasons_list, method_note)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [series, site, r.month_num, r.seasonal_index, r.seasons_used, r.seasons_list, note]
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
    const skipped = [...new Set(result.monthly.filter(r => r.status === 'incomplete_season').map(r => r.season))];
    if (skipped.length) console.log(`Сезоны без достаточного набора (не участвуют): ${skipped.join(', ')}`);
    if (flagged.length) {
        console.log('Аномальные месяцы (исключены):');
        for (const r of flagged) console.log(`  ${r.month.slice(0, 7)}  ${r.value}  [${r.status}] ${r.note}`);
    }
    console.log('Индекс по месяцам (1.00 = среднемесячный):');
    console.log(result.index.map(r =>
        `  ${String(r.month_num).padStart(2)}: ${r.seasonal_index === null ? '  —  ' : r.seasonal_index.toFixed(2)}  (сезонов: ${r.seasons_used}${r.seasons_list ? ' ' + r.seasons_list : ''})`
    ).join('\n'));
    const weak = result.index.filter(r => r.seasons_used <= 1).map(r => r.month_num);
    if (weak.length) console.log(`⚠ Месяцы ${weak.join(', ')}: индекс по одному сезону (или нет данных) — разовое наблюдение, не среднее.`);
}

async function main() {
    const minMonths = Number(arg('min-months', 10));
    const from = arg('from', DEFAULT_FROM);
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
                const rows = await loadRows(db, series, site, from);
                if (!rows.length) { console.warn(`\n${series}/${site}: нет данных в reports.traffic_daily с ${from}`); continue; }
                if (rows.every(r => r.value === 0)) {
                    console.warn(`\n${series}/${site}: канал "${SERIES[series].channel}" не найден. Реальные каналы:`);
                    const ch = await db.query('SELECT DISTINCT channel FROM reports.traffic_daily WHERE source = $1 AND site = $2', [SERIES[series].source, site]);
                    console.warn('  ' + ch.rows.map(r => r.channel).join(' | '));
                    continue;
                }
                const events = ev.filter(e => !e.site || e.site === site);
                const result = computeSeasonality(rows, events, { minMonths });
                printResult(series, site, result);
                if (!dryRun) await save(db, series, site, result, from);
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
