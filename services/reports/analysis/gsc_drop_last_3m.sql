-- Просадка органики Google (ddos-guard.ru) за последние 3 месяца: по страницам и запросам.
-- Окно B = последние 90 дней (конец = сегодня - 5, у GSC лаг), окно A = предыдущие 90 дней.
-- Даты считаются от CURRENT_DATE в CTE p — менять нужно только там. Значения «в день».
-- Только чтение. Запуск на VDS: psql "$DATABASE_URL" -f services/reports/analysis/gsc_drop_last_3m.sql
-- GSC по query не отдаёт анонимизированные запросы — суммы ниже, чем в интерфейсе; сравнивать динамику.
-- Колонка cause: new = не было показов в окне A; impr = показы упали >20% (спрос/видимость);
-- pos = позиция ушла вниз >= 1; иначе ctr (сниппет/выдача).

-- ============================================================
-- Q0. По неделям (последние ~26 недель): где именно ломается
-- ============================================================
WITH p AS (SELECT CURRENT_DATE - 5 - 179 AS from_d, CURRENT_DATE - 5 AS to_d)
SELECT to_char(date_trunc('week', sc.event_date), 'YYYY-MM-DD') AS week,
       COUNT(DISTINCT sc.event_date) AS days,
       SUM(sc.clicks) AS clicks,
       SUM(sc.impressions) AS impressions,
       ROUND(SUM(sc.clicks)::numeric * 100 / NULLIF(SUM(sc.impressions), 0), 2) AS ctr_pct,
       ROUND(SUM(sc.position * sc.impressions)::numeric / NULLIF(SUM(sc.impressions), 0), 1) AS avg_position
FROM gsc.search_console sc
JOIN common.site_map sm ON sm.id = sc.target_url
CROSS JOIN p
WHERE sm.url ILIKE 'https://ddos-guard.ru%'
  AND sc.event_date BETWEEN p.from_d AND p.to_d
GROUP BY 1
ORDER BY 1;

-- ============================================================
-- Q1. Бренд / не-бренд: показы vs CTR vs позиция
-- ============================================================
WITH p AS (SELECT CURRENT_DATE - 5 - 89 AS b1, CURRENT_DATE - 5 AS b2, CURRENT_DATE - 5 - 179 AS a1, CURRENT_DATE - 5 - 90 AS a2),
base AS (
    SELECT CASE WHEN sc.event_date BETWEEN p.a1 AND p.a2 THEN 'A' ELSE 'B' END AS win,
           EXISTS (SELECT 1 FROM common.brand_keywords bk WHERE sc.request ILIKE '%' || bk.keyword || '%') AS is_brand,
           sc.clicks, sc.impressions, sc.position
    FROM gsc.search_console sc
    JOIN common.site_map sm ON sm.id = sc.target_url
    CROSS JOIN p
    WHERE sm.url ILIKE 'https://ddos-guard.ru%'
      AND sc.event_date BETWEEN p.a1 AND p.b2
)
SELECT is_brand, win,
       ROUND(SUM(clicks)::numeric / 90, 1) AS clicks_per_day,
       ROUND(SUM(impressions)::numeric / 90, 1) AS impressions_per_day,
       ROUND(SUM(clicks)::numeric * 100 / NULLIF(SUM(impressions), 0), 2) AS ctr_pct,
       ROUND(SUM(position * impressions)::numeric / NULLIF(SUM(impressions), 0), 1) AS avg_position
FROM base
GROUP BY is_brand, win
ORDER BY is_brand, win;

