// Месяцы для выгрузки клиентского пути: node tests/test-ga4-journey.js
const test = require('node:test');
const assert = require('node:assert');
const { monthsFrom } = require('../scripts/ga4-customer-journey.js');

test('месяцы с from по текущий; последний неполный до вчера', () => {
    const l = monthsFrom('2026-08', new Date(Date.UTC(2026, 9, 2)));   // 2 октября 2026
    assert.deepStrictEqual(l.map(x => x.key), ['2026-08', '2026-09', '2026-10']);
    assert.strictEqual(l[1].end, '2026-09-30');
    assert.strictEqual(l[2].end, '2026-10-01');
});

test('1 января: вчера — прошлый год', () => {
    const l = monthsFrom('2025-12', new Date(Date.UTC(2026, 0, 1)));
    assert.deepStrictEqual(l.map(x => x.key), ['2025-12']);
    assert.strictEqual(l[0].end, '2025-12-31');
});
