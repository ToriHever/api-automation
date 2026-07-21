-- services/analytics/schema.sql
-- Схема analytics существует на сервере, но не была отражена в репозитории
-- (см. миграцию БД в services/common/schema.sql и разбор структуры в чате).
-- Этот файл добавляет только новую view для чартов релевантности/видимости
-- группы запросов — не трогает существующие analytics.v_gsc_* и common.products.
--
-- Группа/target URL резолвятся через topvisor.dim_keywords/dim_groups
-- (синкается напрямую из API TopVisor, scripts/sync-topvisor-structure.js),
-- НЕ через common.clusters_topvisor/common.requests.cluster_topvisor_id —
-- та связка заполнялась вручную и содержала коллизию (много запросов с
-- cluster_topvisor_id = 0 ошибочно "прилипали" к случайному кластеру с id=0).

CREATE SCHEMA IF NOT EXISTS analytics;

-- ============================================================
-- topvisor_relevance_visibility — сырые данные для DataLens-датасета
-- (мультииндикатор: релевантность / видимость / средняя позиция).
-- Гранулярность: одна строка = одна проверка позиции за день.
-- Используй в DataLens как обычный Dataset (не QL), считай метрики
-- нативными полями/формулами:
--   relevance_pct            = AVG(is_relevant) * 100
--   avg_position_relevant    = AVG(position) WHERE is_relevant = 1
--   avg_position_not_relevant= AVG(position) WHERE is_relevant = 0
--   visibility_pct            = SUM(frequency * visibility_coefficient) / SUM(frequency)
-- ============================================================

CREATE OR REPLACE VIEW analytics.topvisor_relevance_visibility AS
SELECT
    p.event_date,
    date_trunc('month', p.event_date)::date AS event_month,
    g.name AS group_name,
    k.target AS target_url,
    dpe.project_name,
    dpe.search_engine,
    p.request,
    cr.request_id,
    p.position,
    CASE WHEN s.url IS NOT NULL AND rtrim(s.url, '/') = rtrim(k.target, '/') THEN 1 ELSE 0 END AS is_relevant,
    wd.frequency,
    CASE
        WHEN p.position IS NULL THEN 0
        WHEN p.position <= 1 THEN 100
        WHEN p.position <= 2 THEN 85
        WHEN p.position <= 3 THEN 70
        WHEN p.position <= 5 THEN 50
        WHEN p.position <= 10 THEN 30
        WHEN p.position <= 20 THEN 10
        WHEN p.position <= 30 THEN 5
        ELSE 0
    END AS visibility_coefficient
FROM topvisor.positions p
JOIN topvisor.dim_keywords k ON k.name = p.request
JOIN topvisor.dim_groups g ON g.id = k.group_id
JOIN common.dim_projects_engines dpe ON dpe.id = p.project_engine_id
LEFT JOIN common.site_map s ON s.id = p.relevant_url_id
LEFT JOIN common.requests cr ON cr.request = p.request
LEFT JOIN wordstat.tmp_dynamics wd
    ON wd.request_id = cr.request_id
   AND wd.month = date_trunc('month', p.event_date)::date;

COMMENT ON VIEW analytics.topvisor_relevance_visibility IS 'Сырые данные (день × запрос) для мультииндикатора релевантности/видимости группы в DataLens. Группа/target — из topvisor.dim_keywords/dim_groups (живой API TopVisor). Частота (wd.frequency) — из wordstat.tmp_dynamics за тот же месяц, коэффициент видимости считается по позиции того дня.';

-- ============================================================
-- topvisor_group_kpi_monthly — ГОТОВЫЕ посчитанные метрики.
-- Одна строка = один месяц × группа × проект × поисковая система.
-- В DataLens: подключаешь как обычный Dataset, фильтруешь стандартными
-- Filters по event_month/group_name/project_name/search_engine,
-- в Индикаторы кидаешь готовые колонки relevance_pct/visibility_pct/
-- avg_position_relevant/avg_position_not_relevant — без единой формулы.
-- ============================================================

