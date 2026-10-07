-- services/ai-nlp/schema.sql
-- Схема `ai`: результаты работы YandexGPT / эмбеддингов над семантическим ядром
-- (common.requests) и выдачей (yandex.serp_results).
-- Идемпотентна — скрипты применяют её сами при каждом запуске.

CREATE SCHEMA IF NOT EXISTS ai;

-- ============================================
-- ai.runs — журнал запусков: что запускали, на какой модели,
-- сколько токенов/денег ушло. Нужен и для контроля бюджета.
-- ============================================
CREATE TABLE IF NOT EXISTS ai.runs (
    run_id          SERIAL PRIMARY KEY,
    task            TEXT NOT NULL CHECK (task IN ('classify', 'embed', 'cluster', 'snippets', 'cluster_summary')),
    model           TEXT,
    status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed')),
    params          JSONB,
    items_total     INTEGER NOT NULL DEFAULT 0,
    items_ok        INTEGER NOT NULL DEFAULT 0,
    items_failed    INTEGER NOT NULL DEFAULT 0,
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    est_cost_rub    NUMERIC(10, 2) NOT NULL DEFAULT 0,
    error           TEXT,
    started_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at     TIMESTAMP
);

COMMENT ON TABLE ai.runs IS 'Журнал запусков AI-задач (классификация, эмбеддинги, кластеризация, анализ сниппетов) с токенами и оценкой стоимости';
COMMENT ON COLUMN ai.runs.est_cost_rub IS 'Оценка по тарифам из services/ai-nlp/config.json (не данные биллинга) — сверяй с консолью Yandex Cloud';

