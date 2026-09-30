-- ============================================
-- REPORTS: органический трафик по поисковым системам (Яндекс / Google / прочие)
-- Заполняется scripts/traffic-organic-engines.js
-- ============================================

CREATE SCHEMA IF NOT EXISTS reports;

CREATE TABLE IF NOT EXISTS reports.traffic_organic_engine (
    source TEXT NOT NULL,             -- 'ga4' | 'metrika'
    site TEXT NOT NULL,               -- 'ru' | 'en'
    host TEXT NOT NULL,               -- ddos-guard.ru | ddos-guard.net (без поддоменов)
    event_date DATE NOT NULL,
    engine TEXT NOT NULL,             -- 'Yandex' | 'Google' | 'Other'
    sessions INTEGER NOT NULL DEFAULT 0,      -- GA4 sessions / Метрика visits
    users INTEGER NOT NULL DEFAULT 0,
    new_users INTEGER NOT NULL DEFAULT 0,
    pageviews INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (source, site, event_date, engine)
);

COMMENT ON TABLE reports.traffic_organic_engine IS 'Органический трафик (GA4: Organic Search, Метрика: organic) по дням и поисковым системам; ru = ddos-guard.ru, en = ddos-guard.net. GA4 sessionSource и Метрика lastSearchEngineRoot сведены к Yandex / Google / Other.';

CREATE INDEX IF NOT EXISTS idx_traffic_organic_engine_date ON reports.traffic_organic_engine(event_date);

-- Помесячно, со средним в день и числом дней с данными (для сравнения год к году)
CREATE OR REPLACE VIEW reports.v_organic_engine_monthly AS
SELECT source, site, engine,
       date_trunc('month', event_date)::date AS month,
       SUM(sessions)::bigint AS sessions,
       COUNT(DISTINCT event_date) AS days_with_data
FROM reports.traffic_organic_engine
GROUP BY source, site, engine, date_trunc('month', event_date);
