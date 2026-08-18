-- ============================================
-- GA4 (Google Analytics 4) Schema
-- ============================================

CREATE SCHEMA IF NOT EXISTS ga4;

-- ============================================
-- GA4 SCHEMA: Core Web Vitals по кастомным параметрам событий
-- ============================================

-- Данные приходят одним событием "webVitals" (dataLayer.push из GTM) с
-- кастомными параметрами: metric_name (LCP/CLS/INP/FCP/TTFB), metric_value.
CREATE TABLE IF NOT EXISTS ga4.web_vitals (
    event_date DATE NOT NULL,
    metric_name TEXT NOT NULL,
    page_path TEXT NOT NULL,
    event_count INTEGER DEFAULT 0,
    metric_value DOUBLE PRECISION DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (event_date, metric_name, page_path)
);

COMMENT ON TABLE ga4.web_vitals IS 'Агрегированные Core Web Vitals из GA4, событие webVitals с кастомными параметрами customEvent:metric_name / customEvent:metric_value';
COMMENT ON COLUMN ga4.web_vitals.metric_name IS 'Тип метрики Web Vitals: LCP, CLS, INP, FCP, TTFB (значение параметра metric_name)';
COMMENT ON COLUMN ga4.web_vitals.page_path IS 'Путь страницы (pagePath)';
COMMENT ON COLUMN ga4.web_vitals.event_count IS 'Количество событий в группе (eventCount)';
COMMENT ON COLUMN ga4.web_vitals.metric_value IS 'Среднее значение метрики за день по странице (customEvent:metric_value, усреднено по event_count)';

CREATE INDEX IF NOT EXISTS idx_web_vitals_date ON ga4.web_vitals(event_date);
CREATE INDEX IF NOT EXISTS idx_web_vitals_metric ON ga4.web_vitals(metric_name);
CREATE INDEX IF NOT EXISTS idx_web_vitals_page_path ON ga4.web_vitals(page_path);

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