CREATE OR REPLACE VIEW analytics.topvisor_group_kpi_monthly AS
WITH positions_scope AS (
    SELECT
        date_trunc('month', p.event_date)::date AS event_month,
        g.name AS group_name,
        dpe.project_name,
        dpe.search_engine,
        cr.request_id,
        p.position,
        CASE WHEN s.url IS NOT NULL AND rtrim(s.url, '/') = rtrim(k.target, '/') THEN 1 ELSE 0 END AS is_relevant
    FROM topvisor.positions p
    JOIN topvisor.dim_keywords k ON k.name = p.request
    JOIN topvisor.dim_groups g ON g.id = k.group_id
    JOIN common.dim_projects_engines dpe ON dpe.id = p.project_engine_id
    LEFT JOIN common.site_map s ON s.id = p.relevant_url_id
    LEFT JOIN common.requests cr ON cr.request = p.request
),
basic AS (
    SELECT
        event_month, group_name, project_name, search_engine,
        ROUND(100.0 * SUM(is_relevant) / NULLIF(COUNT(*), 0), 2) AS relevance_pct,
        ROUND(AVG(CASE WHEN is_relevant = 1 THEN position END)::numeric, 2) AS avg_position_relevant,
        ROUND(AVG(CASE WHEN is_relevant = 0 THEN position END)::numeric, 2) AS avg_position_not_relevant
    FROM positions_scope
    GROUP BY event_month, group_name, project_name, search_engine
),
per_request AS (
    SELECT event_month, group_name, project_name, search_engine, request_id, AVG(position) AS avg_position
    FROM positions_scope
    WHERE request_id IS NOT NULL
    GROUP BY event_month, group_name, project_name, search_engine, request_id
),
weighted AS (
    SELECT
        pr.event_month, pr.group_name, pr.project_name, pr.search_engine,
        wd.frequency,
        CASE
            WHEN pr.avg_position IS NULL THEN 0
            WHEN pr.avg_position <= 1 THEN 100
            WHEN pr.avg_position <= 2 THEN 85
            WHEN pr.avg_position <= 3 THEN 70
            WHEN pr.avg_position <= 5 THEN 50
            WHEN pr.avg_position <= 10 THEN 30
            WHEN pr.avg_position <= 20 THEN 10
            WHEN pr.avg_position <= 30 THEN 5
            ELSE 0
        END AS coefficient
    FROM per_request pr
    JOIN wordstat.tmp_dynamics wd
        ON wd.request_id = pr.request_id
       AND wd.month = pr.event_month
),
visibility AS (
    SELECT
        event_month, group_name, project_name, search_engine,
        ROUND(SUM(frequency * coefficient) / NULLIF(SUM(frequency), 0), 2) AS visibility_pct
    FROM weighted
    GROUP BY event_month, group_name, project_name, search_engine
)
SELECT
    b.event_month,
    b.group_name,
    b.project_name,
    b.search_engine,
    b.relevance_pct,
    v.visibility_pct,
    b.avg_position_relevant,
    b.avg_position_not_relevant
FROM basic b
LEFT JOIN visibility v
    ON v.event_month = b.event_month
   AND v.group_name = b.group_name
   AND v.project_name = b.project_name
   AND v.search_engine = b.search_engine;

COMMENT ON VIEW analytics.topvisor_group_kpi_monthly IS 'Готовые метрики (релевантность %, взвешенная видимость %, средняя позиция по релевантным/нерелевантным) на месяц × группу × проект × ПС. Группа — из topvisor.dim_keywords/dim_groups. Считать в DataLens ничего не нужно, только визуализировать.';

-- ============================================================
-- topvisor_group_kpi_period — ВСЕ 4 метрики на одинаковых скользящих
-- окнах: current = последние 30 дней, prev = предыдущие 30 дней.
-- Видимость — без взвешивания по частоте (простое среднее коэффициента
-- по позиции), не зависит от wordstat.tmp_dynamics.
-- Под комбинированный текстовый Indicator-виджет со стрелками ▲/▼.
-- ============================================================

