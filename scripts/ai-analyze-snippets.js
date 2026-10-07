// scripts/ai-analyze-snippets.js
// Разбор title/snippet документов выдачи (yandex.serp_results) через YandexGPT:
// тип страницы, офферы, УТП, признаки (цена, триал, SLA, поддержка 24/7, ёмкость).
// Результат — ai.snippet_analysis (+ вью ai.v_competitor_offers).
// С флагом --summaries дополнительно строит сводку по каждому кластеру
// (ai.cluster_competitor_summary): что предлагают конкуренты и чего не хватает нам.
//
// Запуск:
//   node scripts/ai-analyze-snippets.js --dry-run
//   node scripts/ai-analyze-snippets.js --limit 20          # первые 20 запросов (по весу выдачи)
//   node scripts/ai-analyze-snippets.js --request "защита от ddos"   # один запрос
//   node scripts/ai-analyze-snippets.js --summaries         # сводки по кластерам (нужны кластеры и разбор)
//   node scripts/ai-analyze-snippets.js --model pro
//
// Идемпотентно: разбираются только документы без строки в ai.snippet_analysis
// (берётся последний снимок выдачи по каждому запросу).

require('dotenv').config();
const DatabaseManager = require('../core/DatabaseManager');
const Logger = require('../core/Logger');
const { YandexAiClient, BudgetExceededError, estimateTokens, estimateCostRub, config } = require('../services/ai-nlp/YandexAiClient');
const { parseArgs, applySchema, startRun, finishRun } = require('../services/ai-nlp/lib');

const logger = new Logger('ai-nlp');

const PAGE_TYPES = ['landing', 'product', 'blog', 'docs', 'comparison', 'marketplace', 'news', 'other'];

const SNIPPET_SYSTEM_PROMPT = `Ты SEO-аналитик. Тебе дают поисковый запрос и пронумерованные результаты выдачи Яндекса (домен, заголовок, сниппет). Для КАЖДОГО результата определи:
- page_type: landing (посадочная услуги), product (карточка тарифа/продукта), blog (статья/блог), docs (документация/справка), comparison (сравнение/рейтинг/подборка), marketplace (агрегатор/каталог), news (новость), other.
- offers: до 4 коротких предложений, которые автор выносит в заголовок/сниппет (например "бесплатный тест 7 дней", "защита L3-L7"). Только то, что реально написано. Пустой массив, если нет.
- usp: до 3 коротких УТП/преимуществ из текста. Пустой массив, если нет.
- price: true, если в тексте названа цена или "от N ₽"; price_text — сама цена строкой или null.
- trial: true, если упомянут бесплатный тест/пробный период/демо.
- sla: true, если упомянут SLA/гарантия доступности/uptime.
- support_247: true, если упомянута поддержка 24/7.
- capacity: строка с ёмкостью/мощностью защиты (например "до 1 Тбит/с") или null.
Ничего не выдумывай: если признака в тексте нет — false/null/пустой массив.
Ответь ТОЛЬКО JSON-массивом: [{"i":1,"page_type":"landing","offers":["..."],"usp":["..."],"price":false,"price_text":null,"trial":false,"sla":false,"support_247":false,"capacity":null}, ...] по одному объекту на результат.`;

const SUMMARY_SYSTEM_PROMPT = `Ты SEO-аналитик российской компании DDoS-Guard (домены ddos-guard.ru, ddos-guard.net). Тебе дают выдачу Яндекса по главному запросу кластера: позиция, домен, наш/конкурент, тип страницы, офферы, цена. Сделай вывод:
- summary: 2-3 предложения — кто в топе (типы страниц, сильные игроки) и чем выделяется.
- common_offers: до 6 предложений, которые чаще всего повторяются у конкурентов.
- gaps: 1-3 предложения — что есть у конкурентов, но нет у нас в сниппетах; если наших страниц в топе нет — скажи об этом.
Опирайся только на данные. Ответь ТОЛЬКО JSON-объектом: {"summary":"...","common_offers":["..."],"gaps":"..."}.`;

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const asBool = v => v === true || v === 'true';
const asStrArray = (v, maxItems, maxLen) =>
    (Array.isArray(v) ? v : []).map(x => clip(x, maxLen)).filter(Boolean).slice(0, maxItems);

function sanitize(item) {
    return {
        pageType: PAGE_TYPES.includes(item.page_type) ? item.page_type : 'other',
        offers: asStrArray(item.offers, 4, 100),
        usp: asStrArray(item.usp, 3, 100),
        features: {
            price: asBool(item.price),
            price_text: item.price_text ? clip(item.price_text, 60) : null,
            trial: asBool(item.trial),
            sla: asBool(item.sla),
            support_247: asBool(item.support_247),
            capacity: item.capacity ? clip(item.capacity, 60) : null
        }
    };
}

