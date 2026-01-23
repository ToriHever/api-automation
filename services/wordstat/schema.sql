-- ============================================
-- WordStat Schema (БЕЗ удаления существующих данных)
-- ============================================

CREATE SCHEMA IF NOT EXISTS wordstat;

-- ✅ ИСПРАВЛЕНО: Создаём таблицу только если её нет
-- Убрали DROP TABLE - теперь данные сохраняются между запусками
CREATE TABLE IF NOT EXISTS wordstat.tmp_dynamics (
    id SERIAL PRIMARY KEY,
    request TEXT NOT NULL,
    month DATE NOT NULL,
    frequency INTEGER NOT NULL DEFAULT 0,
    "group" TEXT NOT NULL DEFAULT 'Нет группы',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(request, month)
);

COMMENT ON COLUMN wordstat.tmp_dynamics.month IS 'Месяц в формате YYYY-MM-DD (например 2025-09-01)';

-- ============================================
-- Индексы (создаём только если не существуют)
-- ============================================

DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_tmp_dynamics_request') THEN
        CREATE INDEX idx_tmp_dynamics_request ON wordstat.tmp_dynamics(request);
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_tmp_dynamics_month') THEN
        CREATE INDEX idx_tmp_dynamics_month ON wordstat.tmp_dynamics(month);
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_tmp_dynamics_group') THEN
        CREATE INDEX idx_tmp_dynamics_group ON wordstat.tmp_dynamics("group");
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_tmp_dynamics_request_month') THEN
        CREATE INDEX idx_tmp_dynamics_request_month ON wordstat.tmp_dynamics(request, month);
    END IF;
END $$;

-- ============================================
-- Триггер обновления (пересоздаём всегда)
-- ============================================

CREATE OR REPLACE FUNCTION wordstat.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_wordstat_updated_at ON wordstat.tmp_dynamics;

CREATE TRIGGER update_wordstat_updated_at
    BEFORE UPDATE ON wordstat.tmp_dynamics
    FOR EACH ROW
    EXECUTE FUNCTION wordstat.update_updated_at_column();

-- ============================================
-- VIEW: Агрегированная статистика
-- ============================================

CREATE OR REPLACE VIEW wordstat.dynamics_summary AS
SELECT 
    request,
    COUNT(*) as total_months,
    SUM(frequency) as total_frequency,
    ROUND(AVG(frequency), 2) as avg_frequency,
    MIN(frequency) as min_frequency,
    MAX(frequency) as max_frequency,
    MIN(month) as first_month,
    MAX(month) as last_month,
    "group"
FROM wordstat.tmp_dynamics
GROUP BY request, "group"
ORDER BY total_frequency DESC;

-- ============================================
-- VIEW: Динамика по месяцам
-- ============================================

CREATE OR REPLACE VIEW wordstat.monthly_trends AS
SELECT 
    TO_CHAR(month, 'YYYY-MM') as month_text,
    month as month_date,
    COUNT(DISTINCT request) as unique_requests,
    SUM(frequency) as total_frequency,
    ROUND(AVG(frequency), 2) as avg_frequency,
    "group"
FROM wordstat.tmp_dynamics
GROUP BY month, "group"
ORDER BY month DESC;

-- ============================================
-- VIEW: С процентом изменения
-- ============================================

CREATE OR REPLACE VIEW wordstat.dynamics_with_change AS
SELECT 
    d.request,
    TO_CHAR(d.month, 'YYYY-MM') as month,
    d.frequency,
    LAG(d.frequency) OVER (PARTITION BY d.request ORDER BY d.month) as prev_frequency,
    d.frequency - LAG(d.frequency) OVER (PARTITION BY d.request ORDER BY d.month) as change,
    ROUND(
        ((d.frequency - LAG(d.frequency) OVER (PARTITION BY d.request ORDER BY d.month))::NUMERIC 
        / NULLIF(LAG(d.frequency) OVER (PARTITION BY d.request ORDER BY d.month), 0) * 100), 
        2
    ) as change_percent,
    d."group"
FROM wordstat.tmp_dynamics d
ORDER BY d.request, d.month DESC;

-- ============================================
-- Функция очистки старых данных
-- ============================================

CREATE OR REPLACE FUNCTION wordstat.cleanup_old_data(months_to_keep INTEGER DEFAULT 24)
RETURNS INTEGER AS $$
DECLARE
    rows_deleted INTEGER;
    cutoff_date DATE;
BEGIN
    cutoff_date := DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month' * months_to_keep)::DATE;
    
    DELETE FROM wordstat.tmp_dynamics WHERE month < cutoff_date;
    
    GET DIAGNOSTICS rows_deleted = ROW_COUNT;
    RAISE NOTICE 'Удалено % записей старше %', rows_deleted, TO_CHAR(cutoff_date, 'YYYY-MM');
    
    RETURN rows_deleted;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Функция полного пересоздания таблицы (если нужно)
-- ============================================

CREATE OR REPLACE FUNCTION wordstat.recreate_table()
RETURNS VOID AS $$
BEGIN
    DROP TABLE IF EXISTS wordstat.tmp_dynamics CASCADE;
    
    CREATE TABLE wordstat.tmp_dynamics (
        id SERIAL PRIMARY KEY,
        request TEXT NOT NULL,
        month DATE NOT NULL,
        frequency INTEGER NOT NULL DEFAULT 0,
        "group" TEXT NOT NULL DEFAULT 'Нет группы',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(request, month)
    );
    
    CREATE INDEX idx_tmp_dynamics_request ON wordstat.tmp_dynamics(request);
    CREATE INDEX idx_tmp_dynamics_month ON wordstat.tmp_dynamics(month);
    CREATE INDEX idx_tmp_dynamics_group ON wordstat.tmp_dynamics("group");
    CREATE INDEX idx_tmp_dynamics_request_month ON wordstat.tmp_dynamics(request, month);
    
    RAISE NOTICE 'Таблица wordstat.tmp_dynamics пересоздана';
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Полезные запросы
-- ============================================

-- Динамика за последние 12 месяцев:
-- SELECT 
--     TO_CHAR(month, 'YYYY-MM') as month,
--     request,
--     frequency
-- FROM wordstat.tmp_dynamics
-- WHERE month >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '12 months')
-- ORDER BY request, month DESC;

-- Топ-10 запросов последнего месяца:
-- SELECT request, frequency, TO_CHAR(month, 'YYYY-MM') as month
-- FROM wordstat.tmp_dynamics
-- WHERE month = (SELECT MAX(month) FROM wordstat.tmp_dynamics)
-- ORDER BY frequency DESC LIMIT 10;

-- Рост/падение:
-- SELECT * FROM wordstat.dynamics_with_change
-- WHERE prev_frequency IS NOT NULL
-- ORDER BY change_percent DESC LIMIT 20;

-- Если нужно ПОЛНОСТЬЮ очистить и пересоздать таблицу:
-- SELECT wordstat.recreate_table();