CREATE OR REPLACE VIEW analytics.topvisor_group_kpi_period AS
WITH positions_scope AS (
    SELECT
        CASE
            WHEN p.event_date >= CURRENT_DATE - 29 THEN 'current'
            WHEN p.event_date BETWEEN CURRENT_DATE - 59 AND CURRENT_DATE - 30 THEN 'prev'
        END AS period,
        g.name AS group_name,
        dpe.project_name,
        dpe.search_engine,
        p.request,
        p.position,
        CASE WHEN s.url IS NOT NULL AND rtrim(s.url, '/') = rtrim(k.target, '/') THEN 1 ELSE 0 END AS is_relevant
    FROM topvisor.positions p
    JOIN topvisor.dim_keywords k ON k.name = p.request
    JOIN topvisor.dim_groups g ON g.id = k.group_id
    JOIN common.dim_projects_engines dpe ON dpe.id = p.project_engine_id
    LEFT JOIN common.site_map s ON s.id = p.relevant_url_id
    WHERE p.event_date >= CURRENT_DATE - 59
),
scoped AS (
    SELECT * FROM positions_scope WHERE period IS NOT NULL
),
basic AS (
    SELECT
        period, group_name, project_name, search_engine,
        ROUND(100.0 * SUM(is_relevant) / NULLIF(COUNT(*), 0), 2) AS relevance_pct,
        ROUND(AVG(CASE WHEN is_relevant = 1 THEN position END)::numeric, 2) AS avg_position_relevant,
        ROUND(AVG(CASE WHEN is_relevant = 0 THEN position END)::numeric, 2) AS avg_position_not_relevant
    FROM scoped
    GROUP BY period, group_name, project_name, search_engine
),
per_request AS (
    SELECT period, group_name, project_name, search_engine, request, AVG(position) AS avg_position
    FROM scoped
    GROUP BY period, group_name, project_name, search_engine, request
),
coeff AS (
    SELECT
        period, group_name, project_name, search_engine,
        CASE
            WHEN avg_position IS NULL THEN 0
            WHEN avg_position <= 1 THEN 100
            WHEN avg_position <= 2 THEN 85
            WHEN avg_position <= 3 THEN 70
            WHEN avg_position <= 5 THEN 50
            WHEN avg_position <= 10 THEN 30
            WHEN avg_position <= 20 THEN 10
            WHEN avg_position <= 30 THEN 5
            ELSE 0
        END AS coefficient
    FROM per_request
),
visibility AS (
    SELECT
        period, group_name, project_name, search_engine,
        ROUND(AVG(coefficient)::numeric, 2) AS visibility_pct
    FROM coeff
    GROUP BY period, group_name, project_name, search_engine
)
SELECT
    b.period,
    b.group_name,
    b.project_name,
    b.search_engine,
    b.relevance_pct,
    v.visibility_pct,
    b.avg_position_relevant,
    b.avg_position_not_relevant
FROM basic b
LEFT JOIN visibility v
    ON v.period = b.period
   AND v.group_name = b.group_name
   AND v.project_name = b.project_name
   AND v.search_engine = b.search_engine;

COMMENT ON VIEW analytics.topvisor_group_kpi_period IS 'Все 4 метрики на одинаковых скользящих окнах 30 дней: current = последние 30 дней, prev = предыдущие 30 дней. Группа — из topvisor.dim_keywords/dim_groups. Видимость без взвешивания по частоте.';

-- ============================================================
-- v_gsc_requests_daily — базовая вью по данным GSC (gsc.search_console),
-- обогащённая связкой с TopVisor-структурой и брендовой/доменной разметкой.
-- Гранулярность: одна строка = день × запрос × страница (product).
-- Используется как единственный источник для всех v_gsc_requests_* ниже —
-- не трогай напрямую gsc.search_console в новых вью, наследуйся отсюда.
-- ============================================================

