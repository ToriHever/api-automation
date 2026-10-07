// services/ai-nlp/lib.js
// Общие хелперы AI-скриптов: аргументы CLI, журнал запусков ai.runs,
// применение схемы и чистые функции кластеризации (без БД и API — тестируются отдельно).

const fs = require('fs');
const path = require('path');

const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

/**
 * Простой разбор аргументов: --flag, --key value.
 * parseArgs(['--dry-run', '--limit', '50']) -> { 'dry-run': true, limit: '50' }
 */
function parseArgs(argv = process.argv.slice(2)) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        const key = argv[i].slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            args[key] = true;
        } else {
            args[key] = next;
            i++;
        }
    }
    return args;
}

/**
 * Охват запросов для классификации/эмбеддингов (SQL-фрагмент для WHERE, алиас таблицы — r).
 *   --scope tracked (по умолчанию) — выдача yandex.serp_results + активные wordstat.check_list;
 *                                    с --min-impressions N добавляются запросы GSC за 90 дней с ≥ N показов
 *   --scope serp                   — только запросы из yandex.serp_results
 *   --scope all                    — все common.requests (дорого: десятки тысяч фраз)
 */
function scopeClause(args) {
    const scope = args['only-serp'] ? 'serp' : (args.scope || 'tracked');
    const serp = `r.request IN (SELECT DISTINCT request FROM yandex.serp_results)`;
    if (scope === 'all') return '';
    if (scope === 'serp') return `AND ${serp}`;
    if (scope !== 'tracked') throw new Error(`Неизвестный --scope "${scope}" (tracked | serp | all)`);

    const parts = [
        serp,
        `r.request_id IN (SELECT request_id FROM wordstat.check_list WHERE is_active)`
    ];
    const minImpr = parseInt(args['min-impressions'], 10);
    if (Number.isFinite(minImpr) && minImpr > 0) {
        parts.push(`r.request IN (
            SELECT request FROM gsc.search_console
             WHERE event_date >= CURRENT_DATE - 90
             GROUP BY request HAVING SUM(impressions) >= ${minImpr})`);
    }
    return `AND (${parts.join(' OR ')})`;
}

async function applySchema(db) {
    await db.query(fs.readFileSync(SCHEMA_FILE, 'utf8'));
}

async function startRun(db, task, model, params) {
    const { rows } = await db.query(
        `INSERT INTO ai.runs (task, model, params) VALUES ($1, $2, $3) RETURNING run_id`,
        [task, model, JSON.stringify(params || {})]
    );
    return rows[0].run_id;
}

async function finishRun(db, runId, { status, client, itemsTotal = 0, itemsOk = 0, itemsFailed = 0, error = null }) {
    await db.query(
        `UPDATE ai.runs
            SET status = $2, items_total = $3, items_ok = $4, items_failed = $5,
                input_tokens = $6, output_tokens = $7, est_cost_rub = $8,
                error = $9, finished_at = CURRENT_TIMESTAMP
          WHERE run_id = $1`,
        [
            runId, status, itemsTotal, itemsOk, itemsFailed,
            client?.usage.inputTokens || 0,
            client?.usage.outputTokens || 0,
            (client?.usage.costRub || 0).toFixed(2),
            error
        ]
    );
}

// ---------------------------------------------------------------------------
// Кластеризация
// ---------------------------------------------------------------------------

/** Нормализация URL для сравнения выдачи: без схемы, www, query, fragment и хвостового слеша. */
function normalizeUrl(url) {
    return String(url)
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .split('#')[0]
        .split('?')[0]
        .replace(/\/+$/, '');
}

function overlap(setA, setB) {
    let n = 0;
    const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
    for (const v of small) if (large.has(v)) n++;
    return n;
}

/**
 * Жадная кластеризация по пересечению топа выдачи.
 * items: [{ id, weight, urls: Set<string> }]
 * Берём самый «тяжёлый» ещё не распределённый запрос как голову кластера и
 * забираем в него все нераспределённые запросы, делящие с головой >= minShared URL.
 * Сравнение именно с головой (а не цепочкой) не даёт кластерам «расползаться».
 * Возвращает [{ headId, members: [{ id, shared }] }] (голова — первый, shared = null).
 */
function clusterBySerp(items, minShared) {
    const sorted = [...items].sort((a, b) => b.weight - a.weight);
    const assigned = new Set();
    const clusters = [];

    for (const head of sorted) {
        if (assigned.has(head.id)) continue;
        assigned.add(head.id);
        const members = [{ id: head.id, shared: null }];

        for (const candidate of sorted) {
            if (assigned.has(candidate.id)) continue;
            const shared = overlap(head.urls, candidate.urls);
            if (shared >= minShared) {
                assigned.add(candidate.id);
                members.push({ id: candidate.id, shared });
            }
        }
        clusters.push({ headId: head.id, members });
    }
    return clusters;
}

function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
}

function centroid(vectors) {
    const dim = vectors[0].length;
    const c = new Array(dim).fill(0);
    for (const v of vectors) for (let i = 0; i < dim; i++) c[i] += v[i];
    for (let i = 0; i < dim; i++) c[i] /= vectors.length;
    return c;
}

/**
 * Находит ближайший центроид; возвращает { index, similarity } или null, если
 * лучшая близость ниже порога.
 */
function nearestCentroid(vector, centroids, threshold) {
    let best = null;
    centroids.forEach((c, index) => {
        const similarity = cosine(vector, c);
        if (!best || similarity > best.similarity) best = { index, similarity };
    });
    return best && best.similarity >= threshold ? best : null;
}

module.exports = {
    parseArgs, scopeClause, applySchema, startRun, finishRun,
    normalizeUrl, clusterBySerp, cosine, centroid, nearestCentroid
};
