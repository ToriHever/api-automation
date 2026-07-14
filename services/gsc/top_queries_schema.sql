-- services/gsc/top_queries_schema.sql
-- ТОП-20 запросов по показам на URL за период. Заполняется scripts/gsc-top-queries-by-url.js
-- Не связано с ежедневным сбором gsc.search_console (services/gsc/GSCCollector.js) — отдельная таблица.

CREATE SCHEMA IF NOT EXISTS gsc;

CREATE TABLE IF NOT EXISTS gsc.top_queries_by_page (
    url TEXT NOT NULL,
    period_label TEXT NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    rank INTEGER NOT NULL,
    query TEXT NOT NULL,
    clicks INTEGER NOT NULL,
    impressions INTEGER NOT NULL,
    ctr DOUBLE PRECISION,
    position DOUBLE PRECISION,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (url, period_label, query)
);

CREATE INDEX IF NOT EXISTS idx_top_queries_url_period
    ON gsc.top_queries_by_page (url, period_label, rank);

COMMENT ON TABLE gsc.top_queries_by_page IS 'ТОП-20 поисковых запросов по показам (impressions) для конкретного URL за заданный период';
COMMENT ON COLUMN gsc.top_queries_by_page.period_label IS 'Метка периода, например 2025-H1 или 2026-H1';
COMMENT ON COLUMN gsc.top_queries_by_page.rank IS 'Место в ТОП-20 по убыванию impressions (1 = больше всего показов)';
