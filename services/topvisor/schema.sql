-- Создание схем
CREATE SCHEMA IF NOT EXISTS topvisor;
CREATE SCHEMA IF NOT EXISTS common;

-- 1. Справочник проектов и поисковых систем
CREATE TABLE IF NOT EXISTS common.dim_projects_engines (
    id SERIAL PRIMARY KEY,
    project_name TEXT NOT NULL,
    search_engine TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_name, search_engine)
);

-- Индекс для быстрого поиска
CREATE INDEX IF NOT EXISTS idx_dim_projects_engines_lookup 
    ON common.dim_projects_engines (project_name, search_engine);

-- 2. Справочник сниппетов с дедупликацией
CREATE TABLE IF NOT EXISTS topvisor.dim_snippets (
    id SERIAL PRIMARY KEY,
    snippet_hash CHAR(32) NOT NULL UNIQUE, -- MD5 hash
    snippet TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    uses INTEGER DEFAULT 0 -- Счетчик использований
);

-- Индексы для оптимизации
CREATE INDEX IF NOT EXISTS idx_dim_snippets_hash 
    ON topvisor.dim_snippets (snippet_hash);
CREATE INDEX IF NOT EXISTS idx_dim_snippets_uses 
    ON topvisor.dim_snippets (uses DESC);

-- 3. Обновленная основная таблица позиций
DROP TABLE IF EXISTS topvisor.positions_old;
ALTER TABLE IF EXISTS topvisor.positions RENAME TO positions_old;

