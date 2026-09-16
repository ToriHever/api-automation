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
-- Операторы Wordstat (2026-09): 3 варианта соответствия на фразу.
--   broad         — без операторов, как раньше (по умолчанию для строк без
--                    match_type — обратная совместимость со старыми данными).
--   phrase        — "фраза" (точный состав и порядок слов, формы ещё варьируются)
--   phrase_exact  — "!слово1 !слово2" (точная фраза + фиксированная словоформа)
-- Добавляем колонку в обе таблицы (tmp_dynamics хранит результат, collection_queue —
-- очередь сбора) и меняем UNIQUE, чтобы под одну (request_id, month) /
-- (method, phrase, period, check_date) помещалось 3 строки — по одной на вариант.
--
-- Старые UNIQUE-констрейнты ищем ДИНАМИЧЕСКИ по набору колонок (через
-- pg_constraint/pg_attribute), а не по имени — оно сгенерировано Postgres
-- автоматически при создании таблицы и здесь неизвестно. Безопасно
-- перезапускать: если старый констрейнт уже снят (или его не было под
-- этим набором колонок), блок просто ничего не найдёт и ничего не сделает.
-- ============================================

ALTER TABLE wordstat.tmp_dynamics
    ADD COLUMN IF NOT EXISTS match_type VARCHAR(20) NOT NULL DEFAULT 'broad';

COMMENT ON COLUMN wordstat.tmp_dynamics.match_type IS 'Тип соответствия Wordstat: broad (без операторов), phrase ("фраза"), phrase_exact ("!слово1 !слово2" — точная фраза + словоформа).';

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT con.conname
        FROM pg_constraint con
        WHERE con.conrelid = 'wordstat.tmp_dynamics'::regclass
          AND con.contype = 'u'
          AND (
              SELECT array_agg(pa.attname ORDER BY pa.attname)
              FROM unnest(con.conkey) AS ck(attnum)
              JOIN pg_attribute pa
                ON pa.attrelid = con.conrelid AND pa.attnum = ck.attnum
          ) = ARRAY['month', 'request_id']
    LOOP
        EXECUTE format('ALTER TABLE wordstat.tmp_dynamics DROP CONSTRAINT %I', r.conname);
    END LOOP;
END $$;

ALTER TABLE wordstat.tmp_dynamics DROP CONSTRAINT IF EXISTS tmp_dynamics_request_month_match_key;
ALTER TABLE wordstat.tmp_dynamics
    ADD CONSTRAINT tmp_dynamics_request_month_match_key UNIQUE (request_id, month, match_type);

ALTER TABLE wordstat.collection_queue
    ADD COLUMN IF NOT EXISTS match_type VARCHAR(20) NOT NULL DEFAULT 'broad';

COMMENT ON COLUMN wordstat.collection_queue.match_type IS 'Тот же смысл, что и wordstat.tmp_dynamics.match_type. Для method=top всегда broad (у top операторы не применяются).';

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT con.conname
        FROM pg_constraint con
        WHERE con.conrelid = 'wordstat.collection_queue'::regclass
          AND con.contype = 'u'
          AND (
              SELECT array_agg(pa.attname ORDER BY pa.attname)
              FROM unnest(con.conkey) AS ck(attnum)
              JOIN pg_attribute pa
                ON pa.attrelid = con.conrelid AND pa.attnum = ck.attnum
          ) = ARRAY['check_date', 'method', 'period_end', 'period_start', 'phrase']
    LOOP
        EXECUTE format('ALTER TABLE wordstat.collection_queue DROP CONSTRAINT %I', r.conname);
    END LOOP;
END $$;

ALTER TABLE wordstat.collection_queue DROP CONSTRAINT IF EXISTS collection_queue_unique_with_match_type;
ALTER TABLE wordstat.collection_queue
    ADD CONSTRAINT collection_queue_unique_with_match_type
    UNIQUE (method, phrase, period_start, period_end, check_date, match_type);