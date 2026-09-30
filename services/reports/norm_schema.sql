-- ============================================
-- REPORTS: «Норма трафика SEO» (и спроса) по месяцам
-- Заполняется scripts/seo-traffic-norm.js на основе reports.seasonality_monthly / seasonality_index
-- ============================================

CREATE SCHEMA IF NOT EXISTS reports;

-- Норма месяца = уровень (среднее в день, очищенное от сезонности) × сезонный индекс месяца × число дней.
-- Фактические месяцы сравниваются с нормой; будущие месяцы (is_forecast) содержат только норму.
CREATE TABLE IF NOT EXISTS reports.seo_traffic_norm (
    series TEXT NOT NULL,             -- seo_traffic_ga4 | seo_traffic_ga4_google | ... | demand_<продукт>
    site TEXT NOT NULL,               -- ru | en
    month DATE NOT NULL,              -- первое число месяца
    is_forecast BOOLEAN NOT NULL,     -- true: месяц ещё не закончился / нет факта, только норма
    days_in_month SMALLINT NOT NULL,
    level_per_day NUMERIC,            -- базовый уровень (в день), одинаков для всех месяцев ряда
    seasonal_index NUMERIC,           -- сезонный индекс этого месяца (1.00 = средний уровень)
    seasons_used SMALLINT,            -- на скольких сезонах посчитан индекс
    confidence TEXT,                  -- normal (>=2 сезонов) | low (1 сезон) | fallback (индекс из Метрики) | none (нет индекса)
    expected_per_day NUMERIC,         -- норма в день = level_per_day × seasonal_index
    expected_total BIGINT,            -- норма за месяц = expected_per_day × days_in_month
    band_pct NUMERIC,                 -- допуск ± в % (2 сигмы разброса пригодных месяцев, не меньше 10%)
    expected_low BIGINT,              -- нижняя граница нормы за месяц
    expected_high BIGINT,             -- верхняя граница нормы за месяц
    actual_total BIGINT,              -- факт за месяц (NULL для неполных месяцев и будущих)
    actual_per_day NUMERIC,
    deviation_pct NUMERIC,            -- (факт в день / норма в день − 1) × 100
    status TEXT NOT NULL,             -- in_norm | below_norm | above_norm | no_actual | forecast | no_norm
    basis TEXT,                       -- из чего сложена норма (окно уровня, исключённые аномалии)
    computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (series, site, month)
);

COMMENT ON TABLE reports.seo_traffic_norm IS 'Норма трафика (и спроса) по месяцам: уровень × сезонный индекс × дни месяца, коридор допуска и отклонение факта. Норма зависит от списка аномальных месяцев (reports.seasonality_events) — при его изменении пересчитать сначала node scripts/seasonality-index.js, затем node scripts/seo-traffic-norm.js. Индексы посчитаны на 1–2 сезонах, поэтому норма ориентировочная; confidence = low там, где индекс по одному сезону.';
COMMENT ON COLUMN reports.seo_traffic_norm.level_per_day IS 'Среднее по последним N пригодным месяцам значения в день, делённого на сезонный индекс месяца (N = --level-months, по умолчанию 12). Пригодные месяцы — status = used в reports.seasonality_monthly: полные, не аномальные.';
COMMENT ON COLUMN reports.seo_traffic_norm.status IS 'in_norm — факт в коридоре нормы; below_norm / above_norm — ниже / выше; no_actual — у месяца нет полного факта; forecast — будущий месяц; no_norm — нет индекса для месяца.';
