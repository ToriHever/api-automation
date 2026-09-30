-- ============================================
-- REPORTS: сезонные индексы (основа для «Нормы трафика SEO»)
-- Заполняется scripts/seasonality-index.js
-- ============================================

CREATE SCHEMA IF NOT EXISTS reports;

-- Ручной список событий (сбои, апдейты) — правится руками, без изменения кода.
--   exclude — месяц(ы) исключить из расчёта индекса
--   keep    — НЕ исключать, даже если автоопределение пометило месяц аномальным
-- site NULL = относится к обоим сайтам (ru и en).
CREATE TABLE IF NOT EXISTS reports.seasonality_events (
    id SERIAL PRIMARY KEY,
    site TEXT CHECK (site IN ('ru', 'en')),
    month_from DATE NOT NULL,
    month_to DATE NOT NULL,
    action TEXT NOT NULL DEFAULT 'exclude' CHECK (action IN ('exclude', 'keep')),
    description TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE reports.seasonality_events IS 'Ручной список аномальных месяцев (апдейты, сбои). month_from/month_to — первые числа месяцев, включительно. Пример: INSERT INTO reports.seasonality_events (site, month_from, month_to, description) VALUES (NULL, ''2025-03-01'', ''2025-03-01'', ''Апдейт Яндекса'');';

-- Помесячные значения ряда и статус участия в расчёте индекса
CREATE TABLE IF NOT EXISTS reports.seasonality_monthly (
    series TEXT NOT NULL,             -- seo_traffic_ga4 | seo_traffic_metrika
    site TEXT NOT NULL,               -- ru | en
    month DATE NOT NULL,              -- первое число месяца
    value BIGINT NOT NULL,            -- органические сессии/визиты за месяц
    status TEXT NOT NULL,             -- used | incomplete_month | incomplete_year | anomaly_auto | anomaly_manual
    note TEXT,
    year_baseline NUMERIC,            -- среднемесячное за календарный год (без аномальных месяцев)
    month_index NUMERIC,              -- value / year_baseline (только для status = used)
    computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (series, site, month)
);

-- Итоговый сезонный индекс: 12 значений на ряд и сайт
CREATE TABLE IF NOT EXISTS reports.seasonality_index (
    series TEXT NOT NULL,
    site TEXT NOT NULL,
    month_num SMALLINT NOT NULL CHECK (month_num BETWEEN 1 AND 12),
    seasonal_index NUMERIC,           -- среднее month_index по годам; 1.00 = среднемесячный уровень
    years_used SMALLINT NOT NULL,     -- на скольких годах посчитано
    years_list TEXT,                  -- какие годы вошли, например '2024,2025'
    method_note TEXT,
    computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (series, site, month_num)
);

COMMENT ON TABLE reports.seasonality_index IS 'Сезонный индекс = значение месяца / среднемесячное за календарный год, усреднённое по годам. В расчёт входят только полные календарные годы (12 полных месяцев) и полные месяцы; текущий неполный месяц, годы без полного набора данных и аномальные месяцы (авто + reports.seasonality_events) исключены. Если years_used = 1 — индекс по одному году, это не среднее, а разовое наблюдение.';
COMMENT ON COLUMN reports.seasonality_index.years_used IS 'Сколько лет вошло в среднее. Малое значение (1–2) = индекс ориентировочный.';
COMMENT ON COLUMN reports.seasonality_monthly.status IS 'used — участвует; incomplete_month — месяц неполный (текущий или с пропусками дней); incomplete_year — в календарном году меньше 12 полных месяцев; anomaly_auto — отклонение от соседних месяцев; anomaly_manual — из reports.seasonality_events';
