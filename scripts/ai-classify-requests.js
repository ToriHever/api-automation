// scripts/ai-classify-requests.js
// Размечает common.requests через YandexGPT: интент (commercial/informational/brand/...),
// продукт (ddos_protection/vds/hosting/...), стадия воронки. Пишет в ai.request_intent.
//
// Запуск:
//   node scripts/ai-classify-requests.js --dry-run          # только оценка стоимости
//   node scripts/ai-classify-requests.js --limit 200        # первые 200 неразмеченных
//   node scripts/ai-classify-requests.js --model pro        # модель yandexgpt вместо lite
//   node scripts/ai-classify-requests.js --force            # перезаписать уже размеченные
//   node scripts/ai-classify-requests.js --scope serp       # только фразы из выдачи (tracked — по умолчанию, all — всё ядро)
//   node scripts/ai-classify-requests.js --min-impressions 100   # + запросы GSC с ≥100 показов за 90 дней
//
// Идемпотентно: по умолчанию берёт только запросы без строки в ai.request_intent.

require('dotenv').config();
const DatabaseManager = require('../core/DatabaseManager');
const Logger = require('../core/Logger');
const { YandexAiClient, BudgetExceededError, estimateTokens, estimateCostRub, config } = require('../services/ai-nlp/YandexAiClient');
const { parseArgs, scopeClause, applySchema, startRun, finishRun } = require('../services/ai-nlp/lib');

const logger = new Logger('ai-nlp');

const INTENTS = ['commercial', 'informational', 'brand', 'competitor_brand', 'navigational', 'junk'];
const PRODUCTS = ['ddos_protection', 'waf_l7', 'network_l3_l4', 'cdn', 'hosting', 'vds', 'dedicated', 'captcha', 'cloudflare_alt', 'dns', 'other', 'none'];
const STAGES = ['awareness', 'consideration', 'purchase'];

const SYSTEM_PROMPT = `Ты SEO-аналитик российской компании DDoS-Guard (сайт ddos-guard.ru): защита от DDoS-атак, WAF и защита сайтов (L7), защита сетей (L3-L4), CDN, хостинг и VDS/VPS с защитой, выделенные серверы, dCAPTCHA.
Тебе дают пронумерованные поисковые запросы. Для каждого определи:
- intent:
  commercial — человек ищет услугу или хочет её получить: "защита от ddos", "ddos защита сайта", "антиддос", "хостинг с защитой", "купить", "заказать", "цена", "сервис", "компания". Общие названия услуги без вопросительных слов — это commercial.
  informational — вопрос или обучение: "что такое", "как", "почему", "зачем", "способы", "методы", термины и определения.
  brand — запрос именно про DDoS-Guard (ddos-guard, ддос гард). Слова "антиддос", "anti ddos" — НЕ бренд, это общее название услуги.
  competitor_brand — бренд конкурента: Cloudflare, Qrator, StormWall, Selectel и т.п.
  navigational — ищет конкретный чужой сайт или сервис.
  junk — не относится к безопасности, хостингу, серверам, сетям.
- product: ddos_protection, waf_l7, network_l3_l4, cdn, hosting, vds, dedicated, captcha, cloudflare_alt, dns, other, none (none — продукта нет, например общий термин).
- stage:
  purchase — есть "купить", "заказать", "цена", "стоимость", "тариф", "аренда";
  consideration — выбирает исполнителя: "сервис", "компания", "лучшие", "рейтинг", "сравнение", "аналог", "российский";
  awareness — остальное: изучает тему, общие и информационные запросы.
Ответь ТОЛЬКО JSON-массивом без пояснений: [{"i":1,"intent":"...","product":"...","stage":"..."}, ...]. По одному объекту на каждый запрос.`;

function buildUserPrompt(batch) {
    return batch.map((r, idx) => `${idx + 1}. ${r.request}`).join('\n');
}

function sanitize(item) {
    const intent = INTENTS.includes(item.intent) ? item.intent : null;
    if (!intent) return null;
    const product = PRODUCTS.includes(item.product) ? item.product : 'other';
    const stage = STAGES.includes(item.stage) ? item.stage : null;
    const conf = Number(item.conf);
    return {
        intent,
        product,
        stage,
        confidence: Number.isFinite(conf) ? Math.min(Math.max(conf, 0), 1).toFixed(2) : null
    };
}