CREATE TABLE topvisor.positions (
    id SERIAL PRIMARY KEY,
    request TEXT NOT NULL,
    event_date DATE NOT NULL,
    position INTEGER,
    relevant_url TEXT DEFAULT '',
    snippet_id INTEGER REFERENCES topvisor.dim_snippets(id),
    project_engine_id INTEGER NOT NULL REFERENCES common.dim_projects_engines(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Индексы для оптимизации
CREATE INDEX IF NOT EXISTS idx_positions_event_date 
    ON topvisor.positions (event_date);
CREATE INDEX IF NOT EXISTS idx_positions_project_engine 
    ON topvisor.positions (project_engine_id);
CREATE INDEX IF NOT EXISTS idx_positions_request_date 
    ON topvisor.positions (request, event_date);
CREATE INDEX IF NOT EXISTS idx_positions_snippet 
    ON topvisor.positions (snippet_id);

-- Уникальный индекс для предотвращения дубликатов
CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_unique 
    ON topvisor.positions (request, event_date, project_engine_id);

-- Триггер для обновления updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Применение триггера
DROP TRIGGER IF EXISTS update_positions_updated_at ON topvisor.positions;
CREATE TRIGGER update_positions_updated_at 
    BEFORE UPDATE ON topvisor.positions 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Триггер для обновления updated_at в dim_snippets
DROP TRIGGER IF EXISTS update_snippets_updated_at ON topvisor.dim_snippets;
CREATE TRIGGER update_snippets_updated_at 
    BEFORE UPDATE ON topvisor.dim_snippets 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 4. Представление для удобного анализа с JOIN'ами
CREATE OR REPLACE VIEW topvisor.positions_detailed AS
SELECT 
    p.id,
    p.request,
    p.event_date,
    p.position,
    p.relevant_url,
    pe.project_name,
    pe.search_engine,
    s.snippet,
    p.created_at,
    p.updated_at
FROM topvisor.positions p
JOIN common.dim_projects_engines pe ON p.project_engine_id = pe.id
LEFT JOIN topvisor.dim_snippets s ON p.snippet_id = s.id;

-- 5. Представление для аналитики
CREATE OR REPLACE VIEW topvisor.positions_summary AS
SELECT 
    pe.project_name,
    pe.search_engine,
    p.event_date,
    COUNT(*) as total_keywords,
    COUNT(CASE WHEN p.position IS NOT NULL THEN 1 END) as positioned_keywords,
    COUNT(CASE WHEN p.position <= 10 THEN 1 END) as top10_positions,
    COUNT(CASE WHEN p.position <= 3 THEN 1 END) as top3_positions,
    ROUND(AVG(p.position), 2) as avg_position,
    MIN(p.created_at) as first_import,
    MAX(p.created_at) as last_import
FROM topvisor.positions p
JOIN common.dim_projects_engines pe ON p.project_engine_id = pe.id
GROUP BY pe.project_name, pe.search_engine, p.event_date
ORDER BY p.event_date DESC, pe.project_name, pe.search_engine;

-- 6. Функции для работы с dimension таблицами

-- Функция получения/создания project_engine_id
CREATE OR REPLACE FUNCTION get_or_create_project_engine_id(
    p_project_name TEXT,
    p_search_engine TEXT
) RETURNS INTEGER AS $$
DECLARE
    pe_id INTEGER;
BEGIN
    -- Пытаемся найти существующую запись
    SELECT id INTO pe_id 
    FROM common.dim_projects_engines 
    WHERE project_name = p_project_name AND search_engine = p_search_engine;
    
    -- Если не найдено, создаем новую
    IF pe_id IS NULL THEN
        INSERT INTO common.dim_projects_engines (project_name, search_engine)
        VALUES (p_project_name, p_search_engine)
        ON CONFLICT (project_name, search_engine) DO NOTHING
        RETURNING id INTO pe_id;
        
        -- Если все еще NULL (race condition), делаем еще один SELECT
        IF pe_id IS NULL THEN
            SELECT id INTO pe_id 
            FROM common.dim_projects_engines 
            WHERE project_name = p_project_name AND search_engine = p_search_engine;
        END IF;
    END IF;
    
    RETURN pe_id;
END;
$$ LANGUAGE plpgsql;

-- Функция получения/создания snippet_id
CREATE OR REPLACE FUNCTION get_or_create_snippet_id(
    p_snippet TEXT
) RETURNS INTEGER AS $$
DECLARE
    s_id INTEGER;
    s_hash CHAR(32);
BEGIN
    -- Создаем MD5 хеш
    s_hash := MD5(p_snippet);
    
    -- Пытаемся найти существующую запись
    SELECT id INTO s_id 
    FROM topvisor.dim_snippets 
    WHERE snippet_hash = s_hash;
    
    -- Если не найдено, создаем новую
    IF s_id IS NULL THEN
        INSERT INTO topvisor.dim_snippets (snippet_hash, snippet, uses)
        VALUES (s_hash, p_snippet, 1)
        ON CONFLICT (snippet_hash) DO UPDATE SET 
            uses = topvisor.dim_snippets.uses + 1,
            updated_at = CURRENT_TIMESTAMP
        RETURNING id INTO s_id;
        
        -- Если все еще NULL (race condition), делаем еще один SELECT и UPDATE
        IF s_id IS NULL THEN
            SELECT id INTO s_id 
            FROM topvisor.dim_snippets 
            WHERE snippet_hash = s_hash;
            
            UPDATE topvisor.dim_snippets 
            SET uses = uses + 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = s_id;
        END IF;
    ELSE
        -- Увеличиваем счетчик использований
        UPDATE topvisor.dim_snippets 
        SET uses = uses + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = s_id;
    END IF;
    
    RETURN s_id;
END;
$$ LANGUAGE plpgsql;

-- 7. Функция для миграции данных из старой структуры (если нужно)
CREATE OR REPLACE FUNCTION migrate_old_positions() RETURNS INTEGER AS $$
DECLARE
    rec RECORD;
    migrated_count INTEGER := 0;
    pe_id INTEGER;
    s_id INTEGER;
BEGIN
    -- Проверяем существование старой таблицы
    IF EXISTS (SELECT 1 FROM information_schema.tables 
               WHERE table_schema = 'topvisor' AND table_name = 'positions_old') THEN
        
        FOR rec IN 
            SELECT request, event_date, project_name, search_engine, 
                   position, relevant_url, snippet, created_at
            FROM topvisor.positions_old 
        LOOP
            -- Получаем ID для project_engine
            pe_id := get_or_create_project_engine_id(rec.project_name, rec.search_engine);
            
            -- Получаем ID для snippet
            IF rec.snippet IS NOT NULL AND rec.snippet != '' THEN
                s_id := get_or_create_snippet_id(rec.snippet);
            ELSE
                s_id := NULL;
            END IF;
            
            -- Вставляем в новую таблицу
            INSERT INTO topvisor.positions (
                request, event_date, position, relevant_url, 
                snippet_id, project_engine_id, created_at
            ) VALUES (
                rec.request, rec.event_date, rec.position, rec.relevant_url,
                s_id, pe_id, rec.created_at
            ) ON CONFLICT (request, event_date, project_engine_id) DO NOTHING;
            
            migrated_count := migrated_count + 1;
            
            -- Логируем прогресс каждые 1000 записей
            IF migrated_count % 1000 = 0 THEN
                RAISE NOTICE 'Migrated % records', migrated_count;
            END IF;
        END LOOP;
        
        RAISE NOTICE 'Migration completed. Total records migrated: %', migrated_count;
    ELSE
        RAISE NOTICE 'Old table positions_old does not exist. Nothing to migrate.';
    END IF;
    
    RETURN migrated_count;
END;
$$ LANGUAGE plpgsql;

-- Комментарии
COMMENT ON SCHEMA common IS 'Общие справочники для всех сервисов';
COMMENT ON TABLE common.dim_projects_engines IS 'Справочник проектов и поисковых систем';
COMMENT ON TABLE topvisor.dim_snippets IS 'Дедуплицированные сниппеты с хешированием';
COMMENT ON TABLE topvisor.positions IS 'Позиции ключевых слов с нормализованной структурой';
COMMENT ON COLUMN topvisor.dim_snippets.snippet_hash IS 'MD5 хеш сниппета для дедупликации';
COMMENT ON COLUMN topvisor.dim_snippets.uses IS 'Количество использований сниппета';

-- Пример использования функций:
-- SELECT get_or_create_project_engine_id('DDG-RU', 'Google');
-- SELECT get_or_create_snippet_id('Какой-то текст сниппета');
-- SELECT migrate_old_positions(); -- Для миграции старых данных