function buildSnippetPrompt(request, rows) {
    const lines = rows.map((r, n) =>
        `${n + 1}. [${r.domain}] ${clip(r.title, 200)} — ${clip(r.snippet, config.snippets.maxSnippetChars)}`
    );
    return `Запрос: ${request}\n\nРезультаты:\n${lines.join('\n')}`;
}

async function loadPending(db, args) {
    const params = [config.snippets.topN, 30];
    let requestFilter = '';
    if (args.request) {
        params.push(args.request);
        requestFilter = `AND sr.request = $${params.length}`;
    }
    const { rows } = await db.query(
        `WITH latest AS (
             SELECT request, MAX(event_date) AS d
               FROM yandex.serp_results
              WHERE event_date >= CURRENT_DATE - $2::int
              GROUP BY request
         )
         SELECT sr.id, sr.request, sr.overall_position, sr.domain, sr.title, sr.snippet
           FROM yandex.serp_results sr
           JOIN latest l ON l.request = sr.request AND l.d = sr.event_date
           LEFT JOIN ai.snippet_analysis sa ON sa.serp_result_id = sr.id
          WHERE sr.overall_position <= $1
            AND sa.serp_result_id IS NULL
            ${requestFilter}
          ORDER BY sr.request, sr.overall_position`,
        params
    );
    const byRequest = new Map();
    for (const r of rows) {
        if (!byRequest.has(r.request)) byRequest.set(r.request, []);
        byRequest.get(r.request).push(r);
    }
    return [...byRequest.entries()];
}

