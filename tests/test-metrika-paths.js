// Тесты разметки страниц входа и расчёта путей посетителей по визитам (чистые функции, без API):
//   node tests/test-metrika-paths.js
const test = require('node:test');
const assert = require('node:assert');
const { classifyUrl, analyze, GOAL } = require('../scripts/metrika-visit-paths.js');

test('тип страницы входа', () => {
    assert.strictEqual(classifyUrl('https://ddos-guard.ru/blog/chto-takoe-ddos'), 'Информационные');
    assert.strictEqual(classifyUrl('https://ddos-guard.ru/terms/general/bot'), 'Информационные');
    assert.strictEqual(classifyUrl('https://ddos-guard.ru/'), 'Главная');
    assert.strictEqual(classifyUrl('https://ddos-guard.ru'), 'Главная');
    assert.strictEqual(classifyUrl('https://ddos-guard.ru/web-protection?utm_source=x'), 'L7');
    assert.strictEqual(classifyUrl('https://ddos-guard.ru/network-protection'), 'L3-4');
    assert.strictEqual(classifyUrl('https://my.ddos-guard.net/auth/login'), 'ЛК');
    assert.strictEqual(classifyUrl('мусор'), 'Прочее');
});

const D = 86400000, T0 = Date.UTC(2026, 0, 1);
const v = (client, day, url, { isNew = false, goals = [], source = 'organic' } = {}) => ({ clientId: client, t: T0 + day * D, url, source, isNew, goals: new Set(goals) });

test('путь: блог → через неделю главная → регистрация → оплата', () => {
    const visits = [
        v('a', 0, 'https://ddos-guard.ru/blog/x', { isNew: true }),
        v('a', 7, 'https://ddos-guard.ru/', { goals: [GOAL.registration] }),
        v('a', 8, 'https://my.ddos-guard.net/x', { goals: [GOAL.purchase] }),
        v('b', 0, 'https://ddos-guard.ru/web-protection', { isNew: true }),
        v('c', 0, 'https://ddos-guard.ru/terms/x', { isNew: true }),
        v('z', 200, 'https://ddos-guard.ru/', { isNew: false })
    ];
    const r = analyze(visits);
    const info = r.cohort.find(([t]) => t === 'Информационные')[1];
    assert.strictEqual(info.n, 2); assert.strictEqual(info.reg, 1); assert.strictEqual(info.pay, 1);
    assert.strictEqual(r.registration.n, 1);
    assert.strictEqual(r.registration.medianVisits, 2);
    assert.strictEqual(r.registration.firstInfo, 1);
    assert.strictEqual(r.registration.hadInfo, 1);
    assert.strictEqual(r.purchase.medianVisits, 3);
});

test('окно 30 дней: недавние посетители в когорту не входят; цель вне окна не засчитывается', () => {
    const visits = [
        v('a', 0, 'https://ddos-guard.ru/blog/x', { isNew: true }),
        v('a', 60, 'https://ddos-guard.ru/', { goals: [GOAL.registration] }),    // через 60 дней — вне окна когорты
        v('late', 190, 'https://ddos-guard.ru/blog/y', { isNew: true })           // меньше 30 дней до конца выгрузки
    ];
    const r = analyze(visits);
    const info = r.cohort.find(([t]) => t === 'Информационные')[1];
    assert.strictEqual(info.n, 1); assert.strictEqual(info.reg, 0);
    assert.strictEqual(r.registration.n, 1, 'в сводке путей цель считается без окна');
});

test('--organic: первый визит не из органики пропускается', () => {
    const visits = [
        v('a', 0, 'https://ddos-guard.ru/blog/x', { isNew: true, source: 'direct', goals: [GOAL.registration] }),
        v('b', 0, 'https://ddos-guard.ru/blog/x', { isNew: true, source: 'organic', goals: [GOAL.registration] }),
        v('z', 100, 'https://ddos-guard.ru/', {})
    ];
    const r = analyze(visits, { organicOnly: true });
    assert.strictEqual(r.registration.n, 1);
    assert.strictEqual(r.cohort.find(([t]) => t === 'Информационные')[1].n, 1);
});
