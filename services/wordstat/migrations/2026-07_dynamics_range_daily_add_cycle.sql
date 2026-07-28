-- services/wordstat/migrations/2026-07_dynamics_range_daily_add_cycle.sql
-- Превращает wordstat.dynamics_range_daily_queue из разовой очереди (UNIQUE(phrase),
-- фраза, дошедшая до 'done', никогда больше не берётся в обработку) в циклическую —
-- нужно для автоматического ежемесячного сбора (PERIOD_DAILY хранит только 60 дней,
-- без периодического дообора старые дни просто теряются).
--
-- Существующим строкам (из ручного разового прогона) проставляем cycle_start
-- задним числом по created_at — они не мешают новым циклам благодаря
-- составному UNIQUE(phrase, cycle_start).

ALTER TABLE wordstat.dynamics_range_daily_queue ADD COLUMN IF NOT EXISTS cycle_start DATE;

UPDATE wordstat.dynamics_range_daily_queue
SET cycle_start = date_trunc('month', created_at)::date
WHERE cycle_start IS NULL;

ALTER TABLE wordstat.dynamics_range_daily_queue ALTER COLUMN cycle_start SET NOT NULL;

ALTER TABLE wordstat.dynamics_range_daily_queue DROP CONSTRAINT IF EXISTS dynamics_range_daily_queue_phrase_key;
ALTER TABLE wordstat.dynamics_range_daily_queue
    ADD CONSTRAINT dynamics_range_daily_queue_phrase_cycle_key UNIQUE (phrase, cycle_start);

CREATE INDEX IF NOT EXISTS idx_dynamics_range_daily_queue_cycle
    ON wordstat.dynamics_range_daily_queue(cycle_start);

-- Готово: структура теперь совпадает с services/wordstat/dynamics_range_schema.sql