async function analyzeSnippets(db, args, dryRun) {
    let groups = await loadPending(db, args);
    if (args.limit) groups = groups.slice(0, parseInt(args.limit, 10));
    const docs = groups.reduce((s, [, rows]) => s + rows.length, 0);
    logger.info(`Запросов к разбору: ${groups.length}, документов: ${docs}`);
    if (groups.length === 0) return null;

    const modelName = config.models[args.model || config.defaultModel] || args.model || config.models[config.defaultModel];
    if (dryRun) {
        const tokens = groups.reduce(
            (s, [req, rows]) => s + estimateTokens(SNIPPET_SYSTEM_PROMPT) + estimateTokens(buildSnippetPrompt(req, rows)) + rows.length * 90, 0
        );
        logger.info(`DRY-RUN: ${groups.length} вызовов, ~${tokens} токенов, ~${estimateCostRub(modelName, tokens).toFixed(2)} ₽ (${modelName}). API не вызывался.`);
        return null;
    }

    const client = new YandexAiClient({ modelAlias: args.model });
    const runId = await startRun(db, 'snippets', client.modelName, { limit: args.limit || null, request: args.request || null });
    let ok = 0, failed = 0, status = 'ok', error = null;

    try {
        for (let g = 0; g < groups.length; g++) {
            const [request, rows] = groups[g];
            try {
                const parsed = await client.completeJson(SNIPPET_SYSTEM_PROMPT, buildSnippetPrompt(request, rows), { maxTokens: 3500 });
                for (const item of Array.isArray(parsed) ? parsed : []) {
                    const target = rows[Number(item.i) - 1];
                    if (!target) { failed++; continue; }
                    const clean = sanitize(item);
                    await db.query(
                        `INSERT INTO ai.snippet_analysis (serp_result_id, page_type, offers, usp, features, model, run_id)
                         VALUES ($1, $2, $3, $4, $5, $6, $7)
                         ON CONFLICT (serp_result_id) DO NOTHING`,
                        [target.id, clean.pageType, clean.offers, clean.usp, JSON.stringify(clean.features), client.modelName, runId]
                    );
                    ok++;
                }
            } catch (err) {
                if (err instanceof BudgetExceededError) throw err;
                failed += rows.length;
                logger.error(`"${request}" не разобран: ${err.message}`);
            }
            if ((g + 1) % 10 === 0 || g === groups.length - 1) {
                logger.info(`Запросов ${g + 1}/${groups.length}, документов разобрано ${ok}, ошибок ${failed}, ~${client.usage.costRub.toFixed(2)} ₽`);
            }
        }
    } catch (err) {
        status = 'failed';
        error = err.message;
        logger.error(err.message);
    }

    await finishRun(db, runId, { status, client, itemsTotal: docs, itemsOk: ok, itemsFailed: failed, error });
    logger.info(`Разбор сниппетов готов (run ${runId}, ${status}): ${ok} из ${docs}, ~${client.usage.costRub.toFixed(2)} ₽`);
    if (status === 'failed') process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Сводки по кластерам
// ---------------------------------------------------------------------------

function buildSummaryPrompt(label, headRequest, rows) {
    const own = new Set(config.ownDomains);
    const lines = rows.map(r => {
        const f = r.features || {};
        const parts = [
            `${r.overall_position}. ${r.domain}${own.has(r.domain) ? ' (МЫ)' : ''}`,
            r.page_type,
            r.offers?.length ? `офферы: ${r.offers.join('; ')}` : null,
            f.price ? `цена: ${f.price_text || 'указана'}` : null,
            f.trial ? 'триал' : null,
            f.sla ? 'SLA' : null,
            f.support_247 ? '24/7' : null,
            f.capacity ? `ёмкость: ${f.capacity}` : null
        ].filter(Boolean);
        return parts.join(' | ');
    });
    return `Кластер: ${label}\nГлавный запрос: ${headRequest}\n\nВыдача:\n${lines.join('\n')}`;
}

async function summarizeClusters(db, args, dryRun) {
    const { rows: clusters } = await db.query(
        `SELECT c.cluster_id, c.label, r.request AS head_request
           FROM ai.clusters c
           JOIN common.requests r ON r.request_id = c.head_request_id
           LEFT JOIN ai.cluster_competitor_summary s ON s.cluster_id = c.cluster_id
          WHERE c.run_id = (SELECT MAX(run_id) FROM ai.runs WHERE task = 'cluster' AND status = 'ok')
            AND c.size >= 2
            AND s.cluster_id IS NULL
          ORDER BY c.size DESC`
    );
    const targets = args.limit ? clusters.slice(0, parseInt(args.limit, 10)) : clusters;
    logger.info(`Кластеров без сводки (size ≥ 2): ${targets.length}`);
    if (targets.length === 0) return;

    // Выдача головного запроса кластера (последний снимок) вместе с разбором.
    const rowsFor = async headRequest => (await db.query(
        `SELECT sr.overall_position, sr.domain, sa.page_type, sa.offers, sa.features
           FROM yandex.serp_results sr
           JOIN ai.snippet_analysis sa ON sa.serp_result_id = sr.id
          WHERE sr.request = $1
            AND sr.event_date = (SELECT MAX(event_date) FROM yandex.serp_results WHERE request = $1)
            AND sr.overall_position <= $2
          ORDER BY sr.overall_position`,
        [headRequest, config.snippets.topN]
    )).rows;

    const modelName = config.models[args.model || config.defaultModel] || args.model || config.models[config.defaultModel];
    const prepared = [];
    for (const c of targets) {
        const rows = await rowsFor(c.head_request);
        if (rows.length > 0) prepared.push({ ...c, rows });
    }
    logger.info(`С разобранной выдачей: ${prepared.length} (остальным сначала нужен разбор сниппетов)`);
    if (prepared.length === 0) return;

    if (dryRun) {
        const tokens = prepared.reduce(
            (s, c) => s + estimateTokens(SUMMARY_SYSTEM_PROMPT) + estimateTokens(buildSummaryPrompt(c.label, c.head_request, c.rows)) + 250, 0
        );
        logger.info(`DRY-RUN: ${prepared.length} вызовов, ~${tokens} токенов, ~${estimateCostRub(modelName, tokens).toFixed(2)} ₽ (${modelName}).`);
        return;
    }

    const client = new YandexAiClient({ modelAlias: args.model });
    const runId = await startRun(db, 'cluster_summary', client.modelName, { limit: args.limit || null });
    let ok = 0, failed = 0, status = 'ok', error = null;

    try {
        for (const c of prepared) {
            try {
                const parsed = await client.completeJson(SUMMARY_SYSTEM_PROMPT, buildSummaryPrompt(c.label, c.head_request, c.rows), { maxTokens: 800 });
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('ответ не объект');
                await db.query(
                    `INSERT INTO ai.cluster_competitor_summary (cluster_id, summary, common_offers, gaps, model, run_id)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (cluster_id) DO NOTHING`,
                    [c.cluster_id, clip(parsed.summary, 1000), JSON.stringify(asStrArray(parsed.common_offers, 6, 120)), clip(parsed.gaps, 1000), client.modelName, runId]
                );
                ok++;
            } catch (err) {
                if (err instanceof BudgetExceededError) throw err;
                failed++;
                logger.error(`Кластер ${c.cluster_id} без сводки: ${err.message}`);
            }
        }
    } catch (err) {
        status = 'failed';
        error = err.message;
        logger.error(err.message);
    }

    await finishRun(db, runId, { status, client, itemsTotal: prepared.length, itemsOk: ok, itemsFailed: failed, error });
    logger.info(`Сводки готовы (run ${runId}, ${status}): ${ok} из ${prepared.length}, ~${client.usage.costRub.toFixed(2)} ₽`);
    if (status === 'failed') process.exitCode = 1;
}

async function main() {
    const args = parseArgs();
    const dryRun = !!args['dry-run'];

    const db = new DatabaseManager('ai-nlp');
    await db.connect();
    try {
        await applySchema(db);
        if (args.summaries) {
            await summarizeClusters(db, args, dryRun);
        } else {
            await analyzeSnippets(db, args, dryRun);
        }
    } finally {
        await db.disconnect();
    }
}

if (require.main === module) {
    main().catch(err => {
        logger.error(`Ошибка анализа сниппетов: ${err.message}`);
        process.exit(1);
    });
}

module.exports = { sanitize, buildSnippetPrompt };