CREATE OR REPLACE VIEW analytics.v_gsc_requests_daily AS
WITH url_cluster_map AS (
    -- один target_url -> один кластер (если URL зашит в 2 группы, берём первую по id)
    SELECT DISTINCT ON (rtrim(lower(k.target), '/'))
        rtrim(lower(k.target), '/') AS target_url_norm,
        g.name AS cluster_topvisor_name,
        dpe.project_name
    FROM topvisor.dim_keywords k
    JOIN topvisor.dim_groups g ON g.id = k.group_id
    JOIN topvisor.dim_projects tp ON tp.id = k.project_id
    JOIN common.dim_projects_engines dpe ON dpe.topvisor_project_id = tp.id::text
    WHERE k.target IS NOT NULL
    ORDER BY rtrim(lower(k.target), '/'), g.id
),
cluster_keywords AS (
    SELECT DISTINCT
        rtrim(lower(k.target), '/') AS target_url_norm,
        k.name AS request
    FROM topvisor.dim_keywords k
    WHERE k.target IS NOT NULL
)
SELECT
    p.product_name,
    sc.event_date,
    sc.request,
    sc.clicks,
    sc.impressions,
    round(sc.ctr::numeric * 100::numeric, 2) AS ctr,
    round(sc."position"::numeric, 2) AS "position",
    ucm.project_name,
    ucm.cluster_topvisor_name,
    (ck.request IS NOT NULL) AS is_cluster_keyword,
    EXISTS (
        SELECT 1 FROM common.brand_keywords bk
        WHERE sc.request ILIKE '%' || bk.keyword || '%'
    ) AS is_brand,
    CASE
        WHEN sm.url ILIKE 'https://ddos-guard.ru%'  THEN 'RU'
        WHEN sm.url ILIKE 'https://ddos-guard.net%' THEN 'EN'
        ELSE 'other'
    END AS site
FROM gsc.search_console sc
JOIN common.products p ON p.url_id = sc.target_url
JOIN common.site_map sm ON sm.id = sc.target_url
LEFT JOIN url_cluster_map ucm ON ucm.target_url_norm = rtrim(lower(sm.url), '/')
LEFT JOIN cluster_keywords ck ON ck.target_url_norm = rtrim(lower(sm.url), '/') AND ck.request = sc.request
WHERE sc.event_date >= (CURRENT_DATE - '6 mons'::interval);

COMMENT ON VIEW analytics.v_gsc_requests_daily IS 'Базовая вью по gsc.search_console (последние 6 мес.), обогащённая project_name/cluster_topvisor_name (через topvisor.dim_keywords/dim_groups), is_cluster_keyword, is_brand (common.brand_keywords) и site (RU/EN по домену). Источник для всех остальных v_gsc_requests_*.';

-- ============================================================
-- v_gsc_requests_agg — current/prev (30 дней скользящих) на уровне
-- product_name × request, брендовые запросы (is_brand) ИСКЛЮЧЕНЫ.
-- Источник для v_gsc_requests_kpi.
-- ============================================================

CREATE OR REPLACE VIEW analytics.v_gsc_requests_agg AS
WITH current_period AS (
    SELECT
        product_name, request, 'current'::text AS period,
        sum(clicks) AS clicks,
        sum(impressions) AS impressions,
        round(avg(ctr), 4) AS ctr,
        round(avg("position"), 0) AS "position",
        CASE WHEN avg("position") <= 3.5 THEN 1 ELSE 0 END AS in_top3,
        CASE WHEN avg("position") > 3.5 AND avg("position") <= 5.5 THEN 1 ELSE 0 END AS in_top5,
        CASE WHEN avg("position") > 5.5 AND avg("position") <= 10.5 THEN 1 ELSE 0 END AS in_top10,
        project_name, cluster_topvisor_name,
        bool_or(is_cluster_keyword) AS is_cluster_keyword
    FROM analytics.v_gsc_requests_daily
    WHERE event_date >= (CURRENT_DATE - '30 days'::interval)
      AND NOT is_brand
    GROUP BY product_name, request, project_name, cluster_topvisor_name
),
prev_period AS (
    SELECT
        product_name, request, 'prev'::text AS period,
        sum(clicks) AS clicks,
        sum(impressions) AS impressions,
        round(avg(ctr), 4) AS ctr,
        round(avg("position"), 0) AS "position",
        CASE WHEN avg("position") <= 3.5 THEN 1 ELSE 0 END AS in_top3,
        CASE WHEN avg("position") > 3.5 AND avg("position") <= 5.5 THEN 1 ELSE 0 END AS in_top5,
        CASE WHEN avg("position") > 5.5 AND avg("position") <= 10.5 THEN 1 ELSE 0 END AS in_top10,
        project_name, cluster_topvisor_name,
        bool_or(is_cluster_keyword) AS is_cluster_keyword
    FROM analytics.v_gsc_requests_daily
    WHERE event_date >= (CURRENT_DATE - '60 days'::interval)
      AND event_date < (CURRENT_DATE - '30 days'::interval)
      AND NOT is_brand
    GROUP BY product_name, request, project_name, cluster_topvisor_name
)
SELECT * FROM current_period
UNION ALL
SELECT * FROM prev_period;

