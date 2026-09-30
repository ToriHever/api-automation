-- services/common/data/2026-09_widen_requests_id_seq.sql
-- common.requests.request_id был smallint (максимум 32767) вместе с бэкающей
-- его последовательностью requests_id_seq1 — упёрлись в лимит при первом
-- запуске scripts/sync-gsc-requests.js (2026-09-30). Все таблицы, ссылающиеся
-- на request_id по FK (common.requests_words, wordstat.dynamics_range*,
-- lemmatizer.*, topvisor.positions), уже используют integer — расширение
-- просто приводит PK в соответствие с тем, что остальная схема и так ждала.
--
-- 9 вью зависели от request_id (часть — "теневые", существовавшие только на
-- сервере, не в репозитории: common.v_request_groups, common.v_requests_lemmatized,
-- wordstat.dynamics_summary, wordstat.dynamics_with_change). Дропаем все,
-- меняем тип, пересоздаём один в один по pg_get_viewdef с прод-базы
-- (2026-09-30) — заодно фиксируем их в репозитории, чтобы больше не терялись.
--
-- Применить: psql "$DATABASE_URL" -f services/common/data/2026-09_widen_requests_id_seq.sql

BEGIN;

DROP VIEW IF EXISTS common.v_request_groups;
DROP VIEW IF EXISTS wordstat.dynamics_range_view;
DROP VIEW IF EXISTS analytics.topvisor_group_kpi_monthly;
DROP VIEW IF EXISTS analytics.topvisor_relevance_visibility;
DROP VIEW IF EXISTS wordstat.dynamics_summary;
DROP VIEW IF EXISTS wordstat.dynamics_with_change;
DROP VIEW IF EXISTS wordstat.dynamics_range_daily_view;
DROP VIEW IF EXISTS analytics.v_serp_results;
DROP VIEW IF EXISTS common.v_requests_lemmatized;

ALTER TABLE common.requests
    ALTER COLUMN request_id TYPE integer;

ALTER SEQUENCE common.requests_id_seq1
    AS integer
    MAXVALUE 2147483647;

CREATE VIEW common.v_request_groups AS
SELECT rg.group_id,
    rg.canonical_request,
    rg.lemma_signature,
    count(r.request_id) AS variants_count,
    string_agg(r.request, ' | '::text ORDER BY r.request) AS variants
FROM common.request_groups rg
JOIN common.requests r ON r.group_id = rg.group_id
GROUP BY rg.group_id, rg.canonical_request, rg.lemma_signature;

CREATE VIEW wordstat.dynamics_range_view AS
SELECT r.request_id,
    r.request AS phrase,
    d.month,
    d.frequency
FROM wordstat.dynamics_range d
JOIN common.requests r ON r.request_id = d.request_id
ORDER BY r.request, d.month;

CREATE VIEW analytics.topvisor_group_kpi_monthly AS
WITH positions_scope AS (
    SELECT date_trunc('month', p.event_date::timestamp with time zone)::date AS event_month,
        g.name AS group_name,
        dpe.project_name,
        dpe.search_engine,
        cr.request_id,
        p."position",
        CASE
            WHEN s.url IS NOT NULL AND rtrim(s.url, '/') = rtrim(k.target, '/') THEN 1
            ELSE 0
        END AS is_relevant
    FROM topvisor.positions p
    JOIN topvisor.dim_keywords k ON k.name = p.request
    JOIN topvisor.dim_groups g ON g.id = k.group_id
    JOIN common.dim_projects_engines dpe ON dpe.id = p.project_engine_id
    LEFT JOIN common.site_map s ON s.id = p.relevant_url_id
    LEFT JOIN common.requests cr ON cr.request = p.request
), basic AS (
    SELECT positions_scope.event_month,
        positions_scope.group_name,
        positions_scope.project_name,
        positions_scope.search_engine,
        round(100.0 * sum(positions_scope.is_relevant)::numeric / NULLIF(count(*), 0)::numeric, 2) AS relevance_pct,
        round(avg(CASE WHEN positions_scope.is_relevant = 1 THEN positions_scope."position" ELSE NULL::integer END), 2) AS avg_position_relevant,
        round(avg(CASE WHEN positions_scope.is_relevant = 0 THEN positions_scope."position" ELSE NULL::integer END), 2) AS avg_position_not_relevant
    FROM positions_scope
    GROUP BY positions_scope.event_month, positions_scope.group_name, positions_scope.project_name, positions_scope.search_engine
), per_request AS (
    SELECT positions_scope.event_month,
        positions_scope.group_name,
        positions_scope.project_name,
        positions_scope.search_engine,
        positions_scope.request_id,
        avg(positions_scope."position") AS avg_position
    FROM positions_scope
    WHERE positions_scope.request_id IS NOT NULL
    GROUP BY positions_scope.event_month, positions_scope.group_name, positions_scope.project_name, positions_scope.search_engine, positions_scope.request_id
), weighted AS (
    SELECT pr.event_month,
        pr.group_name,
        pr.project_name,
        pr.search_engine,
        wd.frequency,
        CASE
            WHEN pr.avg_position IS NULL THEN 0
            WHEN pr.avg_position <= 1::numeric THEN 100
            WHEN pr.avg_position <= 2::numeric THEN 85
            WHEN pr.avg_position <= 3::numeric THEN 70
            WHEN pr.avg_position <= 5::numeric THEN 50
            WHEN pr.avg_position <= 10::numeric THEN 30
            WHEN pr.avg_position <= 20::numeric THEN 10
            WHEN pr.avg_position <= 30::numeric THEN 5
            ELSE 0
        END AS coefficient
    FROM per_request pr
    JOIN wordstat.tmp_dynamics wd ON wd.request_id = pr.request_id AND wd.month = pr.event_month
), visibility AS (
    SELECT weighted.event_month,
        weighted.group_name,
        weighted.project_name,
        weighted.search_engine,
        round((sum(weighted.frequency * weighted.coefficient) / NULLIF(sum(weighted.frequency), 0))::numeric, 2) AS visibility_pct
    FROM weighted
    GROUP BY weighted.event_month, weighted.group_name, weighted.project_name, weighted.search_engine
)
SELECT b.event_month,
    b.group_name,
    b.project_name,
    b.search_engine,
    b.relevance_pct,
    v.visibility_pct,
    b.avg_position_relevant,
    b.avg_position_not_relevant
