-- ============================================
-- WordStat Schema — безопасное применение
-- Таблицы уже существуют в правильной структуре.
-- Этот файл только добавляет триггеры updated_at.
-- ============================================

CREATE SCHEMA IF NOT EXISTS wordstat;

-- ============================================
-- Функция обновления updated_at
-- ============================================

CREATE OR REPLACE FUNCTION wordstat.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Триггер для tmp_dynamics
-- ============================================

DROP TRIGGER IF EXISTS update_wordstat_updated_at ON wordstat.tmp_dynamics;

CREATE TRIGGER update_wordstat_updated_at
    BEFORE UPDATE ON wordstat.tmp_dynamics
    FOR EACH ROW
    EXECUTE FUNCTION wordstat.update_updated_at_column();

-- ============================================
-- Триггер для top_requests
-- ============================================

DROP TRIGGER IF EXISTS update_top_requests_updated_at ON wordstat.top_requests;

CREATE TRIGGER update_top_requests_updated_at
    BEFORE UPDATE ON wordstat.top_requests
    FOR EACH ROW
    EXECUTE FUNCTION wordstat.update_updated_at_column();

    -- ============================================
-- Очередь сбора (для соблюдения квоты Wordstat: 100 запросов/час)
-- ============================================

CREATE TABLE IF NOT EXISTS wordstat.collection_queue (
    id SERIAL PRIMARY KEY,
    method VARCHAR(20) NOT NULL,
    phrase TEXT NOT NULL,
    period_start DATE,
    period_end DATE,
    check_date DATE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP,
    UNIQUE(method, phrase, period_start, period_end, check_date)
);

CREATE INDEX IF NOT EXISTS idx_queue_pending
    ON wordstat.collection_queue(method, status);

-- ============================================
-- check_list — какие запросы проверяются через Wordstat (заменяет
-- .txt-файлы в services/wordstat/keywords/: dynamics_keywords_commercial.txt,
-- dynamics_keywords_content.txt, top_keywords.txt — см. 2026-09-30).
-- category различает приоритет для method='dynamics' (commercial собирается
-- раньше content — см. WordStatCollector.readActiveRequests); для
-- method='top' category не используется (NULL).
-- Редактируется напрямую в БД (is_active = false вместо удаления строки
-- из .txt-файла), подхватывается со следующего периода сбора, как и раньше.
-- ============================================

CREATE TABLE IF NOT EXISTS wordstat.check_list (
    id SERIAL PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES common.requests(request_id),
    method VARCHAR(20) NOT NULL CHECK (method IN ('dynamics', 'top')),
    category VARCHAR(20) CHECK (category IN ('commercial', 'content')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (request_id, method)
);

CREATE INDEX IF NOT EXISTS idx_check_list_method_active
    ON wordstat.check_list(method, is_active);

DROP TRIGGER IF EXISTS update_check_list_updated_at ON wordstat.check_list;

CREATE TRIGGER update_check_list_updated_at
    BEFORE UPDATE ON wordstat.check_list
    FOR EACH ROW
    EXECUTE FUNCTION wordstat.update_updated_at_column();

-- ============================================
-- v_check_list_summary — сколько запросов активно/неактивно по commercial/
-- content/top (см. "Проверка статуса отслеживания" в README).
-- ============================================

CREATE OR REPLACE VIEW wordstat.v_check_list_summary AS
SELECT
    CASE
        WHEN method = 'dynamics' AND category = 'commercial' THEN 'commercial'
        WHEN method = 'dynamics' AND category = 'content'    THEN 'content'
        WHEN method = 'top'                                   THEN 'top'
        ELSE 'other'
    END AS bucket,
    COUNT(*) FILTER (WHERE is_active)     AS active_count,
    COUNT(*) FILTER (WHERE NOT is_active) AS inactive_count,
    COUNT(*)                              AS total_count
FROM wordstat.check_list
GROUP BY 1
ORDER BY 1;