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