FROM basic b
LEFT JOIN visibility v ON v.event_month = b.event_month AND v.group_name = b.group_name AND v.project_name::text = b.project_name::text AND v.search_engine::text = b.search_engine::text;

CREATE VIEW analytics.topvisor_relevance_visibility AS
SELECT p.event_date,
    date_trunc('month', p.event_date::timestamp with time zone)::date AS event_month,
    g.name AS group_name,
    k.target AS target_url,
    dpe.project_name,
    dpe.search_engine,
    p.request,
    cr.request_id,
    p."position",
    CASE
        WHEN s.url IS NOT NULL AND rtrim(s.url, '/') = rtrim(k.target, '/') THEN 1
        ELSE 0
    END AS is_relevant,
    wd.frequency,
    CASE
        WHEN p."position" IS NULL THEN 0
        WHEN p."position" <= 1 THEN 100
        WHEN p."position" <= 2 THEN 85
        WHEN p."position" <= 3 THEN 70
        WHEN p."position" <= 5 THEN 50
        WHEN p."position" <= 10 THEN 30
        WHEN p."position" <= 20 THEN 10
        WHEN p."position" <= 30 THEN 5
        ELSE 0
    END AS visibility_coefficient
FROM topvisor.positions p
JOIN topvisor.dim_keywords k ON k.name = p.request
JOIN topvisor.dim_groups g ON g.id = k.group_id
JOIN common.dim_projects_engines dpe ON dpe.id = p.project_engine_id
LEFT JOIN common.site_map s ON s.id = p.relevant_url_id
LEFT JOIN common.requests cr ON cr.request = p.request
LEFT JOIN wordstat.tmp_dynamics wd ON wd.request_id = cr.request_id AND wd.month = date_trunc('month', p.event_date::timestamp with time zone)::date;

CREATE VIEW wordstat.dynamics_summary AS
SELECT cr.request,
    count(*) AS total_months,
    sum(wd.frequency) AS total_frequency,
    round(avg(wd.frequency), 2) AS avg_frequency,
    min(wd.frequency) AS min_frequency,
    max(wd.frequency) AS max_frequency,
    min(wd.month) AS first_month,
    max(wd.month) AS last_month,
    wd.group_id
FROM wordstat.tmp_dynamics wd
LEFT JOIN common.requests cr ON wd.request_id = cr.request_id
GROUP BY cr.request, wd.group_id
ORDER BY (sum(wd.frequency)) DESC;

CREATE VIEW wordstat.dynamics_with_change AS
SELECT cr.request,
    to_char(wd.month::timestamp with time zone, 'YYYY-MM') AS month,
    wd.frequency,
    lag(wd.frequency) OVER (PARTITION BY cr.request ORDER BY wd.month) AS prev_frequency,
    wd.frequency - lag(wd.frequency) OVER (PARTITION BY cr.request ORDER BY wd.month) AS change,
    round((wd.frequency - lag(wd.frequency) OVER (PARTITION BY cr.request ORDER BY wd.month))::numeric / NULLIF(lag(wd.frequency) OVER (PARTITION BY cr.request ORDER BY wd.month), 0)::numeric * 100::numeric, 2) AS change_percent,
    wd.group_id
FROM wordstat.tmp_dynamics wd
LEFT JOIN common.requests cr ON wd.request_id = cr.request_id
ORDER BY cr.request, wd.month DESC;

CREATE VIEW wordstat.dynamics_range_daily_view AS
SELECT r.request_id,
    r.request AS phrase,
    d.day,
    d.frequency
FROM wordstat.dynamics_range_daily d
JOIN common.requests r ON r.request_id = d.request_id
ORDER BY r.request, d.day;

CREATE VIEW analytics.v_serp_results AS
SELECT s.event_date,
    s.request,
    s.search_type,
    s.overall_position,
    s.group_position,
    s.doc_position_in_group,
    s.domain,
    s.url AS result_url,
    s.title,
    s.is_own_domain,
    s.target_url_id,
    sm.url AS target_url,
    cr.request_id,
    cr.hub_id,
    h.hub_name AS group_name
FROM yandex.serp_results s
LEFT JOIN common.site_map sm ON sm.id = s.target_url_id
LEFT JOIN common.requests cr ON cr.request = s.request
LEFT JOIN common.hubs h ON h.hub_id = cr.hub_id;

CREATE VIEW common.v_requests_lemmatized AS
SELECT r.request_id,
    r.request,
    string_agg(DISTINCT rw.lemma, ' ' ORDER BY rw.lemma) AS lemmas
FROM common.requests r
JOIN common.requests_words rwds ON rwds.request_id = r.request_id
JOIN common.request_words rw ON rw.word_id = rwds.word_id
GROUP BY r.request_id, r.request;

COMMIT;
