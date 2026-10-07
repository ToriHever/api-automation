// scripts/ai-cluster-serp.js
// Кластеризация запросов по выдаче: запросы, у которых в топ-N совпадают >= minSharedUrls URL,
// попадают в один кластер (голова — самый частотный). Запросы без данных SERP, но с эмбеддингом
// (ai-embed-requests.js), довешиваются к ближайшему кластеру по косинусу. Названия кластеров
// придумывает YandexGPT. Результат — ai.clusters / ai.cluster_members (+ вью ai.v_request_clusters).
//
// Запуск:
//   node scripts/ai-cluster-serp.js --dry-run            # кластеры в консоль, БД и API не трогаем
//   node scripts/ai-cluster-serp.js                      # полный запуск
//   node scripts/ai-cluster-serp.js --min-shared 3       # мягче (больше слияний)
//   node scripts/ai-cluster-serp.js --no-labels          # без YandexGPT (названия = голова кластера)
//   node scripts/ai-cluster-serp.js --no-embeddings      # без довешивания по эмбеддингам

require('dotenv').config();
const DatabaseManager = require('../core/DatabaseManager');
const Logger = require('../core/Logger');
const { YandexAiClient, BudgetExceededError, estimateTokens, estimateCostRub, config } = require('../services/ai-nlp/YandexAiClient');
const {
    parseArgs, applySchema, startRun, finishRun,
    normalizeUrl, clusterBySerp, centroid, nearestCentroid
} = require('../services/ai-nlp/lib');

const logger = new Logger('ai-nlp');

const LABEL_SYSTEM_PROMPT = `Ты SEO-аналитик. Тебе дают кластеры поисковых запросов (по одной теме). Для каждого кластера придумай короткое название (2-5 слов, по-русски), отражающее общий смысл запросов, например "Защита сайта от DDoS" или "VDS с защитой". Ответь ТОЛЬКО JSON-массивом: [{"i":1,"label":"..."}, ...] по одному объекту на кластер.`;

async function loadSerp(db, serpCfg) {
    const { rows } = await db.query(
        `WITH latest AS (
             SELECT request, MAX(event_date) AS d
               FROM yandex.serp_results
              WHERE event_date >= CURRENT_DATE - $1::int
              GROUP BY request
         )
         SELECT r.request_id, sr.url
           FROM yandex.serp_results sr
           JOIN latest l           ON l.request = sr.request AND l.d = sr.event_date
           JOIN common.requests r  ON r.request = sr.request
          WHERE sr.overall_position <= $2`,
        [serpCfg.serpWindowDays, serpCfg.topN]
    );

    const urlsByRequest = new Map();
    for (const row of rows) {
        if (!urlsByRequest.has(row.request_id)) urlsByRequest.set(row.request_id, new Set());
        urlsByRequest.get(row.request_id).add(normalizeUrl(row.url));
    }
    return urlsByRequest;
}

async function loadWeights(db, requestIds) {
    const { rows } = await db.query(
        `SELECT r.request_id,
                COALESCE(ws.frequency, 0) AS freq,
                COALESCE(g.impr, 0)       AS impr
           FROM common.requests r
           LEFT JOIN (
                SELECT d.request_id, d.frequency
                  FROM wordstat.dynamics_range d
                 WHERE d.month = (SELECT MAX(month) FROM wordstat.dynamics_range)
           ) ws ON ws.request_id = r.request_id
           LEFT JOIN (
                SELECT request, SUM(impressions) AS impr
                  FROM gsc.search_console
                 WHERE event_date >= CURRENT_DATE - 90
                 GROUP BY request
           ) g ON g.request = r.request
          WHERE r.request_id = ANY($1)`,
        [requestIds]
    );
    // Основной вес — частотность Wordstat; показы GSC (/1000) — только чтобы развести равные.
    return new Map(rows.map(r => [r.request_id, Number(r.freq) + Number(r.impr) / 1000]));
}

async function loadEmbeddings(db) {
    const { rows } = await db.query(
        `SELECT request_id, embedding FROM ai.request_embeddings WHERE model = $1`,
        [config.embeddingModel]
    );
    return new Map(rows.map(r => [r.request_id, r.embedding.map(Number)]));
}

