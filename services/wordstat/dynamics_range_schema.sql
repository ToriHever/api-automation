-- services/wordstat/dynamics_range_schema.sql
-- Разовый сбор динамики частотности одним запросом на фразу за весь диапазон дат
-- (вместо помесячного сбора через wordstat.collection_queue / wordstat.tmp_dynamics).
-- Заполняется scripts/wordstat-dynamics-range.js. Не связано с продовым сбором WordStatCollector.js.

CREATE SCHEMA IF NOT EXISTS wordstat;

-- Очередь фраз (свой квота-safe прогресс, независимый от продовой collection_queue)
CREATE TABLE IF NOT EXISTS wordstat.dynamics_range_queue (
    id SERIAL PRIMARY KEY,
    phrase TEXT NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dynamics_range_queue_status
    ON wordstat.dynamics_range_queue(status);

-- Результат: частотность по месяцам, фраза хранится как текст напрямую
-- (без FK на common.requests — это разовый список, не общий справочник для Topvisor-трекинга)
CREATE TABLE IF NOT EXISTS wordstat.dynamics_range (
    phrase TEXT NOT NULL,
    month DATE NOT NULL,
    frequency INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (phrase, month)
);

CREATE INDEX IF NOT EXISTS idx_dynamics_range_phrase
    ON wordstat.dynamics_range(phrase);

COMMENT ON TABLE wordstat.dynamics_range_queue IS 'Очередь фраз для разового сбора динамики за весь диапазон дат одним запросом';
COMMENT ON TABLE wordstat.dynamics_range IS 'Частотность по месяцам для фраз из dynamics_range_queue, диапазон дат задаётся в самом скрипте';
