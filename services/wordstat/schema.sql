-- ============================================
-- WordStat Schema
-- ============================================

-- Создание схемы (если не существует)
CREATE SCHEMA IF NOT EXISTS wordstat;

-- ============================================
-- Основная таблица с динамикой запросов
-- ============================================

CREATE TABLE IF NOT EXISTS wordstat.tmp_dynamics (
    id SERIAL PRIMARY KEY,
    request TEXT NOT NULL,
    month VARCHAR(7) NOT NULL,  -- Формат: YYYY-MM
    frequency INTEGER NOT NULL DEFAULT 0,
    "group" TEXT DEFAULT 'Нет группы',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Уникальность по комбинации: запрос + месяц
    UNIQUE(request, month)
);

COMMENT ON TABLE wordstat.tmp_dynamics IS 'Временная таблица с динамикой частотности запросов Яндекс.Wordstat';
COMMENT ON COLUMN wordstat.tmp_dynamics.request IS 'Поисковый запрос';
COMMENT ON COLUMN wordstat.tmp_dynamics.month IS 'Месяц в формате YYYY-MM';
COMMENT ON COLUMN wordstat.tmp_dynamics.frequency IS 'Частотность запроса за месяц';
COMMENT ON COLUMN wordstat.tmp_dynamics."group" IS 'Группа запросов (пока "Нет группы")';

-- Индексы для оптимизации запросов
CREATE INDEX IF NOT EXISTS idx_tmp_dynamics_request ON wordstat.tmp_dynamics(request);
CREATE INDEX IF NOT EXISTS idx_tmp_dynamics_month ON wordstat.tmp_dynamics(month);
CREATE INDEX IF NOT EXISTS idx_tmp_dynamics_group ON wordstat.tmp_dynamics("group");
CREATE INDEX IF NOT EXISTS idx_tmp_dynamics_request_month ON wordstat.tmp_dynamics(request, month);

-- ============================================
-- TRIGGERS: Автообновление updated_at
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
    AVG(frequency) as avg_frequency,
    MIN(frequency) as min_frequency,
    MAX(frequency) as max_frequency,
    MIN(month) as first_month,
    MAX(month) as last_month,
    "group"
FROM wordstat.tmp_dynamics
GROUP BY request, "group"
ORDER BY total_frequency DESC;

COMMENT ON VIEW wordstat.dynamics_summary IS 'Агрегированная статистика по запросам';

-- ============================================
-- VIEW: Динамика по месяцам
-- ============================================

CREATE OR REPLACE VIEW wordstat.monthly_trends AS
SELECT 
    month,
    COUNT(DISTINCT request) as unique_requests,
    SUM(frequency) as total_frequency,
    AVG(frequency) as avg_frequency,
    "group"
FROM wordstat.tmp_dynamics
GROUP BY month, "group"
ORDER BY month DESC;

COMMENT ON VIEW wordstat.monthly_trends IS 'Тренды частотности по месяцам';

-- ============================================
-- Функция для очистки старых данных
-- ============================================

CREATE OR REPLACE FUNCTION wordstat.cleanup_old_data(months_to_keep INTEGER DEFAULT 24)
RETURNS INTEGER AS $$
DECLARE
    rows_deleted INTEGER;
    cutoff_date TEXT;
BEGIN
    -- Вычисляем дату отсечения
    cutoff_date := TO_CHAR(CURRENT_DATE - INTERVAL '1 month' * months_to_keep, 'YYYY-MM');
    
    -- Удаляем старые данные
    DELETE FROM wordstat.tmp_dynamics 
    WHERE month < cutoff_date;
    
    GET DIAGNOSTICS rows_deleted = ROW_COUNT;
    
    RETURN rows_deleted;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION wordstat.cleanup_old_data IS 'Удаляет данные старше указанного количества месяцев';

-- ============================================
-- Примеры использования
-- ============================================

-- Пример вставки данных:
-- INSERT INTO wordstat.tmp_dynamics (request, month, frequency, "group")
-- VALUES ('ddos защита', '2024-01', 12500, 'Нет группы')
-- ON CONFLICT (request, month) 
-- DO UPDATE SET frequency = EXCLUDED.frequency, updated_at = CURRENT_TIMESTAMP;

-- Пример запроса статистики:
-- SELECT * FROM wordstat.dynamics_summary WHERE request LIKE '%ddos%';

-- Пример очистки старых данных (старше 2 лет):
-- SELECT wordstat.cleanup_old_data(24);