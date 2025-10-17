-- ============================================
-- Добавление таблицы common.requests и триггера
-- ============================================

BEGIN;

-- Создание таблицы common.requests
CREATE TABLE IF NOT EXISTS common.requests (
    request TEXT PRIMARY KEY,
    cluster_topvisor_id INTEGER,
    request_id INTEGER,
    hub_id INTEGER,
    type_request_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Комментарии к таблице
COMMENT ON TABLE common.requests IS 'Справочник поисковых запросов с кластеризацией TopVisor';
COMMENT ON COLUMN common.requests.request IS 'Текст поискового запроса (первичный ключ)';
COMMENT ON COLUMN common.requests.cluster_topvisor_id IS 'ID кластера запросов в TopVisor';

-- Индексы для быстрого поиска
CREATE INDEX IF NOT EXISTS idx_requests_cluster 
    ON common.requests(cluster_topvisor_id);

CREATE INDEX IF NOT EXISTS idx_requests_request_id 
    ON common.requests(request_id);

-- Добавление колонки cluster_topvisor_id в topvisor.positions
ALTER TABLE topvisor.positions 
ADD COLUMN IF NOT EXISTS cluster_topvisor_id INTEGER;

COMMENT ON COLUMN topvisor.positions.cluster_topvisor_id IS 'ID кластера запросов из справочника common.requests';

-- Индекс для ускорения JOIN-ов
CREATE INDEX IF NOT EXISTS idx_positions_cluster_topvisor 
    ON topvisor.positions(cluster_topvisor_id);

-- Создание функции триггера
CREATE OR REPLACE FUNCTION set_topvisor_cluster_id()
RETURNS TRIGGER AS $$
BEGIN
    SELECT cluster_topvisor_id 
    INTO NEW.cluster_topvisor_id
    FROM common.requests
    WHERE request = NEW.request
    LIMIT 1;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Создание триггера
DROP TRIGGER IF EXISTS before_insert_topvisor_positions ON topvisor.positions;

CREATE TRIGGER before_insert_topvisor_positions
BEFORE INSERT ON topvisor.positions
FOR EACH ROW
EXECUTE FUNCTION set_topvisor_cluster_id();

COMMIT;