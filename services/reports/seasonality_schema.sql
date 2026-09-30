-- ============================================
-- REPORTS: сезонные индексы (основа для «Нормы трафика SEO»)
-- Заполняется scripts/seasonality-index.js
-- ============================================

CREATE SCHEMA IF NOT EXISTS reports;

-- Ручной список событий (сбои, апдейты) — правится руками, без изменения кода.
--   exclude — месяц(ы) исключить из расчёта индекса
--   keep    — НЕ исключать, даже если автоопределение пометило месяц аномальным
-- site NULL = относится к обоим сайтам (ru и en).
-- applies_to: событие в поисковой выдаче (апдейт, сбой) влияет на трафик, но не на спрос Wordstat,
-- поэтому по умолчанию 'traffic'; для праздников/новостных всплесков спроса — 'demand' или 'all'.
CREATE TABLE IF NOT EXISTS reports.seasonality_events (
    id SERIAL PRIMARY KEY,
    site TEXT CHECK (site IN ('ru', 'en')),
    month_from DATE NOT NULL,
    month_to DATE NOT NULL,
    action TEXT NOT NULL DEFAULT 'exclude' CHECK (action IN ('exclude', 'keep')),
    applies_to TEXT NOT NULL DEFAULT 'traffic' CHECK (applies_to IN ('traffic', 'demand', 'all')),  -- к трафику, к спросу Wordstat или к обоим
    description TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE reports.seasonality_events IS 'Ручной список аномальных месяцев (апдейты, сбои). month_from/month_to — первые числа месяцев, включительно. Пример: INSERT INTO reports.seasonality_events (site, month_from, month_to, applies_to, description) VALUES (NULL, ''2025-03-01'', ''2025-03-01'', ''traffic'', ''Апдейт Яндекса'');';

-- Помесячные значения ряда и статус участия в расчёте индекса
CREATE TABLE IF NOT EXISTS reports.seasonality_monthly (
    series TEXT NOT NULL,             -- seo_traffic_ga4 | seo_traffic_metrika | demand_<продукт>
    site TEXT NOT NULL,               -- ru | en
    month DATE NOT NULL,              -- первое число месяца
    value BIGINT NOT NULL,            -- органические сессии/визиты за месяц (сумма)
    value_per_day NUMERIC,            -- среднее в день = value / число дней месяца (по нему считаются индексы)
    status TEXT NOT NULL,             -- used | incomplete_month | incomplete_season | anomaly_auto | anomaly_manual
    note TEXT,
    season TEXT,                      -- начало сезона (12 мес. подряд), например 2024-10
    season_baseline NUMERIC,          -- среднее В ДЕНЬ по общим для всех сезонов месяцам
    month_index NUMERIC,              -- value_per_day / season_baseline (только для status = used)
    computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (series, site, month)
);

-- Итоговый сезонный индекс: 12 значений на ряд и сайт
CREATE TABLE IF NOT EXISTS reports.seasonality_index (
    series TEXT NOT NULL,
    site TEXT NOT NULL,
    month_num SMALLINT NOT NULL CHECK (month_num BETWEEN 1 AND 12),
    seasonal_index NUMERIC,           -- среднее month_index по годам; 1.00 = среднемесячный уровень
    seasons_used SMALLINT NOT NULL,   -- на скольких сезонах посчитано
    seasons_list TEXT,                -- какие сезоны вошли (по месяцу начала), например '2024-10,2025-10'
    method_note TEXT,
    computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (series, site, month_num)
);

COMMENT ON TABLE reports.seasonality_index IS 'Сезонный индекс: среднее в день за месяц / база его сезона (среднее в день), усреднённое по сезонам. Данные с 2024-09-16 (разделение сайтов ru/en, более ранние несопоставимы). Сезон = 12 месяцев подряд от первого полного месяца; база = среднее по месяцам, пригодным во ВСЕХ учитываемых сезонах. Не входят: неполные месяцы (в т.ч. текущий), сезоны с недостаточным числом месяцев, аномальные месяцы (авто + reports.seasonality_events). seasons_used = 1 — разовое наблюдение, а не среднее.';
COMMENT ON COLUMN reports.seasonality_index.seasons_used IS 'Сколько сезонов вошло в среднее. 1 = разовое наблюдение, индекс ориентировочный.';
COMMENT ON COLUMN reports.seasonality_monthly.status IS 'used — участвует; incomplete_month — месяц неполный (текущий, начало периода или пропуски дней); incomplete_season — в сезоне мало пригодных месяцев; anomaly_auto — отклонение от соседних месяцев; anomaly_manual — из reports.seasonality_events';
