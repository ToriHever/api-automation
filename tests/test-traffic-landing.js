// Тесты нормализации страниц входа и свёртки строк (чистые функции, без БД и API):
//   node tests/test-traffic-landing.js
const test = require('node:test');
const assert = require('node:assert');
const { normalizePage, mergeRows, monthsList } = require('../scripts/traffic-organic-landing.js');

test('нормализация: регистр, параметры, якорь, слэш на конце', () => {
    assert.strictEqual(normalizePage('ddos-guard.ru', '/Blog/Chto-Takoe-OSI/?utm_source=x#top'), 'https://ddos-guard.ru/blog/chto-takoe-osi');
    assert.strictEqual(normalizePage('ddos-guard.ru', '/web-protection/'), 'https://ddos-guard.ru/web-protection');
    assert.strictEqual(normalizePage('ddos-guard.ru', '/'), 'https://ddos-guard.ru');
    assert.strictEqual(normalizePage('ddos-guard.ru', 'https://ddos-guard.ru/L7?x=1'), 'https://ddos-guard.ru/l7');
});

test('нормализация: пустые значения — не страница', () => {
    assert.strictEqual(normalizePage('ddos-guard.ru', '(not set)'), null);
    assert.strictEqual(normalizePage('ddos-guard.ru', ''), null);
});

test('свёртка: варианты одной страницы суммируются', () => {
    const rows = [
        { month: '2026-09-01', page: 'https://ddos-guard.ru/blog/a', engine: 'Google', sessions: 3 },
        { month: '2026-09-01', page: 'https://ddos-guard.ru/blog/a', engine: 'Google', sessions: 4 },
        { month: '2026-09-01', page: 'https://ddos-guard.ru/blog/a', engine: 'Yandex', sessions: 1 }
    ];
    const m = mergeRows(rows);
    assert.strictEqual(m.length, 2);
    assert.strictEqual(m.find(r => r.engine === 'Google').sessions, 7);
});

test('месяцы: только полные, переход через год', () => {
    const l = monthsList('2025-11', new Date(Date.UTC(2026, 1, 10)));   // 10 февраля 2026
    assert.deepStrictEqual(l.map(x => x.month), ['2025-11-01', '2025-12-01', '2026-01-01']);
    assert.strictEqual(l[2].end, '2026-01-31');
    const j = monthsList('2025-12', new Date(Date.UTC(2026, 0, 5)));    // 5 января: последний полный — декабрь
    assert.deepStrictEqual(j.map(x => x.month), ['2025-12-01']);
    assert.strictEqual(monthsList('2026-02', new Date(Date.UTC(2026, 3, 1)))[1].end, '2026-03-31');
});