async function main() {
    const args = parseArgs();
    const dryRun = !!args['dry-run'];
    const force = !!args.force;
    const limit = args.limit ? parseInt(args.limit, 10) : null;
    const batchSize = config.classify.batchSize;

    const db = new DatabaseManager('ai-nlp');
    await db.connect();

    try {
        await applySchema(db);

        const { rows: requests } = await db.query(
            `SELECT r.request_id, r.request
               FROM common.requests r
               LEFT JOIN ai.request_intent ri ON ri.request_id = r.request_id
              WHERE 1 = 1
                ${force ? '' : 'AND ri.request_id IS NULL'}
                ${scopeClause(args)}
              ORDER BY r.request_id
              ${limit ? `LIMIT ${limit}` : ''}`
        );
        logger.info(`Запросов к разметке: ${requests.length}`);
        if (requests.length === 0) return;

        const modelName = config.models[args.model || config.defaultModel] || args.model || config.models[config.defaultModel];
        const batches = [];
        for (let i = 0; i < requests.length; i += batchSize) batches.push(requests.slice(i, i + batchSize));

        if (dryRun) {
            const tokens = batches.reduce(
                (sum, b) => sum + estimateTokens(SYSTEM_PROMPT) + estimateTokens(buildUserPrompt(b)) + b.length * 25, 0
            );
            logger.info(`DRY-RUN: ${batches.length} вызовов, ~${tokens} токенов, ~${estimateCostRub(modelName, tokens).toFixed(2)} ₽ (${modelName}). API не вызывался.`);
            return;
        }

        const client = new YandexAiClient({ modelAlias: args.model });
        const runId = await startRun(db, 'classify', client.modelName, { limit, force, batchSize });
        let ok = 0, failed = 0, error = null, status = 'ok', consecutiveFailures = 0;

        try {
            for (let b = 0; b < batches.length; b++) {
                const batch = batches[b];
                try {
                    const parsed = await client.completeJson(SYSTEM_PROMPT, buildUserPrompt(batch), { maxTokens: 3000 });
                    for (const item of Array.isArray(parsed) ? parsed : []) {
                        const target = batch[Number(item.i) - 1];
                        const clean = target && sanitize(item);
                        if (!clean) { failed++; continue; }
                        await db.query(
                            `INSERT INTO ai.request_intent (request_id, intent, product, stage, confidence, model, run_id)
                             VALUES ($1, $2, $3, $4, $5, $6, $7)
                             ON CONFLICT (request_id) DO UPDATE SET
                                intent = EXCLUDED.intent, product = EXCLUDED.product, stage = EXCLUDED.stage,
                                confidence = EXCLUDED.confidence, model = EXCLUDED.model, run_id = EXCLUDED.run_id,
                                updated_at = CURRENT_TIMESTAMP`,
                            [target.request_id, clean.intent, clean.product, clean.stage, clean.confidence, client.modelName, runId]
                        );
                        ok++;
                    }
                } catch (err) {
                    if (err instanceof BudgetExceededError) throw err;
                    failed += batch.length;
                    consecutiveFailures++;
                    logger.error(`Батч ${b + 1}/${batches.length} не размечен: ${err.message}`);
                    if (consecutiveFailures >= 3) throw new Error('3 батча подряд с ошибкой — останавливаюсь (проверь ключ, каталог и права)');
                    continue;
                }
                consecutiveFailures = 0;
                logger.info(`Батч ${b + 1}/${batches.length}: размечено ${ok}, ошибок ${failed}, ~${client.usage.costRub.toFixed(2)} ₽`);
            }
        } catch (err) {
            status = 'failed';
            error = err.message;
            logger.error(err.message);
        }

        if (status === 'ok' && ok === 0 && failed > 0) { status = 'failed'; error = 'ни одна фраза не размечена'; }
        await finishRun(db, runId, { status, client, itemsTotal: requests.length, itemsOk: ok, itemsFailed: failed, error });
        logger.info(`Готово (run ${runId}, ${status}): ${ok} из ${requests.length}, ~${client.usage.costRub.toFixed(2)} ₽`);
        if (status === 'failed') process.exitCode = 1;
    } finally {
        await db.disconnect();
    }
}

if (require.main === module) {
    main().catch(err => {
        logger.error(`Ошибка разметки: ${err.message}`);
        process.exit(1);
    });
}

module.exports = { sanitize, buildUserPrompt };
