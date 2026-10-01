// Тесты расчёта «Нормы трафика SEO» (чистые функции, без БД):
//   node tests/test-seo-norm.js
const test = require('node:test');
const assert = require('node:assert');
const { computeSeasonality } = require('../scripts/seasonality-index.js');
const { computeNorm } = require('../scripts/seo-traffic-norm.js');

const SHAPE = [1.1, 1.0, 1.0, 0.9, 0.95, 1.05, 1.0, 0.9, 0.85, 0.9, 1.1, 1.2];   // окт..сен
const dim = (y, m) => new Date(y, m, 0).getDate();

// 24 месяца, окт 2024 .. сен 2026; уровень (в день) своего сезона × форма сезона
function series(level1, level2, { partialLast = false } = {}) {
    const rows = [];
    for (let k = 0; k < 24; k++) {
        const idx = 9 + k;
        const y = 2024 + Math.floor(idx / 12), m = (idx % 12) + 1, d = dim(y, m);
        const pd = (k < 12 ? level1 : level2) * SHAPE[k % 12];
        rows.push({ month: `${y}-${String(m).padStart(2, '0')}-01`, value: Math.round(pd * d), perDay: pd, complete: true, days: d, daysTotal: d });
    }
    if (partialLast) {   // как loadRows: значение за 15 из 30 дней, perDay = value / дней в месяце
        const r = rows[23];
        r.complete = false; r.days = 15; r.value = Math.round(r.perDay * 15); r.perDay = r.value / r.daysTotal;
    }
    return rows;
}
const EXCLUDE_2026 = [{ month_from: '2026-04-01', month_to: '2026-09-01', action: 'exclude', description: 'падение' }];
const norm = (rows, events = []) => {
    const s = computeSeasonality(rows, events, { minMonths: 6 });
    return computeNorm(s.monthly, s.index, {});
};

test('ручное исключение не делает неполный месяц фактом', () => {
    const n = norm(series(100, 100, { partialLast: true }), EXCLUDE_2026);
    const sep = n.rows.find(r => r.month === '2026-09-01');
    assert.strictEqual(sep.actual_total, null);
    assert.strictEqual(sep.deviation_pct, null);
    assert.strictEqual(sep.status, 'no_actual');
});

test('уровень не тянется к базе старого сезона (тренд +15%)', () => {
    const n = norm(series(100, 115), EXCLUDE_2026);
    assert.ok(Math.abs(n.level - 115) < 1.5, `уровень ${n.level}, ожидалось ~115`);
});

test('индекс по одному сезону — норма не строится', () => {
    const n = norm(series(100, 100).slice(0, 12));
    assert.strictEqual(n.reliability.ok, false);
    assert.match(n.reliability.reason, /одному сезону/);
});

test('in_sample: месяцы расчёта помечены, исключённые аномалии — нет', () => {
    const n = norm(series(100, 100), EXCLUDE_2026);
    assert.strictEqual(n.rows.find(r => r.month === '2025-01-01').in_sample, true);
    assert.strictEqual(n.rows.find(r => r.month === '2026-06-01').in_sample, false);
});

test('падение вне обучающих месяцев видно как ниже нормы', () => {
    const rows = series(100, 100);
    for (const r of rows) if (r.month >= '2026-04-01') { r.perDay *= 0.6; r.value = Math.round(r.perDay * r.daysTotal); }
    const n = norm(rows, EXCLUDE_2026);
    const jun = n.rows.find(r => r.month === '2026-06-01');
    assert.strictEqual(jun.status, 'below_norm');
    assert.ok(jun.deviation_pct < -35 && jun.deviation_pct > -45, `откл. ${jun.deviation_pct}`);
});

test('коридор учитывает систематическое смещение (тренд), а не только разброс', () => {
    const flat = norm(series(100, 100), EXCLUDE_2026);
    const trend = norm(series(100, 115), EXCLUDE_2026);
    assert.ok(trend.band > flat.band);
});
