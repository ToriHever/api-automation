-- Выгрузка для HTML-отчёта «Норма трафика SEO» (DataLens, HTML-страница).
-- Источники: reports.v_seo_norm_report (норма), reports.v_organic_engine_monthly (поисковики),
--            reports.v_gsc_segment_share (сегменты GSC). Сайт — только ru (ddos-guard.ru).
-- Перед выгрузкой: node scripts/seo-traffic-norm.js (и его зависимости, см. COMMANDS.md).
--
-- Запуск (пример):
--   psql "$DATABASE_URL" -At -f queries.sql -o data.json
--   node build.js --data data.json
-- Итоговый JSON — один объект; поле anomaly задайте под текущий список reports.seasonality_events
-- (по умолчанию апрель–сентябрь 2026).

SELECT json_build_object(
    'generated', CURRENT_DATE::text,
    'source', 'db',
    'site', 'ru',
    'anomaly', json_build_object('from', '2026-04', 'to', '2026-09',
                                 'text', 'Апрель–сентябрь 2026 исключены из расчёта нормы как устойчивое падение органики'),

    -- ряды нормы: строки по месяцам, факт против нормы и коридора
    'series', (
        SELECT json_agg(s ORDER BY s.sort)
        FROM (
            SELECT series AS key, MAX(series_label) AS label, MAX(sort_order) AS sort, MAX(kind) AS kind,
                   ROUND(MAX(level_per_day)::numeric, 1) AS level, ROUND(MAX(band_pct)::numeric, 1) AS band,
                   MAX(basis) AS basis,
                   json_agg(json_build_object(
                       'm', to_char(month, 'YYYY-MM'),
                       'actual', actual_total, 'expected', expected_total, 'low', expected_low, 'high', expected_high,
                       'dev', deviation_pct, 'status', status, 'conf', confidence, 'forecast', is_forecast, 'ins', in_sample,
                       'si', ROUND(seasonal_index::numeric, 3), 'seasons', seasons_used
                   ) ORDER BY month) AS rows
            FROM reports.v_seo_norm_report
            WHERE site = 'ru' AND kind = 'traffic'
            GROUP BY series
        ) s
    ),

    -- органика по поисковикам, сессий/визитов в месяц (GA4 и Метрика)
    'engines', (
        SELECT json_agg(e ORDER BY e.m)
        FROM (
            SELECT to_char(month, 'YYYY-MM') AS m,
                   SUM(sessions) FILTER (WHERE source = 'ga4'     AND engine = 'Google') AS ga4_google,
                   SUM(sessions) FILTER (WHERE source = 'ga4'     AND engine = 'Yandex') AS ga4_yandex,
                   SUM(sessions) FILTER (WHERE source = 'metrika' AND engine = 'Google') AS metrika_google,
                   SUM(sessions) FILTER (WHERE source = 'metrika' AND engine = 'Yandex') AS metrika_yandex,
                   MIN(days_with_data) FILTER (WHERE source = 'ga4') AS ga4_days
            FROM reports.v_organic_engine_monthly
            WHERE site = 'ru' AND month >= '2024-10-01'
            GROUP BY month
        ) e
    ),

    -- состав Google-трафика по сегментам (GSC), клики в день
    'segments', (
        SELECT json_agg(g ORDER BY g.m)
        FROM (
            SELECT to_char(month, 'YYYY-MM') AS m,
                   MAX(clicks_per_day) FILTER (WHERE segment = 'brand')         AS brand,
                   MAX(clicks_per_day) FILTER (WHERE segment = 'informational') AS informational,
                   MAX(clicks_per_day) FILTER (WHERE segment = 'product')       AS product,
                   MAX(clicks_per_day) FILTER (WHERE segment = 'other')         AS other,
                   MIN(days_with_data) AS days, MIN(days_in_month) AS days_in_month
            FROM reports.v_gsc_segment_share
            GROUP BY month
        ) g
    )
);
