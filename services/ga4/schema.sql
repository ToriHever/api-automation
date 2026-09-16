-- ============================================
-- GA4 (Google Analytics 4) Schema
-- ============================================

CREATE SCHEMA IF NOT EXISTS ga4;

-- ============================================
-- GA4 SCHEMA: Core Web Vitals по кастомным параметрам событий
-- ============================================

-- Данные приходят одним событием "webVitals" (dataLayer.push из GTM) с
-- кастомными параметрами: metric_name (LCP/CLS/INP/FCP/TTFB), metric_value.
-- pagePath из GA4 (относительный путь, без домена) нормализуется в
-- GA4Collector._normalizeUrl (домен + путь) и резолвится в target_url через
-- общий справочник common.site_map — так же, как gsc.search_console.target_url.
CREATE TABLE IF NOT EXISTS ga4.web_vitals (
    event_date DATE NOT NULL,
    metric_name TEXT NOT NULL,
    target_url INTEGER NOT NULL REFERENCES common.site_map(id),
    event_count INTEGER DEFAULT 0,
    metric_value DOUBLE PRECISION DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (event_date, metric_name, target_url)
);

COMMENT ON TABLE ga4.web_vitals IS 'Агрегированные Core Web Vitals из GA4, событие webVitals с кастомными параметрами customEvent:metric_name / customEvent:metric_value';
COMMENT ON COLUMN ga4.web_vitals.metric_name IS 'Тип метрики Web Vitals: LCP, CLS, INP, FCP, TTFB (значение параметра metric_name)';
COMMENT ON COLUMN ga4.web_vitals.target_url IS 'ID страницы из справочника common.site_map (домен + pagePath из GA4)';
COMMENT ON COLUMN ga4.web_vitals.event_count IS 'Количество событий в группе (eventCount)';
COMMENT ON COLUMN ga4.web_vitals.metric_value IS 'Среднее значение метрики за день по странице (customEvent:metric_value, усреднено по event_count)';

CREATE INDEX IF NOT EXISTS idx_web_vitals_date ON ga4.web_vitals(event_date);
CREATE INDEX IF NOT EXISTS idx_web_vitals_metric ON ga4.web_vitals(metric_name);
CREATE INDEX IF NOT EXISTS idx_web_vitals_target_url ON ga4.web_vitals(target_url);

-- ============================================
-- TRIGGERS: Автообновление updated_at
-- ============================================

CREATE OR REPLACE FUNCTION ga4.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_ga4_web_vitals_updated_at ON ga4.web_vitals;
CREATE TRIGGER update_ga4_web_vitals_updated_at
    BEFORE UPDATE ON ga4.web_vitals
    FOR EACH ROW
    EXECUTE FUNCTION ga4.update_updated_at_column();
