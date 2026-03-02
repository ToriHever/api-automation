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