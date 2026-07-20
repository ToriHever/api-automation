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