-- ============================================================
-- Q2. Страницы: топ-30 по потере кликов (в день)
-- ============================================================
WITH p AS (SELECT CURRENT_DATE - 5 - 89 AS b1, CURRENT_DATE - 5 AS b2, CURRENT_DATE - 5 - 179 AS a1, CURRENT_DATE - 5 - 90 AS a2),
base AS (
    SELECT rtrim(lower(sm.url), '/') AS url,
           CASE WHEN sc.event_date BETWEEN p.a1 AND p.a2 THEN 'A' ELSE 'B' END AS win,
           sc.clicks, sc.impressions, sc.position
    FROM gsc.search_console sc
    JOIN common.site_map sm ON sm.id = sc.target_url
    CROSS JOIN p
    WHERE sm.url ILIKE 'https://ddos-guard.ru%'
      AND sc.event_date BETWEEN p.a1 AND p.b2
),
agg AS (
    SELECT url,
           COALESCE(SUM(clicks) FILTER (WHERE win = 'A'), 0)::numeric / 90 AS clicks_a,
           COALESCE(SUM(clicks) FILTER (WHERE win = 'B'), 0)::numeric / 90 AS clicks_b,
           COALESCE(SUM(impressions) FILTER (WHERE win = 'A'), 0)::numeric / 90 AS impr_a,
           COALESCE(SUM(impressions) FILTER (WHERE win = 'B'), 0)::numeric / 90 AS impr_b,
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
       ROUND(pos_b, 1) AS pos_b,
       CASE WHEN impr_a = 0 THEN 'new'
            WHEN impr_b < impr_a * 0.8 THEN 'impr'
            WHEN pos_b - pos_a >= 1 THEN 'pos'
            ELSE 'ctr' END AS cause
FROM agg
ORDER BY clicks_b - clicks_a ASC
LIMIT 30;

-- ============================================================
-- Q3. Запросы: топ-40 по потере кликов
-- ============================================================
WITH p AS (SELECT CURRENT_DATE - 5 - 89 AS b1, CURRENT_DATE - 5 AS b2, CURRENT_DATE - 5 - 179 AS a1, CURRENT_DATE - 5 - 90 AS a2),
base AS (
    SELECT sc.request,
           CASE WHEN sc.event_date BETWEEN p.a1 AND p.a2 THEN 'A' ELSE 'B' END AS win,
           sc.clicks, sc.impressions, sc.position
    FROM gsc.search_console sc
    JOIN common.site_map sm ON sm.id = sc.target_url
    CROSS JOIN p
    WHERE sm.url ILIKE 'https://ddos-guard.ru%'
      AND sc.event_date BETWEEN p.a1 AND p.b2
),
agg AS (
    SELECT request,
           COALESCE(SUM(clicks) FILTER (WHERE win = 'A'), 0)::numeric / 90 AS clicks_a,
           COALESCE(SUM(clicks) FILTER (WHERE win = 'B'), 0)::numeric / 90 AS clicks_b,
           COALESCE(SUM(impressions) FILTER (WHERE win = 'A'), 0)::numeric / 90 AS impr_a,
           COALESCE(SUM(impressions) FILTER (WHERE win = 'B'), 0)::numeric / 90 AS impr_b,
           SUM(position * impressions) FILTER (WHERE win = 'A')::numeric / NULLIF(SUM(impressions) FILTER (WHERE win = 'A'), 0) AS pos_a,
           SUM(position * impressions) FILTER (WHERE win = 'B')::numeric / NULLIF(SUM(impressions) FILTER (WHERE win = 'B'), 0) AS pos_b
    FROM base
    GROUP BY request
),
worst AS (
    SELECT * FROM agg ORDER BY clicks_b - clicks_a ASC LIMIT 40
)
SELECT worst.request,
       EXISTS (SELECT 1 FROM common.brand_keywords bk WHERE worst.request ILIKE '%' || bk.keyword || '%') AS is_brand,
       ROUND(clicks_a, 2) AS clicks_day_a,
       ROUND(clicks_b, 2) AS clicks_day_b,
       ROUND(clicks_b - clicks_a, 2) AS delta_clicks_day,
       ROUND(impr_a, 1) AS impr_day_a,
       ROUND(impr_b, 1) AS impr_day_b,
       ROUND(pos_a, 1) AS pos_a,
       ROUND(pos_b, 1) AS pos_b,
       CASE WHEN impr_a = 0 THEN 'new'
            WHEN impr_b < impr_a * 0.8 THEN 'impr'
            WHEN pos_b - pos_a >= 1 THEN 'pos'
            ELSE 'ctr' END AS cause
FROM worst
ORDER BY clicks_b - clicks_a ASC;

-- ============================================================
-- Q4. Пары страница × запрос: топ-30 потерь (что просело на какой странице)
-- ============================================================
WITH p AS (SELECT CURRENT_DATE - 5 - 89 AS b1, CURRENT_DATE - 5 AS b2, CURRENT_DATE - 5 - 179 AS a1, CURRENT_DATE - 5 - 90 AS a2),
base AS (
    SELECT rtrim(lower(sm.url), '/') AS url, sc.request,
           CASE WHEN sc.event_date BETWEEN p.a1 AND p.a2 THEN 'A' ELSE 'B' END AS win,
           sc.clicks, sc.impressions, sc.position
    FROM gsc.search_console sc
    JOIN common.site_map sm ON sm.id = sc.target_url
    CROSS JOIN p
    WHERE sm.url ILIKE 'https://ddos-guard.ru%'
      AND sc.event_date BETWEEN p.a1 AND p.b2
)
SELECT url, request,
       ROUND(COALESCE(SUM(clicks) FILTER (WHERE win = 'A'), 0)::numeric / 90, 2) AS clicks_day_a,
       ROUND(COALESCE(SUM(clicks) FILTER (WHERE win = 'B'), 0)::numeric / 90, 2) AS clicks_day_b,
       ROUND(SUM(position * impressions) FILTER (WHERE win = 'A')::numeric / NULLIF(SUM(impressions) FILTER (WHERE win = 'A'), 0), 1) AS pos_a,
       ROUND(SUM(position * impressions) FILTER (WHERE win = 'B')::numeric / NULLIF(SUM(impressions) FILTER (WHERE win = 'B'), 0), 1) AS pos_b
FROM base
GROUP BY url, request
ORDER BY COALESCE(SUM(clicks) FILTER (WHERE win = 'B'), 0) - COALESCE(SUM(clicks) FILTER (WHERE win = 'A'), 0) ASC
LIMIT 30;

-- ============================================================
-- Q5. Запросы с «дырой» по месяцам: за 6 полных календарных месяцев (до текущего) есть клики,
--     но в каких-то месяцах показов нет совсем. m1 = самый старый месяц, m6 = последний полный.
--     months_present < 6 = в остальных месяцах строк нет. Порог: >= 10 кликов за 6 мес.
-- ============================================================
WITH base AS (
    SELECT sc.request,
           7 + ((EXTRACT(year FROM sc.event_date) * 12 + EXTRACT(month FROM sc.event_date))
              - (EXTRACT(year FROM CURRENT_DATE) * 12 + EXTRACT(month FROM CURRENT_DATE)))::int AS m,
           sc.clicks, sc.impressions
    FROM gsc.search_console sc
    JOIN common.site_map sm ON sm.id = sc.target_url
    WHERE sm.url ILIKE 'https://ddos-guard.ru%'
      AND sc.event_date >= date_trunc('month', CURRENT_DATE) - INTERVAL '6 months'
      AND sc.event_date <  date_trunc('month', CURRENT_DATE)
)
SELECT request,
       EXISTS (SELECT 1 FROM common.brand_keywords bk WHERE base.request ILIKE '%' || bk.keyword || '%') AS is_brand,
       COUNT(DISTINCT m) FILTER (WHERE impressions > 0) AS months_present,
       SUM(clicks) AS clicks_total,
       COALESCE(SUM(clicks) FILTER (WHERE m = 1), 0) AS c_m1, COALESCE(SUM(clicks) FILTER (WHERE m = 2), 0) AS c_m2,
       COALESCE(SUM(clicks) FILTER (WHERE m = 3), 0) AS c_m3, COALESCE(SUM(clicks) FILTER (WHERE m = 4), 0) AS c_m4,
       COALESCE(SUM(clicks) FILTER (WHERE m = 5), 0) AS c_m5, COALESCE(SUM(clicks) FILTER (WHERE m = 6), 0) AS c_m6,
       COALESCE(SUM(impressions) FILTER (WHERE m = 1), 0) AS i_m1, COALESCE(SUM(impressions) FILTER (WHERE m = 2), 0) AS i_m2,
       COALESCE(SUM(impressions) FILTER (WHERE m = 3), 0) AS i_m3, COALESCE(SUM(impressions) FILTER (WHERE m = 4), 0) AS i_m4,
       COALESCE(SUM(impressions) FILTER (WHERE m = 5), 0) AS i_m5, COALESCE(SUM(impressions) FILTER (WHERE m = 6), 0) AS i_m6
FROM base
GROUP BY request
HAVING SUM(clicks) >= 10
   AND COUNT(DISTINCT m) FILTER (WHERE impressions > 0) < 6
ORDER BY SUM(clicks) DESC
LIMIT 100;

-- ============================================================
-- Q6. То же для страниц: URL, у которых в каком-то из 6 месяцев показов нет совсем.
-- ============================================================
WITH base AS (
    SELECT rtrim(lower(sm.url), '/') AS url,
           7 + ((EXTRACT(year FROM sc.event_date) * 12 + EXTRACT(month FROM sc.event_date))
              - (EXTRACT(year FROM CURRENT_DATE) * 12 + EXTRACT(month FROM CURRENT_DATE)))::int AS m,
           sc.clicks, sc.impressions
    FROM gsc.search_console sc
    JOIN common.site_map sm ON sm.id = sc.target_url
    WHERE sm.url ILIKE 'https://ddos-guard.ru%'
      AND sc.event_date >= date_trunc('month', CURRENT_DATE) - INTERVAL '6 months'
      AND sc.event_date <  date_trunc('month', CURRENT_DATE)
)
SELECT url,
       COUNT(DISTINCT m) FILTER (WHERE impressions > 0) AS months_present,
       SUM(clicks) AS clicks_total,
       COALESCE(SUM(clicks) FILTER (WHERE m = 1), 0) AS c_m1, COALESCE(SUM(clicks) FILTER (WHERE m = 2), 0) AS c_m2,
       COALESCE(SUM(clicks) FILTER (WHERE m = 3), 0) AS c_m3, COALESCE(SUM(clicks) FILTER (WHERE m = 4), 0) AS c_m4,
       COALESCE(SUM(clicks) FILTER (WHERE m = 5), 0) AS c_m5, COALESCE(SUM(clicks) FILTER (WHERE m = 6), 0) AS c_m6,
       COALESCE(SUM(impressions) FILTER (WHERE m = 1), 0) AS i_m1, COALESCE(SUM(impressions) FILTER (WHERE m = 2), 0) AS i_m2,
       COALESCE(SUM(impressions) FILTER (WHERE m = 3), 0) AS i_m3, COALESCE(SUM(impressions) FILTER (WHERE m = 4), 0) AS i_m4,
       COALESCE(SUM(impressions) FILTER (WHERE m = 5), 0) AS i_m5, COALESCE(SUM(impressions) FILTER (WHERE m = 6), 0) AS i_m6
FROM base
GROUP BY url
HAVING SUM(clicks) >= 10
   AND COUNT(DISTINCT m) FILTER (WHERE impressions > 0) < 6
ORDER BY SUM(clicks) DESC
LIMIT 100;
