-- services/common/data/2026-09_rollback_wordstat_match_type.sql
-- ОДНОРАЗОВЫЙ откат. Применить один раз на сервере (уже применена миграция
-- match_type из services/wordstat/schema.sql, добавленная под операторы
-- Wordstat — выяснилось, что "фраза"/!слово работают только с
-- PERIOD_DAILY, а wordstat.tmp_dynamics собирается по PERIOD_MONTHLY, так
-- что операторы там гарантированно возвращают "Invalid query" от API.
-- Фича отменена, эта миграция возвращает схему к состоянию до неё.
--
-- Безопасно перезапускать: DROP CONSTRAINT/COLUMN — IF EXISTS, ADD CONSTRAINT
-- обёрнут проверкой на существование по набору колонок.
--
-- Запуск: psql "$DATABASE_URL" -f services/common/data/2026-09_rollback_wordstat_match_type.sql

ALTER TABLE wordstat.tmp_dynamics DROP CONSTRAINT IF EXISTS tmp_dynamics_request_month_match_key;
ALTER TABLE wordstat.tmp_dynamics DROP COLUMN IF EXISTS match_type;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint con
        WHERE con.conrelid = 'wordstat.tmp_dynamics'::regclass
          AND con.contype = 'u'
          AND (
              SELECT array_agg(pa.attname::text ORDER BY pa.attname)
              FROM unnest(con.conkey) AS ck(attnum)
              JOIN pg_attribute pa ON pa.attrelid = con.conrelid AND pa.attnum = ck.attnum
          ) = ARRAY['month', 'request_id']
    ) THEN
        ALTER TABLE wordstat.tmp_dynamics ADD CONSTRAINT tmp_dynamics_request_id_month_key UNIQUE (request_id, month);
    END IF;
END $$;

ALTER TABLE wordstat.collection_queue DROP CONSTRAINT IF EXISTS collection_queue_unique_with_match_type;
ALTER TABLE wordstat.collection_queue DROP COLUMN IF EXISTS match_type;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint con
        WHERE con.conrelid = 'wordstat.collection_queue'::regclass
          AND con.contype = 'u'
          AND (
              SELECT array_agg(pa.attname::text ORDER BY pa.attname)
              FROM unnest(con.conkey) AS ck(attnum)
              JOIN pg_attribute pa ON pa.attrelid = con.conrelid AND pa.attnum = ck.attnum
          ) = ARRAY['check_date', 'method', 'period_end', 'period_start', 'phrase']
    ) THEN
        ALTER TABLE wordstat.collection_queue
            ADD CONSTRAINT collection_queue_method_phrase_period_start_period_end_check_date_key
            UNIQUE (method, phrase, period_start, period_end, check_date);
    END IF;
END $$;

-- Тестовые данные из ручного прогона (WORDSTAT_BACKFILL_MONTH=2020-01),
-- если ещё не удалены:
DELETE FROM wordstat.tmp_dynamics WHERE month = '2020-01-01';
DELETE FROM wordstat.collection_queue WHERE method = 'dynamics' AND period_start = '2020-01-01';
