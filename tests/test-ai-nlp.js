// Тесты чистых функций AI-сервиса (без БД и без обращений к API):
//   node tests/test-ai-nlp.js
const test = require('node:test');
const assert = require('node:assert');
const { extractJson, estimateTokens } = require('../services/ai-nlp/YandexAiClient');
const { normalizeUrl, clusterBySerp, cosine, centroid, nearestCentroid, parseArgs } = require('../services/ai-nlp/lib');
const { sanitize: sanitizeIntent } = require('../scripts/ai-classify-requests.js');
const { sanitize: sanitizeSnippet } = require('../scripts/ai-analyze-snippets.js');

test('extractJson: чистый массив, ```-ограждение и текст вокруг', () => {
    assert.deepStrictEqual(extractJson('[{"i":1}]'), [{ i: 1 }]);
    assert.deepStrictEqual(extractJson('```json\n[{"i":1,"x":"a"}]\n```'), [{ i: 1, x: 'a' }]);
    assert.deepStrictEqual(extractJson('Вот ответ: {"summary":"ок"} Готово.'), { summary: 'ок' });
    assert.strictEqual(extractJson('просто текст'), null);
    assert.strictEqual(extractJson('[{"i":1,'), null);
});

test('normalizeUrl: схема, www, query, fragment, хвостовой слеш', () => {
    assert.strictEqual(normalizeUrl('https://www.Example.com/path/?a=1#x'), 'example.com/path');
    assert.strictEqual(normalizeUrl('http://example.com/path'), 'example.com/path');
});

test('clusterBySerp: объединяет по ≥ minShared общих URL, голова — самый тяжёлый', () => {
    const urls = (...u) => new Set(u);
    const items = [
        { id: 1, weight: 100, urls: urls('a', 'b', 'c', 'd', 'e') },
        { id: 2, weight: 50, urls: urls('a', 'b', 'c', 'd', 'x') },   // 4 общих с 1
        { id: 3, weight: 80, urls: urls('a', 'b', 'y', 'z', 'w') },   // 2 общих с 1 -> отдельно
        { id: 4, weight: 10, urls: urls('q', 'r', 's', 't', 'u') }
    ];
    const clusters = clusterBySerp(items, 4);
    assert.strictEqual(clusters.length, 3);
    assert.strictEqual(clusters[0].headId, 1);
    assert.deepStrictEqual(clusters[0].members.map(m => m.id), [1, 2]);
    assert.strictEqual(clusters[0].members[1].shared, 4);
    assert.deepStrictEqual(clusters.map(c => c.headId).sort(), [1, 3, 4]);
});

test('clusterBySerp: сравнивает с головой, а не цепочкой', () => {
    // 2 делит 4 URL с 1, 3 делит 4 URL с 2, но только 2 с 1 -> 3 в кластер 1 не попадает
    const items = [
        { id: 1, weight: 3, urls: new Set(['a', 'b', 'c', 'd', 'e']) },
        { id: 2, weight: 2, urls: new Set(['a', 'b', 'c', 'd', 'f', 'g']) },
        { id: 3, weight: 1, urls: new Set(['c', 'd', 'f', 'g', 'h']) }
    ];
    const clusters = clusterBySerp(items, 4);
    assert.strictEqual(clusters.length, 2);
    assert.deepStrictEqual(clusters[0].members.map(m => m.id), [1, 2]);
});

test('cosine / centroid / nearestCentroid', () => {
    assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
    assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
    assert.strictEqual(cosine([0, 0], [1, 1]), 0);
    assert.deepStrictEqual(centroid([[1, 0], [3, 0]]), [2, 0]);

    const centroids = [[1, 0], [0, 1]];
    assert.strictEqual(nearestCentroid([0.9, 0.1], centroids, 0.8).index, 0);
    assert.strictEqual(nearestCentroid([0.7, 0.7], centroids, 0.8), null);
});

test('sanitizeIntent: валидирует enum-ы и confidence', () => {
    const ok = sanitizeIntent({ intent: 'commercial', product: 'vds', stage: 'purchase', conf: 0.93 });
    assert.deepStrictEqual(ok, { intent: 'commercial', product: 'vds', stage: 'purchase', confidence: '0.93' });
    assert.strictEqual(sanitizeIntent({ intent: 'wat', product: 'vds' }), null);
    const fallback = sanitizeIntent({ intent: 'informational', product: 'rocket', stage: 'x', conf: 7 });
    assert.strictEqual(fallback.product, 'other');
    assert.strictEqual(fallback.stage, null);
    assert.strictEqual(fallback.confidence, '1.00');
});

test('sanitizeSnippet: обрезает, приводит типы, подставляет значения по умолчанию', () => {
    const clean = sanitizeSnippet({
        page_type: 'weird', offers: ['a', 'b', 'c', 'd', 'e'], usp: 'не массив',
        price: 'true', price_text: 'от 500 ₽', trial: false, capacity: null
    });
    assert.strictEqual(clean.pageType, 'other');
    assert.strictEqual(clean.offers.length, 4);
    assert.deepStrictEqual(clean.usp, []);
    assert.strictEqual(clean.features.price, true);
    assert.strictEqual(clean.features.sla, false);
    assert.strictEqual(clean.features.price_text, 'от 500 ₽');
});

test('parseArgs и estimateTokens', () => {
    assert.deepStrictEqual(parseArgs(['--dry-run', '--limit', '50', '--model', 'pro']), { 'dry-run': true, limit: '50', model: 'pro' });
    assert.strictEqual(estimateTokens('1234567890'), 4);
});
