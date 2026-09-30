-- Пересчёт reports.gsc_segment_monthly с даты $1 (см. scripts/gsc-segments-monthly.js).
-- Сегмент: brand (по тексту запроса) > product (target-страница продуктовой группы Топвизора) >
-- informational (/blog, /terms, /tutorials, /technologies) > other. Только https://ddos-guard.ru.
WITH product_urls AS (
    SELECT DISTINCT url_norm
    FROM analytics.v_topvisor_group_target_urls
    WHERE project_name = 'ddos-guard.ru'
      AND cluster_topvisor_name IN ('L3-4', 'L7', 'VDS/VPS', 'DS', 'Хостинг', 'Главная')
),
rq AS (
    SELECT DISTINCT sc.request FROM gsc.search_console sc WHERE sc.event_date >= $1::date
),
br AS (
    SELECT rq.request FROM rq
    WHERE EXISTS (SELECT 1 FROM common.brand_keywords bk WHERE rq.request ILIKE '%' || bk.keyword || '%')
),
base AS (
    SELECT sc.event_date, sc.clicks, sc.impressions, sc.position,
           CASE WHEN br.request IS NOT NULL THEN 'brand'
                WHEN pu.url_norm IS NOT NULL THEN 'product'
                WHEN sm.url ~* '^https://ddos-guard\.ru/(blog|terms|tutorials|technologies)(/|$)' THEN 'informational'
                ELSE 'other' END AS segment
    FROM gsc.search_console sc
    JOIN common.site_map sm ON sm.id = sc.target_url
    LEFT JOIN br ON br.request = sc.request
    LEFT JOIN product_urls pu ON pu.url_norm = rtrim(lower(sm.url), '/')
    WHERE sc.event_date >= $1::date
      AND sm.url ILIKE 'https://ddos-guard.ru%'
)
INSERT INTO reports.gsc_segment_monthly (month, segment, clicks, impressions, avg_position, days_with_data, days_in_month)
SELECT date_trunc('month', event_date)::date,
       segment,
       SUM(clicks),
       SUM(impressions),
       ROUND(SUM(position * impressions)::numeric / NULLIF(SUM(impressions), 0), 2),
       COUNT(DISTINCT event_date),
       EXTRACT(DAY FROM (date_trunc('month', event_date) + INTERVAL '1 month - 1 day'))::int
FROM base
GROUP BY 1, 2;