async function main() {
    const args = parseArgs();
    const dryRun = !!args['dry-run'];
    const serpCfg = { ...config.cluster };
    if (args['min-shared']) serpCfg.minSharedUrls = parseInt(args['min-shared'], 10);
    if (args['top-n']) serpCfg.topN = parseInt(args['top-n'], 10);

    const db = new DatabaseManager('ai-nlp');
    await db.connect();

    try {
        await applySchema(db);

        // 1. Кластеры по выдаче
        const urlsByRequest = await loadSerp(db, serpCfg);
        const requestIds = [...urlsByRequest.keys()];
        logger.info(`Запросов с выдачей за ${serpCfg.serpWindowDays} дн.: ${requestIds.length}`);
        if (requestIds.length === 0) {
            logger.warn('Нет данных yandex.serp_results (или запросы не найдены в common.requests) — нечего кластеризовать.');
            return;
        }

        const weights = await loadWeights(db, requestIds);
        const items = requestIds.map(id => ({ id, weight: weights.get(id) || 0, urls: urlsByRequest.get(id) }));
        const serpClusters = clusterBySerp(items, serpCfg.minSharedUrls);
        const multi = serpClusters.filter(c => c.members.length > 1).length;
        logger.info(`SERP-кластеров: ${serpClusters.length} (из них с ≥2 запросами: ${multi}, одиночных: ${serpClusters.length - multi})`);

        // 2. Довешивание по эмбеддингам запросов без выдачи
        const embeddings = args['no-embeddings'] ? new Map() : await loadEmbeddings(db);
        const clustered = new Set(requestIds);
        const orphanIds = [...embeddings.keys()].filter(id => !clustered.has(id));
        const embeddingAssignments = []; // { clusterIndex, requestId, similarity }

        if (embeddings.size > 0 && orphanIds.length > 0) {
            const centroids = [];
            const centroidClusterIdx = [];
            serpClusters.forEach((c, idx) => {
                const vectors = c.members.map(m => embeddings.get(m.id)).filter(Boolean);
                if (vectors.length > 0) {
                    centroids.push(centroid(vectors));
                    centroidClusterIdx.push(idx);
                }
            });
            for (const id of orphanIds) {
                const hit = centroids.length ? nearestCentroid(embeddings.get(id), centroids, serpCfg.assignThreshold) : null;
                if (hit) embeddingAssignments.push({ clusterIndex: centroidClusterIdx[hit.index], requestId: id, similarity: hit.similarity });
            }
            logger.info(`Без выдачи, но с вектором: ${orphanIds.length}; довешено по эмбеддингам (cos ≥ ${serpCfg.assignThreshold}): ${embeddingAssignments.length}`);
        } else if (!args['no-embeddings']) {
            logger.info('Эмбеддингов для довешивания нет (или все запросы уже с выдачей) — шаг пропущен');
        }

        // Состав кластеров для названий и вывода
        const requestRows = await db.query(
            `SELECT request_id, request FROM common.requests WHERE request_id = ANY($1)`,
            [[...requestIds, ...embeddingAssignments.map(a => a.requestId)]]
        );
        const textById = new Map(requestRows.rows.map(r => [r.request_id, r.request]));
        const extraByCluster = new Map();
        for (const a of embeddingAssignments) {
            if (!extraByCluster.has(a.clusterIndex)) extraByCluster.set(a.clusterIndex, []);
            extraByCluster.get(a.clusterIndex).push(a.requestId);
        }
        const phrasesOf = idx => [
            ...serpClusters[idx].members.map(m => textById.get(m.id)),
            ...(extraByCluster.get(idx) || []).map(id => textById.get(id))
        ];

        const labelTargets = serpClusters
            .map((c, idx) => idx)
            .filter(idx => phrasesOf(idx).length >= 2);
        const labelBatches = [];
        for (let i = 0; i < labelTargets.length; i += serpCfg.labelBatchSize) {
            labelBatches.push(labelTargets.slice(i, i + serpCfg.labelBatchSize));
        }
        const buildLabelPrompt = batch => batch
            .map((idx, n) => `${n + 1}. ${phrasesOf(idx).slice(0, 25).join('; ')}`)
            .join('\n');

        if (dryRun) {
            const sample = [...serpClusters.keys()]
                .filter(idx => phrasesOf(idx).length >= 2)
                .sort((a, b) => phrasesOf(b).length - phrasesOf(a).length)
                .slice(0, 10);
            for (const idx of sample) logger.info(`  [${phrasesOf(idx).length}] ${phrasesOf(idx).slice(0, 6).join(' | ')}`);
            const tokens = labelBatches.reduce((s, b) => s + estimateTokens(LABEL_SYSTEM_PROMPT) + estimateTokens(buildLabelPrompt(b)) + b.length * 15, 0);
            const modelName = config.models[config.defaultModel];
            logger.info(`DRY-RUN: названия кластеров — ${labelBatches.length} вызовов, ~${estimateCostRub(modelName, tokens).toFixed(2)} ₽. В БД ничего не записано.`);
            return;
        }

        // 3. Запись
        const needGpt = !args['no-labels'] && labelBatches.length > 0;
        const client = needGpt ? new YandexAiClient() : null;
        const runId = await startRun(db, 'cluster', client?.modelName || null, { ...serpCfg, labels: needGpt });
        let status = 'ok', error = null;
        const clusterIds = [];

        try {
            for (let idx = 0; idx < serpClusters.length; idx++) {
                const c = serpClusters[idx];
                const extra = extraByCluster.get(idx) || [];
                const { rows: [row] } = await db.query(
                    `INSERT INTO ai.clusters (run_id, head_request_id, label, size)
                     VALUES ($1, $2, $3, $4) RETURNING cluster_id`,
                    [runId, c.headId, textById.get(c.headId), c.members.length + extra.length]
                );
                clusterIds.push(row.cluster_id);

                for (const m of c.members) {
                    await db.query(
                        `INSERT INTO ai.cluster_members (cluster_id, request_id, is_head, assigned_by, shared_urls)
                         VALUES ($1, $2, $3, 'serp', $4)`,
                        [row.cluster_id, m.id, m.id === c.headId, m.shared]
                    );
                }
            }
            for (const a of embeddingAssignments) {
                await db.query(
                    `INSERT INTO ai.cluster_members (cluster_id, request_id, is_head, assigned_by, similarity)
                     VALUES ($1, $2, false, 'embedding', $3)`,
                    [clusterIds[a.clusterIndex], a.requestId, a.similarity.toFixed(4)]
                );
            }
            logger.info(`Записано кластеров: ${clusterIds.length}`);

            // 4. Названия
            if (needGpt) {
                for (let b = 0; b < labelBatches.length; b++) {
                    const batch = labelBatches[b];
                    try {
                        const parsed = await client.completeJson(LABEL_SYSTEM_PROMPT, buildLabelPrompt(batch), { maxTokens: 1500 });
                        for (const item of Array.isArray(parsed) ? parsed : []) {
                            const idx = batch[Number(item.i) - 1];
                            if (idx === undefined || !item.label) continue;
                            await db.query(`UPDATE ai.clusters SET label = $2 WHERE cluster_id = $1`, [clusterIds[idx], String(item.label).slice(0, 120)]);
                        }
                    } catch (err) {
                        if (err instanceof BudgetExceededError) throw err;
                        logger.error(`Названия батча ${b + 1}/${labelBatches.length} не получены (остаётся голова кластера): ${err.message}`);
                    }
                }
                logger.info(`Названия готовы, ~${client.usage.costRub.toFixed(2)} ₽`);
            }
        } catch (err) {
            status = 'failed';
            error = err.message;
            logger.error(err.message);
        }

        await finishRun(db, runId, {
            status, client, itemsTotal: serpClusters.length, itemsOk: clusterIds.length, error
        });
        logger.info(`Готово (run ${runId}, ${status}). Смотри ai.v_request_clusters`);
        if (status === 'failed') process.exitCode = 1;
    } finally {
        await db.disconnect();
    }
}

if (require.main === module) {
    main().catch(err => {
        logger.error(`Ошибка кластеризации: ${err.message}`);
        process.exit(1);
    });
}