-- ============================================
-- 1. Классификация ядра (YandexGPT)
-- ============================================
CREATE TABLE IF NOT EXISTS ai.request_intent (
    request_id  INTEGER PRIMARY KEY REFERENCES common.requests(request_id) ON DELETE CASCADE,
    intent      TEXT NOT NULL CHECK (intent IN ('commercial', 'informational', 'brand', 'competitor_brand', 'navigational', 'junk')),
    product     TEXT NOT NULL CHECK (product IN ('ddos_protection', 'waf_l7', 'network_l3_l4', 'cdn', 'hosting', 'vds', 'dedicated', 'captcha', 'cloudflare_alt', 'dns', 'other', 'none')),
    stage       TEXT CHECK (stage IN ('awareness', 'consideration', 'purchase')),
    confidence  NUMERIC(3, 2),
    model       TEXT NOT NULL,
    run_id      INTEGER REFERENCES ai.runs(run_id),
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_request_intent_intent  ON ai.request_intent(intent);
CREATE INDEX IF NOT EXISTS idx_request_intent_product ON ai.request_intent(product);

COMMENT ON TABLE ai.request_intent IS 'Интент, продукт и стадия воронки для запроса из common.requests, размеченные YandexGPT';
COMMENT ON COLUMN ai.request_intent.intent IS 'commercial — хотят купить/заказать/узнать цену; informational — что/как/почему; brand — наш бренд (DDoS-Guard); competitor_brand — бренд конкурента; navigational — поиск конкретного сайта/сервиса; junk — не по теме';
COMMENT ON COLUMN ai.request_intent.confidence IS 'Уверенность модели 0–1 (самооценка, не калиброванная вероятность) — ориентир для выборочной ручной проверки';

-- ============================================
-- 2. Эмбеддинги запросов (Foundation Models, textEmbedding)
-- Без pgvector: массив double precision, сравнение косинусом в Node.
-- ============================================
CREATE TABLE IF NOT EXISTS ai.request_embeddings (
    request_id  INTEGER NOT NULL REFERENCES common.requests(request_id) ON DELETE CASCADE,
    model       TEXT NOT NULL,
    dim         INTEGER NOT NULL,
    embedding   DOUBLE PRECISION[] NOT NULL,
    run_id      INTEGER REFERENCES ai.runs(run_id),
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (request_id, model)
);

COMMENT ON TABLE ai.request_embeddings IS 'Векторы запросов (модель text-search-doc); хранятся массивом, pgvector не нужен';

-- ============================================
-- 3. Кластеры (по пересечению URL в выдаче + довешивание по эмбеддингам)
-- ============================================
CREATE TABLE IF NOT EXISTS ai.clusters (
    cluster_id        SERIAL PRIMARY KEY,
    run_id            INTEGER NOT NULL REFERENCES ai.runs(run_id) ON DELETE CASCADE,
    head_request_id   INTEGER REFERENCES common.requests(request_id) ON DELETE SET NULL,
    label             TEXT,
    size              INTEGER NOT NULL DEFAULT 0,
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_clusters_run ON ai.clusters(run_id);

CREATE TABLE IF NOT EXISTS ai.cluster_members (
    cluster_id     INTEGER NOT NULL REFERENCES ai.clusters(cluster_id) ON DELETE CASCADE,
    request_id     INTEGER NOT NULL REFERENCES common.requests(request_id) ON DELETE CASCADE,
    is_head        BOOLEAN NOT NULL DEFAULT false,
    assigned_by    TEXT NOT NULL CHECK (assigned_by IN ('serp', 'embedding')),
    shared_urls    INTEGER,
    similarity     REAL,
    PRIMARY KEY (cluster_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_cluster_members_request ON ai.cluster_members(request_id);

COMMENT ON TABLE ai.clusters IS 'Кластеры запросов; один запуск кластеризации = один run_id (история хранится, актуальный — последний status=ok)';
COMMENT ON COLUMN ai.clusters.label IS 'Короткое название кластера, придуманное YandexGPT';
COMMENT ON COLUMN ai.cluster_members.assigned_by IS 'serp — запрос делит ≥N URL топа с головным запросом; embedding — довешен по косинусной близости (нет данных SERP)';
COMMENT ON COLUMN ai.cluster_members.shared_urls IS 'Сколько URL из топа общие с головным запросом (для assigned_by=serp)';
COMMENT ON COLUMN ai.cluster_members.similarity IS 'Косинус к центроиду кластера (для assigned_by=embedding)';

-- ============================================
-- 4. Разбор сниппетов и тайтлов конкурентов (YandexGPT)
-- ============================================
CREATE TABLE IF NOT EXISTS ai.snippet_analysis (
    serp_result_id  INTEGER PRIMARY KEY REFERENCES yandex.serp_results(id) ON DELETE CASCADE,
    page_type       TEXT CHECK (page_type IN ('landing', 'product', 'blog', 'docs', 'comparison', 'marketplace', 'news', 'other')),
    offers          TEXT[],
    usp             TEXT[],
    features        JSONB,
    model           TEXT NOT NULL,
    run_id          INTEGER REFERENCES ai.runs(run_id),
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_snippet_analysis_page_type ON ai.snippet_analysis(page_type);

COMMENT ON TABLE ai.snippet_analysis IS 'Разбор title/snippet документа из yandex.serp_results: тип страницы, офферы, УТП, признаки';
COMMENT ON COLUMN ai.snippet_analysis.offers IS 'Предложения, которые конкурент выносит в title/snippet (до 4 коротких формулировок)';
COMMENT ON COLUMN ai.snippet_analysis.features IS 'Флаги: price (цена в сниппете), price_text, trial, sla, support_247, capacity (например "до 1 Тбит/с"), geo_ru';

CREATE TABLE IF NOT EXISTS ai.cluster_competitor_summary (
    cluster_id    INTEGER PRIMARY KEY REFERENCES ai.clusters(cluster_id) ON DELETE CASCADE,
    summary       TEXT,
    common_offers JSONB,
    gaps          TEXT,
    model         TEXT NOT NULL,
    run_id        INTEGER REFERENCES ai.runs(run_id),
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE ai.cluster_competitor_summary IS 'Сводка YandexGPT по выдаче кластера: что предлагают конкуренты и чего не хватает нам (gaps)';

-- ============================================
-- Вью для DataLens / SQL
-- ============================================

-- Запросы последней успешной кластеризации
CREATE OR REPLACE VIEW ai.v_request_clusters AS
SELECT
    c.cluster_id,
    c.label            AS cluster_label,
    c.size             AS cluster_size,
    cm.request_id,
    r.request,
    cm.is_head,
    cm.assigned_by,
    cm.shared_urls,
    cm.similarity,
    c.run_id
FROM ai.clusters c
JOIN ai.cluster_members cm ON cm.cluster_id = c.cluster_id
JOIN common.requests r     ON r.request_id = cm.request_id
WHERE c.run_id = (
    SELECT MAX(run_id) FROM ai.runs WHERE task = 'cluster' AND status = 'ok'
);

COMMENT ON VIEW ai.v_request_clusters IS 'Запросы с их кластерами из последнего успешного запуска кластеризации';

-- Запросы с интентом/продуктом
CREATE OR REPLACE VIEW ai.v_request_classified AS
SELECT
    r.request_id,
    r.request,
    ri.intent,
    ri.product,
    ri.stage,
    ri.confidence,
    ri.model
FROM common.requests r
JOIN ai.request_intent ri ON ri.request_id = r.request_id;

COMMENT ON VIEW ai.v_request_classified IS 'common.requests + интент/продукт/стадия от YandexGPT';

-- Что конкуренты выносят в сниппеты: по доменам
CREATE OR REPLACE VIEW ai.v_competitor_offers AS
SELECT
    sr.event_date,
    sr.request,
    sr.overall_position,
    sr.domain,
    sr.is_own_domain,
    sr.url,
    sr.title,
    sa.page_type,
    sa.offers,
    sa.usp,
    (sa.features ->> 'price')::boolean       AS has_price,
    sa.features ->> 'price_text'             AS price_text,
    (sa.features ->> 'trial')::boolean       AS has_trial,
    (sa.features ->> 'sla')::boolean         AS has_sla,
    (sa.features ->> 'support_247')::boolean AS has_support_247,
    sa.features ->> 'capacity'               AS capacity
FROM ai.snippet_analysis sa
JOIN yandex.serp_results sr ON sr.id = sa.serp_result_id;

COMMENT ON VIEW ai.v_competitor_offers IS 'Выдача + разбор сниппетов: офферы, цены, триал, SLA, поддержка 24/7 по доменам';