COMMENT ON VIEW analytics.v_gsc_requests_agg IS 'current/prev (скользящие 30 дней) на уровне product_name×request, без брендовых запросов (NOT is_brand). Источник для v_gsc_requests_kpi.';

-- ============================================================
-- v_gsc_requests_kpi — ГОТОВЫЕ метрики для DataLens-датасета/RichText-блоков
-- ТОП3/ТОП5/ТОП10/Все (bucket) × режим "все запросы"/"только запросы
-- кластера" (mode) × product_name/project_name/cluster_topvisor_name.
-- В DataLens формулах: MAX(IF [bucket]='top3' AND [mode]='all' THEN [x] END)
-- либо фильтр-селектор на дашборде по полю mode (тогда в формулах хватает
-- только [bucket]). Никакой агрегации в самом DataLens не считать.
-- ============================================================

CREATE OR REPLACE VIEW analytics.v_gsc_requests_kpi AS
WITH base AS (
    SELECT * FROM analytics.v_gsc_requests_agg
),
buckets AS (
    SELECT product_name, project_name, cluster_topvisor_name, period, request, clicks, impressions, ctr, position, 'top3'  AS bucket, 'all' AS mode FROM base WHERE in_top3 = 1
    UNION ALL
    SELECT product_name, project_name, cluster_topvisor_name, period, request, clicks, impressions, ctr, position, 'top3'  AS bucket, 'keywords_only' AS mode FROM base WHERE in_top3 = 1 AND is_cluster_keyword
    UNION ALL
    SELECT product_name, project_name, cluster_topvisor_name, period, request, clicks, impressions, ctr, position, 'top5'  AS bucket, 'all' AS mode FROM base WHERE in_top5 = 1
    UNION ALL
    SELECT product_name, project_name, cluster_topvisor_name, period, request, clicks, impressions, ctr, position, 'top5'  AS bucket, 'keywords_only' AS mode FROM base WHERE in_top5 = 1 AND is_cluster_keyword
    UNION ALL
    SELECT product_name, project_name, cluster_topvisor_name, period, request, clicks, impressions, ctr, position, 'top10' AS bucket, 'all' AS mode FROM base WHERE in_top10 = 1
    UNION ALL
    SELECT product_name, project_name, cluster_topvisor_name, period, request, clicks, impressions, ctr, position, 'top10' AS bucket, 'keywords_only' AS mode FROM base WHERE in_top10 = 1 AND is_cluster_keyword
    UNION ALL
    SELECT product_name, project_name, cluster_topvisor_name, period, request, clicks, impressions, ctr, position, 'all'   AS bucket, 'all' AS mode FROM base
    UNION ALL
    SELECT product_name, project_name, cluster_topvisor_name, period, request, clicks, impressions, ctr, position, 'all'   AS bucket, 'keywords_only' AS mode FROM base WHERE is_cluster_keyword
),
agg AS (
    SELECT
        product_name, project_name, cluster_topvisor_name, bucket, mode, period,
        COUNT(DISTINCT request)          AS requests_count,
        SUM(clicks)                      AS clicks_sum,
        SUM(impressions)                 AS impressions_sum,
        ROUND(AVG(ctr)::numeric, 4)      AS ctr_avg,
        ROUND(AVG(position)::numeric, 0) AS position_avg
    FROM buckets
    GROUP BY product_name, project_name, cluster_topvisor_name, bucket, mode, period
),
pivoted AS (
    SELECT
        product_name, project_name, cluster_topvisor_name, bucket, mode,
        MAX(requests_count)    FILTER (WHERE period = 'current') AS requests_current,
        MAX(requests_count)    FILTER (WHERE period = 'prev')    AS requests_prev,
        MAX(clicks_sum)        FILTER (WHERE period = 'current') AS clicks_current,
        MAX(clicks_sum)        FILTER (WHERE period = 'prev')    AS clicks_prev,
        MAX(impressions_sum)   FILTER (WHERE period = 'current') AS impressions_current,
        MAX(impressions_sum)   FILTER (WHERE period = 'prev')    AS impressions_prev,
        MAX(ctr_avg)           FILTER (WHERE period = 'current') AS ctr_current,
        MAX(ctr_avg)           FILTER (WHERE period = 'prev')    AS ctr_prev,
        MAX(position_avg)      FILTER (WHERE period = 'current') AS position_current,
        MAX(position_avg)      FILTER (WHERE period = 'prev')    AS position_prev
    FROM agg
    GROUP BY product_name, project_name, cluster_topvisor_name, bucket, mode
),
totals AS (
    SELECT product_name, project_name, cluster_topvisor_name, mode, requests_current AS total_requests_current
    FROM pivoted WHERE bucket = 'all'
)
SELECT
    p.product_name,
    p.project_name,
    p.cluster_topvisor_name,
    p.bucket,
    p.mode,
    p.requests_current, p.requests_prev,
    ROUND((p.requests_current - p.requests_prev) * 100.0 / NULLIF(p.requests_prev, 0), 0) AS dyn_requests_pct,
    p.clicks_current, p.clicks_prev,
    ROUND((p.clicks_current - p.clicks_prev) * 100.0 / NULLIF(p.clicks_prev, 0), 0) AS dyn_clicks_pct,
    p.impressions_current, p.impressions_prev,
    ROUND((p.impressions_current - p.impressions_prev) * 100.0 / NULLIF(p.impressions_prev, 0), 0) AS dyn_impressions_pct,
    p.ctr_current, p.ctr_prev,
    ROUND((p.ctr_current - p.ctr_prev) * 100.0 / NULLIF(p.ctr_prev, 0), 4) AS dyn_ctr_pct,
    p.position_current, p.position_prev,
    ROUND((p.position_prev - p.position_current) * 100.0 / NULLIF(p.position_prev, 0), 0) AS dyn_position_pct,
    ROUND(p.requests_current * 100.0 / NULLIF(t.total_requests_current, 0), 0) AS pct_of_total
