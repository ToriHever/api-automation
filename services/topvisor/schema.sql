-- Создание схемы для TopVisor данных
CREATE SCHEMA IF NOT EXISTS topvisor;

-- Создание таблицы позиций
CREATE TABLE IF NOT EXISTS topvisor.positions (
    id SERIAL PRIMARY KEY,
    request TEXT NOT NULL,
    event_date DATE NOT NULL,
    project_name TEXT NOT NULL,
    search_engine TEXT NOT NULL,
    position INTEGER,
    relevant_url TEXT DEFAULT '',
    snippet TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Создание индексов для оптимизации
CREATE INDEX IF NOT EXISTS idx_positions_event_date 
    ON topvisor.positions (event_date);

CREATE INDEX IF NOT EXISTS idx_positions_project_search 
    ON topvisor.positions (project_name, search_engine);

CREATE INDEX IF NOT EXISTS idx_positions_request_date 
    ON topvisor.positions (request, event_date);

CREATE INDEX IF NOT EXISTS idx_positions_unique_check 
    ON topvisor.positions (request, event_date, project_name, search_engine);

-- Создание уникального составного индекса для предотвращения дубликатов
CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_unique 
    ON topvisor.positions (request, event_date, project_name, search_engine);

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

-- Создание представления для удобного анализа
CREATE OR REPLACE VIEW topvisor.positions_summary AS
SELECT 
    project_name,
    search_engine,
    event_date,
    COUNT(*) as total_keywords,
    COUNT(CASE WHEN position IS NOT NULL THEN 1 END) as positioned_keywords,
    COUNT(CASE WHEN position <= 10 THEN 1 END) as top10_positions,
    COUNT(CASE WHEN position <= 3 THEN 1 END) as top3_positions,
    ROUND(AVG(position), 2) as avg_position,
    MIN(created_at) as first_import,
    MAX(created_at) as last_import
FROM topvisor.positions 
GROUP BY project_name, search_engine, event_date
ORDER BY event_date DESC, project_name, search_engine;

-- Комментарии к таблице и полям
COMMENT ON SCHEMA topvisor IS 'Google Search Console и TopVisor данные';
COMMENT ON TABLE topvisor.positions IS 'Позиции ключевых слов по проектам и поисковым системам';
COMMENT ON COLUMN topvisor.positions.request IS 'Ключевое слово/поисковый запрос';
COMMENT ON COLUMN topvisor.positions.event_date IS 'Дата сбора данных';
COMMENT ON COLUMN topvisor.positions.project_name IS 'Название проекта (Термины, Блог, DDG-EN, DDG-RU)';
COMMENT ON COLUMN topvisor.positions.search_engine IS 'Поисковая система (Google, Yandex, Bing)';
COMMENT ON COLUMN topvisor.positions.position IS 'Позиция в выдаче (NULL если не ранжируется)';
COMMENT ON COLUMN topvisor.positions.relevant_url IS 'URL страницы в результатах поиска';
COMMENT ON COLUMN topvisor.positions.snippet IS 'Сниппет из поисковой выдачи';

-- Создание функции для очистки старых данных (старше 1 года)
CREATE OR REPLACE FUNCTION cleanup_old_positions(days_to_keep INTEGER DEFAULT 365)
RETURNS INTEGER AS $$
DECLARE
    rows_deleted INTEGER;
BEGIN
    DELETE FROM topvisor.positions 
    WHERE event_date < CURRENT_DATE - INTERVAL '1 day' * days_to_keep;
    
    GET DIAGNOSTICS rows_deleted = ROW_COUNT;
    
    RETURN rows_deleted;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_old_positions IS 'Функция для очистки данных старше указанного количества дней';

-- Пример использования функции очистки:
-- SELECT cleanup_old_positions(365); -- Удалить данные старше 1 года
-- SELECT cleanup_old_positions(90);  -- Удалить данные старше 3 месяцев