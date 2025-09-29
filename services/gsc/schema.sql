-- ============================================
-- GSC (Google Search Console) Schema
-- ============================================

-- 1. Создание схем (если не существуют)
CREATE SCHEMA IF NOT EXISTS common;
CREATE SCHEMA IF NOT EXISTS gsc;

-- ============================================
-- COMMON SCHEMA: Справочник URL
-- ============================================

-- Таблица-справочник всех URL из Search Console
CREATE TABLE IF NOT EXISTS common.site_map (
    id SMALLSERIAL PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE common.site_map IS 'Справочник всех URL-адресов из Search Console для нормализации';
COMMENT ON COLUMN common.site_map.url IS 'Полный URL страницы';

-- Индекс для быстрого поиска URL
CREATE INDEX IF NOT EXISTS idx_site_map_url ON common.site_map(url);

-- ============================================
-- GSC SCHEMA: Данные Search Console
-- ============================================

-- Основная таблица с данными поисковой выдачи
CREATE TABLE IF NOT EXISTS gsc.search_console (
    event_date DATE NOT NULL,
    request TEXT NOT NULL,
    target_url INTEGER NOT NULL REFERENCES common.site_map(id),
    clicks INTEGER DEFAULT 0,
    impressions INTEGER DEFAULT 0,
    ctr DOUBLE PRECISION DEFAULT 0,
    position DOUBLE PRECISION DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Уникальность по комбинации: дата + запрос + URL (это PRIMARY KEY)
    PRIMARY KEY (event_date, request, target_url)
);

COMMENT ON TABLE gsc.search_console IS 'Данные из Google Search Console о поисковых запросах';
COMMENT ON COLUMN gsc.search_console.event_date IS 'Дата события';
COMMENT ON COLUMN gsc.search_console.request IS 'Поисковый запрос пользователя';
COMMENT ON COLUMN gsc.search_console.target_url IS 'ID страницы из справочника site_map';
COMMENT ON COLUMN gsc.search_console.clicks IS 'Количество кликов';
COMMENT ON COLUMN gsc.search_console.impressions IS 'Количество показов';
COMMENT ON COLUMN gsc.search_console.ctr IS 'CTR (Click-Through Rate)';
COMMENT ON COLUMN gsc.search_console.position IS 'Средняя позиция в выдаче';

-- Индексы для оптимизации запросов
CREATE INDEX IF NOT EXISTS idx_search_console_date ON gsc.search_console(event_date);
CREATE INDEX IF NOT EXISTS idx_search_console_request ON gsc.search_console(request);
CREATE INDEX IF NOT EXISTS idx_search_console_target_url ON gsc.search_console(target_url);
CREATE INDEX IF NOT EXISTS idx_search_console_date_request ON gsc.search_console(event_date, request);

-- ============================================
-- TRIGGERS: Автообновление updated_at
-- ============================================

-- Функция для обновления updated_at
CREATE OR REPLACE FUNCTION gsc.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Триггер для gsc.search_console
DROP TRIGGER IF EXISTS update_gsc_updated_at ON gsc.search_console;
CREATE TRIGGER update_gsc_updated_at
    BEFORE UPDATE ON gsc.search_console
    FOR EACH ROW
    EXECUTE FUNCTION gsc.update_updated_at_column();