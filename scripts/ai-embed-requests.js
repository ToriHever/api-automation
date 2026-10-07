// scripts/ai-embed-requests.js
// Считает эмбеддинги запросов из common.requests (Yandex Foundation Models, text-search-doc)
// и пишет в ai.request_embeddings. Векторы нужны для ai-cluster-serp.js
// (довешивание запросов без данных SERP к кластерам).
//
// Запуск:
//   node scripts/ai-embed-requests.js --dry-run
//   node scripts/ai-embed-requests.js --limit 500
//   node scripts/ai-embed-requests.js --scope serp    # только запросы из yandex.serp_results (tracked — по умолчанию, all — всё ядро)
//   node scripts/ai-embed-requests.js --min-impressions 100   # + запросы GSC с ≥100 показов за 90 дней
//
// Идемпотентно: пропускает запросы, у которых уже есть вектор этой модели.

require('dotenv').config();
const DatabaseManager = require('../core/DatabaseManager');
const Logger = require('../core/Logger');
const { YandexAiClient, BudgetExceededError, estimateTokens, estimateCostRub, config } = require('../services/ai-nlp/YandexAiClient');
const { parseArgs, scopeClause, applySchema, startRun, finishRun } = require('../services/ai-nlp/lib');

const logger = new Logger('ai-nlp');
const CONCURRENCY = 4;

async function main() {
    const args = parseArgs();
    const dryRun = !!args['dry-run'];
    const limit = args.limit ? parseInt(args.limit, 10) : null;
    const modelName = config.embeddingModel;

    const db = new DatabaseManager('ai-nlp');
    await db.connect();

    try {
        await applySchema(db);

        const { rows: requests } = await db.query(
            `SELECT r.request_id, r.request
               FROM common.requests r
               LEFT JOIN ai.request_embeddings e ON e.request_id = r.request_id AND e.model = $1
              WHERE e.request_id IS NULL
                ${scopeClause(args)}
              ORDER BY r.request_id
              ${limit ? `LIMIT ${limit}` : ''}`,
            [modelName]
        );
        logger.info(`Запросов без вектора: ${requests.length}`);
        if (requests.length === 0) return;

        if (dryRun) {
            const tokens = requests.reduce((sum, r) => sum + estimateTokens(r.request), 0);
            logger.info(`DRY-RUN: ${requests.length} вызовов, ~${tokens} токенов, ~${estimateCostRub(modelName, tokens).toFixed(2)} ₽. API не вызывался.`);
            return;
        }

        const client = new YandexAiClient();
        const runId = await startRun(db, 'embed', modelName, { limit, scope: args.scope || 'tracked', minImpressions: args['min-impressions'] || null });
        let ok = 0, failed = 0, status = 'ok', error = null;
        let next = 0;
        let stop = false;
        let consecutiveFailures = 0;

        // Небольшой пул воркеров: запросы к API параллельно, запись в БД — по одной (один клиент pg).
        const worker = async () => {
            while (!stop) {
                const idx = next++;
                if (idx >= requests.length) return;
                const r = requests[idx];
                try {
                    const vector = await client.embed(r.request);
                    await db.query(
                        `INSERT INTO ai.request_embeddings (request_id, model, dim, embedding, run_id)
                         VALUES ($1, $2, $3, $4, $5)
                         ON CONFLICT (request_id, model) DO NOTHING`,
                        [r.request_id, modelName, vector.length, vector, runId]
                    );
                    ok++;
                    consecutiveFailures = 0;
                } catch (err) {
                    if (err instanceof BudgetExceededError) { stop = true; throw err; }
                    failed++;
                    logger.error(`Эмбеддинг "${r.request}" не получен: ${err.message}`);
                    if (++consecutiveFailures >= 5) { stop = true; throw new Error('5 ошибок подряд — останавливаюсь (проверь ключ, каталог и права)'); }
                }
                if ((ok + failed) % 100 === 0) logger.info(`Обработано ${ok + failed} / ${requests.length}, ~${client.usage.costRub.toFixed(2)} ₽`);
            }
        };

        try {
            await Promise.all(Array.from({ length: CONCURRENCY }, worker));
        } catch (err) {
            status = 'failed';
            error = err.message;
            logger.error(err.message);
        }

        if (status === 'ok' && ok === 0 && failed > 0) { status = 'failed'; error = 'ни один вектор не получен'; }
        await finishRun(db, runId, { status, client, itemsTotal: requests.length, itemsOk: ok, itemsFailed: failed, error });
        logger.info(`Готово (run ${runId}, ${status}): ${ok} векторов, ошибок ${failed}, ~${client.usage.costRub.toFixed(2)} ₽`);
        if (status === 'failed') process.exitCode = 1;
    } finally {
        await db.disconnect();
    }
}

if (require.main === module) {
    main().catch(err => {
        logger.error(`Ошибка эмбеддингов: ${err.message}`);
        process.exit(1);
    });
}
