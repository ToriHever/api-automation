// Тесты расчёта KPI по покупкам (чистые функции, без БД):
//   node tests/test-purchases-kpi.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseCsv, parseNum, parseProducts, parseOverall, quarterRange, analyze, addMonths } = require('../scripts/purchases-kpi.js');

const DATA = path.join(__dirname, '../services/reports/data');
// CSV с покупками не хранятся в git: тесты на реальных данных пропускаются, если файлов нет
const HAS_DATA = fs.existsSync(path.join(DATA, 'organic_monthly_products.csv')) && fs.existsSync(path.join(DATA, 'organic_monthly_overall.csv'));

test('десятичная запятая и пустые значения', () => {
    assert.strictEqual(parseNum('1234,56'), 1234.56);
    assert.strictEqual(parseNum('"0,00"'.replace(/"/g, '')), 0);
    assert.strictEqual(parseNum(''), null);
    assert.throws(() => parseNum('abc'));
});

test('CSV: числа с запятой в кавычках не разрываются', () => {
    assert.deepStrictEqual(parseCsv('a,b\n1,"2,50"\n'), [['a', 'b'], ['1', '2,50']]);
});

test('реальная выгрузка: 5 групп × 30 месяцев, итог по сайту', { skip: !HAS_DATA }, () => {
    const rows = parseProducts(fs.readFileSync(path.join(DATA, 'organic_monthly_products.csv'), 'utf8'));
    assert.strictEqual(rows.length, 150);
    const r = rows.find(x => x.month === '2026-02' && x.product === 'L7');
    assert.strictEqual(r.payers, 35);
    assert.strictEqual(r.revenue, 603093.2);
    assert.ok(rows.some(x => x.product === 'Хостинг'), 'хостинг нормализован из «хостинг»');
    const ov = parseOverall(fs.readFileSync(path.join(DATA, 'organic_monthly_overall.csv'), 'utf8'));
    assert.strictEqual(ov.length, 33 - 3, 'месяцы 2024-01..03 без данных пропускаются');
    assert.strictEqual(ov.find(x => x.month === '2026-09').payersOrganic, 39);
});

test('постоянный ряд: диапазон суммы вырождается в точку, плательщиков — пуассоновский разброс', () => {
    const flat = Array(12).fill(10);
    const s = quarterRange(flat, 'sum');
    assert.strictEqual(s.low, 30); assert.strictEqual(s.high, 30);
    const c = quarterRange(flat, 'count');
    assert.strictEqual(c.mid, 30);
    assert.ok(c.low < 30 && c.high > 30, 'у счётчика всегда есть разброс (Пуассон)');
});

test('нижняя граница не уходит в минус', () => {
    const r = quarterRange([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5], 'count');
    assert.ok(r.low >= 0);
});

test('addMonths переходит через год', () => {
    assert.strictEqual(addMonths('2025-11', 3), '2026-02');
    assert.strictEqual(addMonths('2026-01', -1), '2025-12');
});

test('сигнал: два квартала подряд ниже границы', () => {
    // 24 месяца стабильных 10 плательщиков, затем два квартала по 0
    const rows = [];
    for (let i = 0; i < 24; i++) rows.push({ month: addMonths('2024-01', i), product: 'L7', payers: 10 + (i % 2), revenue: 100000 + (i % 2) * 1000, invoices: 10 });
    for (let i = 24; i < 30; i++) rows.push({ month: addMonths('2024-01', i), product: 'L7', payers: 0, revenue: 0, invoices: 0 });
    const an = analyze(rows, { lastMonth: '2026-06' });
    assert.strictEqual(an.groups['L7'].signal, 'два квартала подряд ниже границы');
});

test('реальные данные: KPI на 2026-Q4 для L7 и режимная пометка L3-4', { skip: !HAS_DATA }, () => {
    const rows = parseProducts(fs.readFileSync(path.join(DATA, 'organic_monthly_products.csv'), 'utf8'));
    const an = analyze(rows);
    assert.strictEqual(an.last, '2026-09');
    assert.strictEqual(an.groups['L7'].next.quarter, '2026-Q4');
    assert.ok(Math.abs(an.groups['L7'].next.payers.mid - 88) < 0.5, 'среднее за 4 квартала: (78+85+104+85)/4 = 88');
    assert.strictEqual(an.groups['L3-4'].reliability, 'regime');
    assert.strictEqual(an.groups['DS'].reliability, 'low_volume');
});

test('трафик по типу страницы: квартал со сбоем GA4 не берётся, плательщики складываются', () => {
    const { buildLandingBlock } = require('../scripts/purchases-kpi.js');
    const rows = [];
    for (const m of ['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12']) {
        rows.push({ month: m, grp: 'Информационные', sessions: 100 }, { month: m, grp: 'Главная', sessions: 50 },
                  { month: m, grp: 'L7', sessions: 5 }, { month: m, grp: 'Прочее', sessions: 1 });
    }
    const overall = ['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12'].map(month => ({ month, payersOrganic: 10 }));
    const b = buildLandingBlock(rows, overall, new Set(['2025-08']));
    assert.deepStrictEqual(b.quarters.map(q => q.q), ['2025-Q4'], 'III квартал со сбоем в августе исключён');
    assert.deepStrictEqual(b.quarters[0], { q: '2025-Q4', home: 150, prod: 15, info: 300, other: 3, payers: 30 });
});
