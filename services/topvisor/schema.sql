-- =====================================================
-- ОБНОВЛЕННАЯ СХЕМА topvisor.positions БЕЗ created_at
-- =====================================================

-- Создание схем если не существуют
CREATE SCHEMA IF NOT EXISTS common;
CREATE SCHEMA IF NOT EXISTS topvisor;

-- =====================================================
-- COMMON SCHEMA: Общие справочники
-- =====================================================

-- Справочник всех URL (общий для всех сервисов)
CREATE TABLE IF NOT EXISTS common.site_map (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Справочник проектов и поисковых систем
CREATE TABLE IF NOT EXISTS common.dim_projects_engines (
    id SERIAL PRIMARY KEY,
    project_name TEXT NOT NULL,
    search_engine TEXT NOT NULL,
    topvisor_project_id TEXT,
    topvisor_region_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_name, search_engine),
    UNIQUE(topvisor_project_id, topvisor_region_id)
);

-- =====================================================
-- TOPVISOR SCHEMA: Данные TopVisor
-- =====================================================

-- Справочник уникальных сниппетов
CREATE TABLE IF NOT EXISTS topvisor.dim_snippets (
    id SERIAL PRIMARY KEY,
    snippet TEXT NOT NULL,
    snippet_hash CHAR(32) UNIQUE NOT NULL,
    uses INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Таблица позиций БЕЗ created_at
CREATE TABLE IF NOT EXISTS topvisor.positions (
    id SERIAL PRIMARY KEY,
    request TEXT NOT NULL,
    event_date DATE NOT NULL,
    position INTEGER,
    relevant_url_id INTEGER REFERENCES common.site_map(id),
    snippet_id INTEGER REFERENCES topvisor.dim_snippets(id),
    project_engine_id INTEGER NOT NULL REFERENCES common.dim_projects_engines(id)
);

-- Уникальный составной индекс для предотвращения дубликатов
CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_unique 
    ON topvisor.positions (request, event_date, project_engine_id);

-- Индексы для оптимизации запросов
CREATE INDEX IF NOT EXISTS idx_positions_event_date 
    ON topvisor.positions (event_date);

CREATE INDEX IF NOT EXISTS idx_positions_request_date 
    ON topvisor.positions (request, event_date);

CREATE INDEX IF NOT EXISTS idx_positions_project_engine 
    ON topvisor.positions (project_engine_id, event_date);

CREATE INDEX IF NOT EXISTS idx_positions_relevant_url_id 
    ON topvisor.positions (relevant_url_id);

-- =====================================================
-- УДАЛИТЕ ИЛИ НЕ СОЗДАВАЙТЕ ПРЕДСТАВЛЕНИЯ
-- =====================================================