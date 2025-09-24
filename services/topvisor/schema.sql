-- schema.sql
-- Обновленная структура БД для TopVisor с нормализованными данными

-- Создание общей схемы если не существует
CREATE SCHEMA IF NOT EXISTS common;

-- Создание таблицы-справочника проектов и поисковых систем
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

-- Комментарии для таблицы справочника
COMMENT ON TABLE common.dim_projects_engines IS 'Справочник проектов и поисковых систем для TopVisor';
COMMENT ON COLUMN common.dim_projects_engines.project_name IS 'Название проекта';
COMMENT ON COLUMN common.dim_projects_engines.search_engine IS 'Поисковая система';
COMMENT ON COLUMN common.dim_projects_engines.topvisor_project_id IS 'ID проекта в TopVisor';
COMMENT ON COLUMN common.dim_projects_engines.topvisor_region_id IS 'ID региона/поисковика в TopVisor';

-- Функция для предварительной инициализации справочника
CREATE OR REPLACE FUNCTION common.initialize_projects_engines()
RETURNS VOID AS $$
BEGIN
    -- Вставляем базовые данные, исключая конфликты
    INSERT INTO common.dim_projects_engines 
        (project_name, search_engine, topvisor_project_id, topvisor_region_id) 
    VALUES
        ('Термины', 'Yandex', '11430357', '5'),
        ('Термины', 'Google', '11430357', '7'),
        ('Блог', 'Yandex', '7093082', '5'),
        ('Блог', 'Google', '7093082', '7'),
        ('DDG-EN', 'Google', '7063718', '159'),
        ('DDG-EN', 'Bing', '7063718', '701'),
        ('DDG-RU', 'Yandex', '7063822', '5'),
        ('DDG-RU', 'Google', '7063822', '7')
    ON CONFLICT (project_name, search_engine) DO NOTHING;
    
    RAISE NOTICE 'Справочник common.dim_projects_engines инициализирован';
END;
$$ LANGUAGE plpgsql;

-- Индексы для справочника
CREATE INDEX IF NOT EXISTS idx_dim_projects_engines_name 
    ON common.dim_projects_engines (project_name);

CREATE INDEX IF NOT EXISTS idx_dim_projects_engines_engine 
    ON common.dim_projects_engines (search_engine);

CREATE INDEX IF NOT EXISTS idx_dim_projects_engines_topvisor_composite 
    ON common.dim_projects_engines (topvisor_project_id, topvisor_region_id);

CREATE INDEX IF NOT EXISTS idx_dim_projects_engines_name_engine 
    ON common.dim_projects_engines (project_name, search_engine);

-- Создание схемы для TopVisor данных
CREATE SCHEMA IF NOT EXISTS topvisor;

-- Создание таблицы позиций (ОБНОВЛЕННАЯ ВЕРСИЯ - без дублирующих колонок)
CREATE TABLE IF NOT EXISTS topvisor.positions (
    id SERIAL PRIMARY KEY,
    request TEXT NOT NULL,
    event_date DATE NOT NULL,
    position INTEGER,
    relevant_url TEXT DEFAULT '',
    snippet TEXT DEFAULT '',
    project_engine_id INTEGER NOT NULL REFERENCES common.dim_projects_engines(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Создание индексов для оптимизации (ОБНОВЛЕННЫЕ)
CREATE INDEX IF NOT EXISTS idx_positions_event_date 
    ON topvisor.positions (event_date);

CREATE INDEX IF NOT EXISTS idx_positions_request_date 
    ON topvisor.positions (request, event_date);

CREATE INDEX IF NOT EXISTS idx_positions_project_engine 
    ON topvisor.positions (project_engine_id, event_date);

CREATE INDEX IF NOT EXISTS idx_positions_unique_check 
    ON topvisor.positions (request, event_date, project_engine_id);

-- Создание уникального составного индекса для предотвращения дубликатов
CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_unique 
    ON topvisor.positions (request, event_date, project_engine_id);

-- Создание триггера для обновления updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Применение триггера к таблице
DROP TRIGGER IF EXISTS update_positions_updated_at ON topvisor.positions;
CREATE TRIGGER update_positions_updated_at 
    BEFORE UPDATE ON topvisor.positions 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Создание представления для удобного анализа (ОБНОВЛЕННОЕ)
CREATE OR REPLACE VIEW topvisor.positions_summary AS
SELECT 
    d.project_name,
    d.search_engine,
    p.event_date,
    COUNT(*) as total_keywords,
    COUNT(CASE WHEN p.position IS NOT NULL THEN 1 END) as positioned_keywords,
    COUNT(CASE WHEN p.position <= 10 THEN 1 END) as top10_positions,
    COUNT(CASE WHEN p.position <= 3 THEN 1 END) as top3_positions,
    ROUND(AVG(p.position), 2) as avg_position,
    MIN(p.created_at) as first_import,
    MAX(p.created_at) as last_import
FROM topvisor.positions p
JOIN common.dim_projects_engines d ON p.project_engine_id = d.id
GROUP BY d.project_name, d.search_engine, p.event_date
ORDER BY p.event_date DESC, d.project_name, d.search_engine;

-- Комментарии к таблице и полям (ОБНОВЛЕННЫЕ)
COMMENT ON SCHEMA topvisor IS 'Google Search Console и TopVisor данные';
COMMENT ON TABLE topvisor.positions IS 'Позиции ключевых слов по проектам и поисковым системам (нормализованная версия)';
COMMENT ON COLUMN topvisor.positions.request IS 'Ключевое слово/поисковый запрос';
COMMENT ON COLUMN topvisor.positions.event_date IS 'Дата сбора данных';
COMMENT ON COLUMN topvisor.positions.position IS 'Позиция в выдаче (NULL если не ранжируется)';
COMMENT ON COLUMN topvisor.positions.relevant_url IS 'URL страницы в результатах поиска';
COMMENT ON COLUMN topvisor.positions.snippet IS 'Сниппет из поисковой выдачи';
COMMENT ON COLUMN topvisor.positions.project_engine_id IS 'Внешний ключ на справочник проектов и поисковых систем';


-- Создание функции для очистки старых данных (старше 1 года)

-- CREATE OR REPLACE FUNCTION cleanup_old_positions(days_to_keep INTEGER DEFAULT 365)
-- RETURNS INTEGER AS $$
-- DECLARE
--     rows_deleted INTEGER;
-- BEGIN
--     DELETE FROM topvisor.positions 
--     WHERE event_date < CURRENT_DATE - INTERVAL '1 day' * days_to_keep;
    
--     GET DIAGNOSTICS rows_deleted = ROW_COUNT;
    
--     RETURN rows_deleted;
-- END;
-- $$ LANGUAGE plpgsql;

-- COMMENT ON FUNCTION cleanup_old_positions IS 'Функция для очистки данных старше указанного количества дней';

-- Пример использования функции очистки:
-- SELECT cleanup_old_positions(365); -- Удалить данные старше 1 года
-- SELECT cleanup_old_positions(90);  -- Удалить данные старше 3 месяцев
