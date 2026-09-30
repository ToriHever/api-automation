-- ============================================
-- REPORTS Schema: сводные выгрузки для отчётов
-- ============================================

CREATE SCHEMA IF NOT EXISTS reports;

-- Трафик по дням и каналам из GA4 и Яндекс.Метрики, раздельно для ru и en сайтов.
-- Заполняется scripts/traffic-history-36m.js (upsert по первичному ключу).
CREATE TABLE IF NOT EXISTS reports.traffic_daily (
    source TEXT NOT NULL,             -- 'ga4' | 'metrika'
    site TEXT NOT NULL,               -- 'ru' | 'en'
    host TEXT NOT NULL,               -- ddos-guard.ru | ddos-guard.net (без поддоменов)
    event_date DATE NOT NULL,
    channel TEXT NOT NULL,            -- GA4: sessionDefaultChannelGroup, Метрика: lastTrafficSource
    sessions INTEGER NOT NULL DEFAULT 0,          -- GA4 sessions / Метрика visits
    engaged_sessions INTEGER,                     -- только GA4 (NULL для Метрики)
    users INTEGER NOT NULL DEFAULT 0,
    new_users INTEGER NOT NULL DEFAULT 0,
    pageviews INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (source, site, event_date, channel)
);

COMMENT ON TABLE reports.traffic_daily IS 'Трафик по дням и каналам: GA4 и Яндекс.Метрика, сайты ddos-guard.ru (ru) и ddos-guard.net (en)';
COMMENT ON COLUMN reports.traffic_daily.sessions IS 'GA4: sessions; Метрика: visits';
COMMENT ON COLUMN reports.traffic_daily.users IS 'Пользователи за день по каналу; суммировать по каналам нельзя (дубли), брать по дню отдельным запросом';

CREATE INDEX IF NOT EXISTS idx_traffic_daily_date ON reports.traffic_daily(event_date);
