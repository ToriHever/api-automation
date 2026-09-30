-- Разбор падения органики Google для ddos-guard.ru с апреля 2026 (по gsc.search_console).
-- Окно A = «до» (2026-01-01 .. 2026-03-31), окно B = «после» (2026-07-01 .. 2026-09-24; у GSC лаг ~5 дней).
-- Окна задаются в CTE p — меняйте даты там (одинаково во всех запросах).
-- Все значения «в день» (клики/показы делятся на число дней окна), потому что окна разной длины.
-- Только чтение. Учтите: GSC по измерению query не отдаёт анонимизированные запросы, поэтому суммы
-- в этой таблице ниже, чем в интерфейсе GSC — сравнивать надо динамику, а не абсолютные цифры.
-- Только https://ddos-guard.ru (без поддоменов).

-- ============================================================
-- Q0. Помесячно: покрытие данных, клики, показы, средняя позиция (смотрим, где ломается)
-- ============================================================
SELECT to_char(date_trunc('month', sc.event_date), 'YYYY-MM') AS m,
       COUNT(DISTINCT sc.event_date) AS days,
       SUM(sc.clicks) AS clicks,
       SUM(sc.impressions) AS impressions,
       ROUND(SUM(sc.clicks)::numeric * 100 / NULLIF(SUM(sc.impressions), 0), 2) AS ctr_pct,
       ROUND(SUM(sc.position * sc.impressions)::numeric / NULLIF(SUM(sc.impressions), 0), 1) AS avg_position
FROM gsc.search_console sc
JOIN common.site_map sm ON sm.id = sc.target_url
WHERE sm.url ILIKE 'https://ddos-guard.ru%'
GROUP BY 1
ORDER BY 1;

-- ============================================================
-- Q1. Бренд / не-бренд: что упало — показы (спрос/видимость), CTR или позиция
-- ============================================================
WITH p AS (SELECT DATE '2026-01-01' AS a1, DATE '2026-03-31' AS a2, DATE '2026-07-01' AS b1, DATE '2026-09-24' AS b2),
rq AS (
    SELECT DISTINCT sc.request
    FROM gsc.search_console sc CROSS JOIN p
    WHERE sc.event_date BETWEEN p.a1 AND p.a2 OR sc.event_date BETWEEN p.b1 AND p.b2
),
br AS (
    SELECT rq.request FROM rq
    WHERE EXISTS (SELECT 1 FROM common.brand_keywords bk WHERE rq.request ILIKE '%' || bk.keyword || '%')
),
base AS (
    SELECT CASE WHEN sc.event_date BETWEEN p.a1 AND p.a2 THEN 'A' ELSE 'B' END AS win,
           (br.request IS NOT NULL) AS is_brand,
           sc.clicks, sc.impressions, sc.position
    FROM gsc.search_console sc
    JOIN common.site_map sm ON sm.id = sc.target_url
    CROSS JOIN p
    LEFT JOIN br ON br.request = sc.request
    WHERE sm.url ILIKE 'https://ddos-guard.ru%'
      AND (sc.event_date BETWEEN p.a1 AND p.a2 OR sc.event_date BETWEEN p.b1 AND p.b2)
)
SELECT is_brand, win,
       ROUND(SUM(clicks)::numeric / (SELECT CASE WHEN win = 'A' THEN a2 - a1 + 1 ELSE b2 - b1 + 1 END FROM p), 1) AS clicks_per_day,
       ROUND(SUM(impressions)::numeric / (SELECT CASE WHEN win = 'A' THEN a2 - a1 + 1 ELSE b2 - b1 + 1 END FROM p), 1) AS impressions_per_day,
       ROUND(SUM(clicks)::numeric * 100 / NULLIF(SUM(impressions), 0), 2) AS ctr_pct,
       ROUND(SUM(position * impressions)::numeric / NULLIF(SUM(impressions), 0), 1) AS avg_position
FROM base
GROUP BY is_brand, win
ORDER BY is_brand, win;

-- ============================================================
-- Q2. Страницы: где потеряны клики (топ-25 по абсолютной потере в день)
-- ============================================================
WITH p AS (SELECT DATE '2026-01-01' AS a1, DATE '2026-03-31' AS a2, DATE '2026-07-01' AS b1, DATE '2026-09-24' AS b2),
base AS (
    SELECT rtrim(lower(sm.url), '/') AS url,
           CASE WHEN sc.event_date BETWEEN p.a1 AND p.a2 THEN 'A' ELSE 'B' END AS win,
           sc.clicks, sc.impressions, sc.position
    FROM gsc.search_console sc
    JOIN common.site_map sm ON sm.id = sc.target_url
    CROSS JOIN p
    WHERE sm.url ILIKE 'https://ddos-guard.ru%'
      AND (sc.event_date BETWEEN p.a1 AND p.a2 OR sc.event_date BETWEEN p.b1 AND p.b2)
),
agg AS (
    SELECT url,
           COALESCE(SUM(clicks) FILTER (WHERE win = 'A'), 0)::numeric / (SELECT a2 - a1 + 1 FROM p) AS clicks_a,
           COALESCE(SUM(clicks) FILTER (WHERE win = 'B'), 0)::numeric / (SELECT b2 - b1 + 1 FROM p) AS clicks_b,
           COALESCE(SUM(impressions) FILTER (WHERE win = 'A'), 0)::numeric / (SELECT a2 - a1 + 1 FROM p) AS impr_a,
           COALESCE(SUM(impressions) FILTER (WHERE win = 'B'), 0)::numeric / (SELECT b2 - b1 + 1 FROM p) AS impr_b,
           SUM(position * impressions) FILTER (WHERE win = 'A')::numeric / NULLIF(SUM(impressions) FILTER (WHERE win = 'A'), 0) AS pos_a,
           SUM(position * impressions) FILTER (WHERE win = 'B')::numeric / NULLIF(SUM(impressions) FILTER (WHERE win = 'B'), 0) AS pos_b
    FROM base
    GROUP BY url
)
SELECT url,
       ROUND(clicks_a, 1) AS clicks_day_a,
       ROUND(clicks_b, 1) AS clicks_day_b,
       ROUND(clicks_b - clicks_a, 1) AS delta_clicks_day,
       ROUND((clicks_b / NULLIF(clicks_a, 0) - 1) * 100) AS delta_pct,
       ROUND(impr_a) AS impr_day_a,
       ROUND(impr_b) AS impr_day_b,
       ROUND(pos_a, 1) AS pos_a,
       ROUND(pos_b, 1) AS pos_b
