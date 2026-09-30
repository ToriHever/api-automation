-- ============================================
-- REPORTS: вью для отчёта «Норма трафика SEO» (DataLens, HTML-страница reports/seo-norm-datalens)
-- Источник: reports.seo_traffic_norm (scripts/seo-traffic-norm.js)
-- ============================================

CREATE SCHEMA IF NOT EXISTS reports;

-- Одна строка = ряд × сайт × месяц: факт, норма, коридор, отклонение, статус + подписи для отчёта.
CREATE OR REPLACE VIEW reports.v_seo_norm_report AS
SELECT
    n.series,
    CASE n.series
        WHEN 'seo_traffic_ga4'            THEN 'Органика, все поисковики — GA4 (основной)'
        WHEN 'seo_traffic_metrika'        THEN 'Органика, все поисковики — Метрика (сверка)'
        WHEN 'seo_traffic_ga4_google'     THEN 'Органика Google — GA4'
        WHEN 'seo_traffic_ga4_yandex'     THEN 'Органика Яндекс — GA4'
        WHEN 'seo_traffic_metrika_google' THEN 'Органика Google — Метрика'
        WHEN 'seo_traffic_metrika_yandex' THEN 'Органика Яндекс — Метрика'
        ELSE CASE WHEN left(n.series, 7) = 'demand_' THEN 'Спрос Wordstat — ' || substr(n.series, 8) ELSE n.series END
    END AS series_label,
    CASE n.series
        WHEN 'seo_traffic_ga4'            THEN 1
        WHEN 'seo_traffic_metrika'        THEN 2
        WHEN 'seo_traffic_ga4_google'     THEN 3
        WHEN 'seo_traffic_metrika_google' THEN 4
        WHEN 'seo_traffic_ga4_yandex'     THEN 5
        WHEN 'seo_traffic_metrika_yandex' THEN 6
        ELSE 10
    END AS sort_order,
    CASE WHEN left(n.series, 7) = 'demand_' THEN 'demand' ELSE 'traffic' END AS kind,
    n.site,
    n.month,
    n.is_forecast,
    n.days_in_month,
    n.level_per_day,
    n.seasonal_index,
    n.seasons_used,
    n.confidence,
    n.expected_per_day,
    n.expected_total,
    n.expected_low,
    n.expected_high,
    n.band_pct,
    n.actual_total,
    n.actual_per_day,
    ROUND(n.deviation_pct, 1) AS deviation_pct,
    n.status,
    n.basis
FROM reports.seo_traffic_norm n;

COMMENT ON VIEW reports.v_seo_norm_report IS 'Норма трафика (и спроса) по месяцам с подписями рядов для отчёта: факт, норма, коридор, отклонение, статус. Строки is_forecast = true — будущие месяцы (только норма). Ряды, для которых норма ненадёжна (тренд, широкий коридор), в seo_traffic_norm не записываются и здесь отсутствуют.';

-- Последний месяц с фактом по каждому ряду: то, что показывается карточками «сейчас против нормы».
CREATE OR REPLACE VIEW reports.v_seo_norm_latest AS
SELECT DISTINCT ON (series, site) *
FROM reports.v_seo_norm_report
WHERE NOT is_forecast AND actual_total IS NOT NULL
ORDER BY series, site, month DESC;

COMMENT ON VIEW reports.v_seo_norm_latest IS 'Последний месяц с фактом по каждому ряду и сайту (факт против нормы). Текущий неполный месяц сюда попадает, если по нему уже есть факт — смотрите days_in_month и status.';
