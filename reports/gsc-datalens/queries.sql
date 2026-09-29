-- Выгрузка для HTML-отчёта GSC в DataLens.
-- Периоды: текущий = последние 30 полных дней, предыдущий = 30 дней до него
-- (GSC отдаёт данные с лагом ~2 дня, поэтому конец периода = сегодня - 2).
--
-- Запуск (пример):
--   psql "$DATABASE_URL" -At -f queries.sql -o data.json
-- Итоговый JSON целиком — один объект, его читает `node build.js --data data.json`.

WITH bounds AS (
    SELECT (CURRENT_DATE - 2)                  AS cur_to,
           (CURRENT_DATE - 2 - 29)             AS cur_from,
           (CURRENT_DATE - 2 - 30)             AS prev_to,
           (CURRENT_DATE - 2 - 59)             AS prev_from
),
base AS (
    SELECT d.*, CASE WHEN d.event_date BETWEEN b.cur_from AND b.cur_to THEN 'current' ELSE 'previous' END AS period
    FROM analytics.v_gsc_requests_daily d, bounds b
    WHERE d.event_date BETWEEN b.prev_from AND b.cur_to
),
daily AS (
    -- position тут взвешена по показам (в JS усредняется как SUM(pos*impr)/SUM(impr))
    SELECT event_date::text AS date, period, site, is_brand AS brand,
           SUM(clicks)::int AS clicks, SUM(impressions)::int AS impressions,
           ROUND((SUM("position" * impressions) / NULLIF(SUM(impressions), 0))::numeric, 2) AS position
    FROM base
    GROUP BY 1, 2, 3, 4
),
req AS (
    -- ctr считаем как SUM(clicks)/SUM(impressions) — не AVG(ctr), см. "Известные грабли"
    SELECT request, site, is_brand AS brand,
           MAX(cluster_topvisor_name) AS cluster,
           SUM(clicks) FILTER (WHERE period = 'current')::int        AS clicks,
           SUM(impressions) FILTER (WHERE period = 'current')::int   AS impressions,
           ROUND((SUM("position" * impressions) FILTER (WHERE period = 'current')
                  / NULLIF(SUM(impressions) FILTER (WHERE period = 'current'), 0))::numeric, 2) AS position,
           COALESCE(SUM(clicks) FILTER (WHERE period = 'previous'), 0)::int AS clicks_prev,
           ROUND((SUM("position" * impressions) FILTER (WHERE period = 'previous')
                  / NULLIF(SUM(impressions) FILTER (WHERE period = 'previous'), 0))::numeric, 2) AS position_prev
    FROM base
    GROUP BY request, site, is_brand
    HAVING SUM(impressions) FILTER (WHERE period = 'current') > 0
    ORDER BY clicks DESC NULLS LAST
    LIMIT 2000   -- страница ограничена ~10 МБ; 2000 строк — сотни КБ
)
SELECT json_build_object(
    'generated', CURRENT_DATE::text,
    'period', (SELECT json_build_object('from', cur_from::text, 'to', cur_to::text,
                                        'prev_from', prev_from::text, 'prev_to', prev_to::text) FROM bounds),
    'daily',    (SELECT json_agg(daily ORDER BY date) FROM daily),
    'requests', (SELECT json_agg(req ORDER BY clicks DESC NULLS LAST) FROM req)
);