FROM agg
ORDER BY clicks_b - clicks_a ASC
LIMIT 25;

-- ============================================================
-- Q3. Продукты/группы Топвизора (через analytics.v_gsc_requests_daily): где потеря по группам
-- ============================================================
WITH p AS (SELECT DATE '2026-01-01' AS a1, DATE '2026-03-31' AS a2, DATE '2026-07-01' AS b1, DATE '2026-09-24' AS b2)
SELECT COALESCE(v.project_name, '(не привязано)') AS project,
       COALESCE(v.cluster_topvisor_name, '(не привязано)') AS grp,
       v.is_brand,
       ROUND(COALESCE(SUM(v.clicks) FILTER (WHERE v.event_date BETWEEN p.a1 AND p.a2), 0)::numeric / (p.a2 - p.a1 + 1), 1) AS clicks_day_a,
       ROUND(COALESCE(SUM(v.clicks) FILTER (WHERE v.event_date BETWEEN p.b1 AND p.b2), 0)::numeric / (p.b2 - p.b1 + 1), 1) AS clicks_day_b,
       ROUND((COALESCE(SUM(v.clicks) FILTER (WHERE v.event_date BETWEEN p.b1 AND p.b2), 0)::numeric / (p.b2 - p.b1 + 1))
           - (COALESCE(SUM(v.clicks) FILTER (WHERE v.event_date BETWEEN p.a1 AND p.a2), 0)::numeric / (p.a2 - p.a1 + 1)), 1) AS delta_clicks_day
FROM analytics.v_gsc_requests_daily v CROSS JOIN p
WHERE v.site = 'RU'
  AND (v.event_date BETWEEN p.a1 AND p.a2 OR v.event_date BETWEEN p.b1 AND p.b2)
GROUP BY v.project_name, v.cluster_topvisor_name, v.is_brand, p.a1, p.a2, p.b1, p.b2
ORDER BY delta_clicks_day ASC
LIMIT 25;

-- ============================================================
-- Q4. Запросы: топ-30 по потере кликов (помечено, бренд ли это; позиции и показы до/после)
-- ============================================================
WITH p AS (SELECT DATE '2026-01-01' AS a1, DATE '2026-03-31' AS a2, DATE '2026-07-01' AS b1, DATE '2026-09-24' AS b2),
base AS (
    SELECT sc.request,
           CASE WHEN sc.event_date BETWEEN p.a1 AND p.a2 THEN 'A' ELSE 'B' END AS win,
           sc.clicks, sc.impressions, sc.position
    FROM gsc.search_console sc
    JOIN common.site_map sm ON sm.id = sc.target_url
    CROSS JOIN p
    WHERE sm.url ILIKE 'https://ddos-guard.ru%'
      AND (sc.event_date BETWEEN p.a1 AND p.a2 OR sc.event_date BETWEEN p.b1 AND p.b2)
),
agg AS (
    SELECT request,
           COALESCE(SUM(clicks) FILTER (WHERE win = 'A'), 0)::numeric / (SELECT a2 - a1 + 1 FROM p) AS clicks_a,
           COALESCE(SUM(clicks) FILTER (WHERE win = 'B'), 0)::numeric / (SELECT b2 - b1 + 1 FROM p) AS clicks_b,
           COALESCE(SUM(impressions) FILTER (WHERE win = 'A'), 0)::numeric / (SELECT a2 - a1 + 1 FROM p) AS impr_a,
           COALESCE(SUM(impressions) FILTER (WHERE win = 'B'), 0)::numeric / (SELECT b2 - b1 + 1 FROM p) AS impr_b,
           SUM(position * impressions) FILTER (WHERE win = 'A')::numeric / NULLIF(SUM(impressions) FILTER (WHERE win = 'A'), 0) AS pos_a,
           SUM(position * impressions) FILTER (WHERE win = 'B')::numeric / NULLIF(SUM(impressions) FILTER (WHERE win = 'B'), 0) AS pos_b
    FROM base
    GROUP BY request
),
worst AS (
    SELECT * FROM agg ORDER BY clicks_b - clicks_a ASC LIMIT 30
)
SELECT worst.request,
       EXISTS (SELECT 1 FROM common.brand_keywords bk WHERE worst.request ILIKE '%' || bk.keyword || '%') AS is_brand,
       ROUND(clicks_a, 2) AS clicks_day_a,
       ROUND(clicks_b, 2) AS clicks_day_b,
       ROUND(clicks_b - clicks_a, 2) AS delta_clicks_day,
       ROUND(impr_a, 1) AS impr_day_a,
       ROUND(impr_b, 1) AS impr_day_b,
       ROUND(pos_a, 1) AS pos_a,
       ROUND(pos_b, 1) AS pos_b
FROM worst
ORDER BY clicks_b - clicks_a ASC;
