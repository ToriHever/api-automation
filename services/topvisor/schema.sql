-- schema.sql
-- Обновленная структура БД для TopVisor с нормализованными данными
-- Дата обновления: 2025-10-17
-- Добавлено: таблица common.requests и триггер автозаполнения request_id

-- ============================================
-- COMMON SCHEMA: Общие справочники
-- ============================================

-- Создание общей схемы если не существует
CREATE SCHEMA IF NOT EXISTS common;

-- ============================================
-- Таблица-справочник проектов и поисковых систем
-- ============================================

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

-- ============================================
-- Таблица-справочник запросов с кластеризацией
-- ============================================

CREATE TABLE IF NOT EXISTS common.requests (
    request_id SERIAL PRIMARY KEY,
    request TEXT NOT NULL UNIQUE,
    cluster_topvisor_id INTEGER,
    hub_id INTEGER,
    type_request_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE common.requests IS 'Справочник поисковых запросов с кластеризацией TopVisor';
COMMENT ON COLUMN common.requests.request_id IS 'Уникальный ID запроса (первичный ключ)';
COMMENT ON COLUMN common.requests.request IS 'Текст поискового запроса (уникальный)';
COMMENT ON COLUMN common.requests.cluster_topvisor_id IS 'ID кластера запросов в TopVisor';
COMMENT ON COLUMN common.requests.hub_id IS 'ID хаба/группы запросов';
COMMENT ON COLUMN common.requests.type_request_id IS 'Тип запроса';

-- Индексы для быстрого поиска в common.requests
CREATE INDEX IF NOT EXISTS idx_requests_cluster 
    ON common.requests(cluster_topvisor_id);

CREATE INDEX IF NOT EXISTS idx_requests_request 
    ON common.requests(request);

CREATE INDEX IF NOT EXISTS idx_requests_hub 
    ON common.requests(hub_id);

-- Внешние ключи для common.requests (раскомментируйте после создания связанных таблиц)
-- ALTER TABLE common.requests ADD CONSTRAINT fk_cluster_topvisor 
--     FOREIGN KEY (cluster_topvisor_id) REFERENCES common.clusters_topvisor(cluster_topvisor_id);
-- ALTER TABLE common.requests ADD CONSTRAINT fk_hub 
--     FOREIGN KEY (hub_id) REFERENCES common.hubs(hub_id);
-- ALTER TABLE common.requests ADD CONSTRAINT fk_type_request 
--     FOREIGN KEY (type_request_id) REFERENCES common.type_request(type_request_id);

-- ============================================
-- TOPVISOR SCHEMA: Данные TopVisor
-- ============================================

-- Создание схемы для TopVisor данных
CREATE SCHEMA IF NOT EXISTS topvisor;

-- ============================================
-- Таблица-справочник уникальных сниппетов
-- ============================================

CREATE TABLE IF NOT EXISTS topvisor.dim_snippets (
    id SERIAL PRIMARY KEY,
    snippet TEXT NOT NULL,
    snippet_hash CHAR(32) UNIQUE NOT NULL, -- Используйте char(32) для MD5
    uses INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dim_snippets_hash ON topvisor.dim_snippets (snippet_hash);

COMMENT ON TABLE topvisor.dim_snippets IS 'Справочник уникальных сниппетов';
COMMENT ON COLUMN topvisor.dim_snippets.snippet IS 'Текст сниппета';
COMMENT ON COLUMN topvisor.dim_snippets.snippet_hash IS 'MD5-хэш сниппета для быстрого поиска и предотвращения дубликатов';
COMMENT ON COLUMN topvisor.dim_snippets.uses IS 'Количество использований этого сниппета';

-- ============================================
-- Основная таблица позиций (РЕАЛЬНАЯ СТРУКТУРА)
-- ============================================

CREATE TABLE IF NOT EXISTS topvisor.positions (
    id SERIAL PRIMARY KEY,
    request TEXT NOT NULL,
    event_date DATE NOT NULL,
    position INTEGER,
    relevant_url_id INTEGER,  -- ИСПРАВЛЕНО: было relevant_url
    snippet_id INTEGER REFERENCES topvisor.dim_snippets(id),
    project_engine_id INTEGER NOT NULL REFERENCES common.dim_projects_engines(id),
    cluster_topvisor_id INTEGER,  -- Уже существует в вашей БД
    request_id INTEGER  -- Связь с common.requests (заполняется триггером)
);

-- Комментарии к таблице и полям
COMMENT ON TABLE topvisor.positions IS 'Позиции ключевых слов по проектам и поисковым системам (нормализованная версия)';
COMMENT ON COLUMN topvisor.positions.request IS 'Ключевое слово/поисковый запрос';
COMMENT ON COLUMN topvisor.positions.event_date IS 'Дата сбора данных';
COMMENT ON COLUMN topvisor.positions.position IS 'Позиция в выдаче (NULL если не ранжируется)';
COMMENT ON COLUMN topvisor.positions.relevant_url_id IS 'ID URL страницы в результатах поиска';
COMMENT ON COLUMN topvisor.positions.snippet_id IS 'Внешний ключ на справочник сниппетов';
COMMENT ON COLUMN topvisor.positions.project_engine_id IS 'Внешний ключ на справочник проектов и поисковых систем';
COMMENT ON COLUMN topvisor.positions.cluster_topvisor_id IS 'ID кластера TopVisor (может дублировать данные из common.requests)';
COMMENT ON COLUMN topvisor.positions.request_id IS 'ID запроса из справочника common.requests (связь по полю request, заполняется автоматически триггером)';

-- ============================================
-- Внешний ключ для request_id
-- ============================================

ALTER TABLE topvisor.positions 
DROP CONSTRAINT IF EXISTS fk_positions_request;

ALTER TABLE topvisor.positions 
ADD CONSTRAINT fk_positions_request 
FOREIGN KEY (request_id) 
REFERENCES common.requests(request_id)
ON DELETE SET NULL;

-- ============================================
-- Индексы для оптимизации
-- ============================================

CREATE INDEX IF NOT EXISTS idx_positions_event_date 
    ON topvisor.positions (event_date);

CREATE INDEX IF NOT EXISTS idx_positions_request_date 
    ON topvisor.positions (request, event_date);

CREATE INDEX IF NOT EXISTS idx_positions_project_engine 
    ON topvisor.positions (project_engine_id, event_date);

CREATE INDEX IF NOT EXISTS idx_positions_unique_check 
    ON topvisor.positions (request, event_date, project_engine_id);

CREATE INDEX IF NOT EXISTS idx_positions_request_id 
    ON topvisor.positions(request_id);

CREATE INDEX IF NOT EXISTS idx_positions_cluster_topvisor 
    ON topvisor.positions(cluster_topvisor_id);

-- Создание уникального составного индекса для предотвращения дубликатов
CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_unique 
    ON topvisor.positions (request, event_date, project_engine_id);

-- ============================================
-- ТРИГГЕР: Автозаполнение request_id
-- ============================================

-- Создание функции триггера для автозаполнения request_id
CREATE OR REPLACE FUNCTION set_topvisor_request_id()
RETURNS TRIGGER AS $$
BEGIN
    -- Поиск request_id по полю request из таблицы common.requests
    SELECT request_id 
    INTO NEW.request_id
    FROM common.requests
    WHERE request = NEW.request
    LIMIT 1;
    
    -- Если не найдено, request_id останется NULL
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION set_topvisor_request_id() IS 'Автоматически заполняет request_id в topvisor.positions по полю request из справочника common.requests';

-- Удаляем старый триггер, если существует
DROP TRIGGER IF EXISTS before_insert_topvisor_positions ON topvisor.positions;

-- Создание триггера
CREATE TRIGGER before_insert_topvisor_positions
BEFORE INSERT ON topvisor.positions
FOR EACH ROW
EXECUTE FUNCTION set_topvisor_request_id();

COMMENT ON TRIGGER before_insert_topvisor_positions ON topvisor.positions IS 
'Триггер автоматического заполнения request_id из справочника common.requests при вставке новых записей';

-- ============================================
-- VIEW: Представление для удобного анализа
-- ============================================

CREATE OR REPLACE VIEW topvisor.positions_summary AS
SELECT 
    d.project_name,
    d.search_engine,
    p.event_date,
    COUNT(*) as total_keywords,
    COUNT(CASE WHEN p.position IS NOT NULL THEN 1 END) as positioned_keywords,
    COUNT(CASE WHEN p.position <= 10 THEN 1 END) as top10_positions,
    COUNT(CASE WHEN p.position <= 3 THEN 1 END) as top3_positions,
    ROUND(AVG(p.position), 2) as avg_position
FROM topvisor.positions p
JOIN common.dim_projects_engines d ON p.project_engine_id = d.id
GROUP BY d.project_name, d.search_engine, p.event_date
ORDER BY p.event_date DESC, d.project_name, d.search_engine;

COMMENT ON VIEW topvisor.positions_summary IS 'Сводная статистика по позициям для аналитики';

-- ============================================
-- КОММЕНТАРИЙ К СХЕМЕ
-- ============================================

COMMENT ON SCHEMA topvisor IS 'Google Search Console и TopVisor данные с нормализованной структурой';

-- ============================================
-- ФУНКЦИЯ ОЧИСТКИ СТАРЫХ ДАННЫХ (закомментирована)
-- ============================================

-- Раскомментируйте для использования функции очистки старых данных
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

-- Примеры использования функции очистки:
-- SELECT cleanup_old_positions(365); -- Удалить данные старше 1 года
-- SELECT cleanup_old_positions(90);  -- Удалить данные старше 3 месяцев

-- ============================================
-- ПРИМЕРЫ ИСПОЛЬЗОВАНИЯ
-- ============================================

-- Инициализация справочника проектов (однократно):
-- SELECT common.initialize_projects_engines();

-- Пример вставки данных (request_id заполнится автоматически через триггер):
-- INSERT INTO topvisor.positions (request, event_date, position, relevant_url_id, snippet_id, project_engine_id)
-- VALUES ('купить телефон', CURRENT_DATE, 5, 123, 1, 1);

-- Проверка работы триггера:
-- SELECT request, request_id, cluster_topvisor_id FROM topvisor.positions WHERE request = 'купить телефон';

-- Аналитика с использованием VIEW:
-- SELECT * FROM topvisor.positions_summary WHERE event_date = CURRENT_DATE;