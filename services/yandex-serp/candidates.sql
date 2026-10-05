-- services/yandex-serp/candidates.sql
-- Кандидаты в yandex-serp/keywords/target_keywords.txt: фразы из GSC за 90 дней,
-- где мы уже показываемся, но не в топ-5 (зона роста), с частотностью Wordstat.
-- Бренд и уже отслеживаемые фразы отфильтровываются вручную/по файлу.
-- Запуск на VDS: psql -f services/yandex-serp/candidates.sql

WITH gsc AS (
    SELECT
        sc.request,
        SUM(sc.impressions)                                       AS impressions,
        SUM(sc.clicks)                                            AS clicks,
        SUM(sc.position * sc.impressions) / NULLIF(SUM(sc.impressions), 0) AS avg_position
    FROM gsc.search_console sc
    WHERE sc.event_date >= CURRENT_DATE - 90
    GROUP BY sc.request
),
ws AS (
    SELECT r.request, d.frequency
    FROM wordstat.dynamics_range d
    JOIN common.requests r ON r.request_id = d.request_id
    WHERE d.month = (SELECT MAX(month) FROM wordstat.dynamics_range)
)
SELECT
    g.request,
    g.impressions,
    g.clicks,
    ROUND(g.avg_position::numeric, 1) AS avg_position,
    ws.frequency                      AS wordstat_freq
FROM gsc g
LEFT JOIN ws ON ws.request = g.request
WHERE g.impressions >= 30
  AND g.avg_position BETWEEN 5 AND 40
  AND g.request NOT ILIKE '%ddos-guard%'
  AND g.request NOT ILIKE '%ддос гард%'
  AND g.request NOT ILIKE '%ddos guard%'
ORDER BY g.impressions DESC
LIMIT 300;
