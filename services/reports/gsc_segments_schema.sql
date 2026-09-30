-- ============================================
-- REPORTS: состав Google-трафика ddos-guard.ru по сегментам (GSC)
-- Заполняется scripts/gsc-segments-monthly.js (SQL: services/reports/gsc_segments_load.sql)
-- ============================================

CREATE SCHEMA IF NOT EXISTS reports;

-- Сегменты (приоритет сверху вниз):
--   brand         — запрос содержит брендовое слово (common.brand_keywords), любая страница
--   product       — страница — target продуктовой группы Топвизора проекта ddos-guard.ru
--                   (L3-4, L7, VDS/VPS, DS, Хостинг, Главная); капча, ИБ, ОРИ, DDG VM, Cloudflare сюда не входят
--   informational — страницы /blog, /terms, /tutorials, /technologies
--   other         — остальное
CREATE TABLE IF NOT EXISTS reports.gsc_segment_monthly (
    month DATE NOT NULL,
    segment TEXT NOT NULL,            -- brand | product | informational | other
    clicks BIGINT NOT NULL DEFAULT 0,
    impressions BIGINT NOT NULL DEFAULT 0,
    avg_position NUMERIC,             -- средневзвешенная по показам
    days_with_data SMALLINT NOT NULL, -- за сколько дней месяца есть данные GSC
    days_in_month SMALLINT NOT NULL,
    computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (month, segment)
);

COMMENT ON TABLE reports.gsc_segment_monthly IS 'Клики/показы/позиция Google (GSC) по сегментам за месяц. Только с 2025-09: раньше в gsc.search_console неполный набор (фев–июль 2025 ~60 строк в день). По измерению query GSC не отдаёт анонимизированные запросы, поэтому суммы ниже интерфейса GSC; сравнивать нужно динамику и доли. Месяцы с days_with_data < days_in_month (в т.ч. текущий) неполные: смотреть клики в день = clicks / days_with_data. Уровни GSC между декабрём 2025 и январём 2026 удвоились без аналога в GA4 (причина не выяснена), поэтому нормы по сегментам не строятся — только состав.';

-- Клики в день и доля сегмента в месяце
CREATE OR REPLACE VIEW reports.v_gsc_segment_share AS
SELECT month, segment, clicks, days_with_data, days_in_month,
       ROUND(clicks::numeric / NULLIF(days_with_data, 0), 1) AS clicks_per_day,
       ROUND(clicks::numeric * 100 / NULLIF(SUM(clicks) OVER (PARTITION BY month), 0), 1) AS clicks_share_pct,
       avg_position
FROM reports.gsc_segment_monthly;