FROM pivoted p
LEFT JOIN totals t
    ON t.product_name = p.product_name
   AND t.project_name IS NOT DISTINCT FROM p.project_name
   AND t.cluster_topvisor_name IS NOT DISTINCT FROM p.cluster_topvisor_name
   AND t.mode = p.mode;

COMMENT ON VIEW analytics.v_gsc_requests_kpi IS 'Готовые KPI (ТОП3/5/10/все × режим all/keywords_only) для RichText-блоков DataLens поверх v_gsc_requests_agg (без бренда). DataLens ничего не агрегирует, только выбирает bucket/mode через MAX(IF ...) или дашборд-селектор.';

-- ============================================================
-- v_gsc_requests_kpi_brand — та же логика ТОП3/5/10/все, что и
-- v_gsc_requests_kpi, но только по брендовым запросам (is_brand) и
-- только с одним измерением site (RU/EN/other) — без project/cluster/mode,
-- потому что бренд-дашборд не завязан на конкретный TopVisor-кластер.
-- ============================================================

CREATE OR REPLACE VIEW analytics.v_gsc_requests_kpi_brand AS
WITH base AS (
    SELECT site, event_date, request, clicks, impressions, ctr, position
    FROM analytics.v_gsc_requests_daily
    WHERE is_brand
),
current_period AS (
    SELECT
        site, request, 'current'::text AS period,
        sum(clicks) AS clicks,
        sum(impressions) AS impressions,
        round(avg(ctr), 4) AS ctr,
        round(avg(position), 0) AS position,
        CASE WHEN avg(position) <= 3.5 THEN 1 ELSE 0 END AS in_top3,
        CASE WHEN avg(position) > 3.5 AND avg(position) <= 5.5 THEN 1 ELSE 0 END AS in_top5,
        CASE WHEN avg(position) > 5.5 AND avg(position) <= 10.5 THEN 1 ELSE 0 END AS in_top10
    FROM base
    WHERE event_date >= (CURRENT_DATE - '30 days'::interval)
    GROUP BY site, request
),
prev_period AS (
    SELECT
        site, request, 'prev'::text AS period,
        sum(clicks) AS clicks,
        sum(impressions) AS impressions,
        round(avg(ctr), 4) AS ctr,
        round(avg(position), 0) AS position,
        CASE WHEN avg(position) <= 3.5 THEN 1 ELSE 0 END AS in_top3,
        CASE WHEN avg(position) > 3.5 AND avg(position) <= 5.5 THEN 1 ELSE 0 END AS in_top5,
        CASE WHEN avg(position) > 5.5 AND avg(position) <= 10.5 THEN 1 ELSE 0 END AS in_top10
    FROM base
    WHERE event_date >= (CURRENT_DATE - '60 days'::interval)
      AND event_date < (CURRENT_DATE - '30 days'::interval)
    GROUP BY site, request
),
agg_base AS (
    SELECT * FROM current_period
    UNION ALL
    SELECT * FROM prev_period
),
buckets AS (
    SELECT site, period, request, clicks, impressions, ctr, position, 'top3'  AS bucket FROM agg_base WHERE in_top3 = 1
    UNION ALL
    SELECT site, period, request, clicks, impressions, ctr, position, 'top5'  AS bucket FROM agg_base WHERE in_top5 = 1
    UNION ALL
    SELECT site, period, request, clicks, impressions, ctr, position, 'top10' AS bucket FROM agg_base WHERE in_top10 = 1
    UNION ALL
    SELECT site, period, request, clicks, impressions, ctr, position, 'all'   AS bucket FROM agg_base
),
agg AS (
    SELECT
        site, bucket, period,
        COUNT(DISTINCT request)          AS requests_count,
        SUM(clicks)                      AS clicks_sum,
        SUM(impressions)                 AS impressions_sum,
        ROUND(AVG(ctr)::numeric, 4)      AS ctr_avg,
        ROUND(AVG(position)::numeric, 0) AS position_avg
    FROM buckets
    GROUP BY site, bucket, period
),
pivoted AS (
    SELECT
        site, bucket,
        MAX(requests_count)    FILTER (WHERE period = 'current') AS requests_current,
        MAX(requests_count)    FILTER (WHERE period = 'prev')    AS requests_prev,
        MAX(clicks_sum)        FILTER (WHERE period = 'current') AS clicks_current,
        MAX(clicks_sum)        FILTER (WHERE period = 'prev')    AS clicks_prev,
        MAX(impressions_sum)   FILTER (WHERE period = 'current') AS impressions_current,
        MAX(impressions_sum)   FILTER (WHERE period = 'prev')    AS impressions_prev,
        MAX(ctr_avg)           FILTER (WHERE period = 'current') AS ctr_current,
        MAX(ctr_avg)           FILTER (WHERE period = 'prev')    AS ctr_prev,
        MAX(position_avg)      FILTER (WHERE period = 'current') AS position_current,
        MAX(position_avg)      FILTER (WHERE period = 'prev')    AS position_prev
    FROM agg
    GROUP BY site, bucket
),
totals AS (
    SELECT site, requests_current AS total_requests_current
    FROM pivoted WHERE bucket = 'all'
)
SELECT
    p.site,
    p.bucket,
    p.requests_current, p.requests_prev,
    ROUND((p.requests_current - p.requests_prev) * 100.0 / NULLIF(p.requests_prev, 0), 0) AS dyn_requests_pct,
    p.clicks_current, p.clicks_prev,
    ROUND((p.clicks_current - p.clicks_prev) * 100.0 / NULLIF(p.clicks_prev, 0), 0) AS dyn_clicks_pct,
    p.impressions_current, p.impressions_prev,
    ROUND((p.impressions_current - p.impressions_prev) * 100.0 / NULLIF(p.impressions_prev, 0), 0) AS dyn_impressions_pct,
    p.ctr_current, p.ctr_prev,
    ROUND((p.ctr_current - p.ctr_prev) * 100.0 / NULLIF(p.ctr_prev, 0), 4) AS dyn_ctr_pct,
    p.position_current, p.position_prev,
    ROUND((p.position_prev - p.position_current) * 100.0 / NULLIF(p.position_prev, 0), 0) AS dyn_position_pct,
    ROUND(p.requests_current * 100.0 / NULLIF(t.total_requests_current, 0), 0) AS pct_of_total
FROM pivoted p
LEFT JOIN totals t ON t.site = p.site;

COMMENT ON VIEW analytics.v_gsc_requests_kpi_brand IS 'Та же логика bucket (top3/top5/top10/all) × current/prev, что и v_gsc_requests_kpi, но только по брендовым запросам (is_brand) и с одним измерением site (RU/EN/other) вместо project/cluster/mode.';
