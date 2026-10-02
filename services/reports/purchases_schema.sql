-- ============================================
-- REPORTS: покупки из organic по месяцам и KPI-диапазоны по продуктовым группам
-- Заполняется scripts/purchases-kpi.js --apply (из services/reports/data/organic_monthly_*.csv)
-- ============================================

CREATE SCHEMA IF NOT EXISTS reports;

-- Новые плательщики из organic и сумма оплат ПЕРВОГО дня по продуктовой группе и месяцу.
-- Плательщик с двумя продуктами попадает в обе группы: сумма по группам >= общего итога.
CREATE TABLE IF NOT EXISTS reports.purchases_monthly (
    month DATE NOT NULL,                 -- первый день месяца
    product TEXT NOT NULL,               -- L7 | L3-4 | DS | VDS | Хостинг
    new_payers INTEGER NOT NULL,
    revenue_rub NUMERIC(14,2) NOT NULL,
    invoices INTEGER NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (month, product)
);

-- Общий итог по сайту (без разбивки по продуктам)
CREATE TABLE IF NOT EXISTS reports.purchases_overall_monthly (
    month DATE PRIMARY KEY,
    new_payers_total INTEGER,            -- все новые плательщики
    new_payers_organic INTEGER,
    revenue_organic_rub NUMERIC(14,2),
    invoices_organic INTEGER,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- KPI-диапазон на ближайший квартал: low/mid/high (80% интервал по последним 12 месяцам)
CREATE TABLE IF NOT EXISTS reports.purchases_kpi (
    product TEXT NOT NULL,
    metric TEXT NOT NULL,                -- new_payers | revenue_rub
    quarter_start DATE NOT NULL,
    low NUMERIC(14,2) NOT NULL,
    mid NUMERIC(14,2) NOT NULL,
    high NUMERIC(14,2) NOT NULL,
    reliability TEXT NOT NULL,           -- ok | low_volume | regime
    basis TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (product, metric, quarter_start)
);

COMMENT ON TABLE reports.purchases_monthly IS 'Покупки из organic по продуктовым группам (новые плательщики, оплаты первого дня). Источник — выгрузка аналитиков, правило organic задаётся там.';
COMMENT ON TABLE reports.purchases_kpi IS 'KPI-диапазоны покупок: середина = среднее за последние 4 квартала (без сезонности), границы = 80% интервал по месячному разбросу.';
