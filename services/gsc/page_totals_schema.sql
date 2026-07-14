-- services/gsc/page_totals_schema.sql
-- Реальные суммарные показатели страницы за период (dimensions: ['page'], без 'query') —
-- не искажены обрезкой топ-20, в отличие от gsc.top_queries_by_page.
-- Заполняется scripts/gsc-page-totals-by-url.js.

CREATE SCHEMA IF NOT EXISTS gsc;

CREATE TABLE IF NOT EXISTS gsc.page_totals_by_period (
    url TEXT NOT NULL,
    period_label TEXT NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    clicks INTEGER NOT NULL,
    impressions INTEGER NOT NULL,
    ctr DOUBLE PRECISION,
    position DOUBLE PRECISION,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (url, period_label)
);

COMMENT ON TABLE gsc.page_totals_by_period IS 'Суммарные показы/клики/CTR/позиция по URL за период — агрегат по ВСЕМ запросам страницы, не только топ-20';
