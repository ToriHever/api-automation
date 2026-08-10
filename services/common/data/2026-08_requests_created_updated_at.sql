-- services/common/data/2026-08_requests_created_updated_at.sql
-- Разовая миграция: добавить created_at/updated_at в common.requests
-- (колонки отсутствовали, хотя topvisor/schema.sql их изначально заявлял —
-- реальная таблица на проде разошлась со схемой в репозитории).
--
-- Бэкфилл дат:
--   - все существующие строки, КРОМЕ списка ниже -> вчерашняя дата
--   - список ниже (новая партия, добавленная сегодня) -> сегодняшняя дата
--
-- Даты берутся динамически (CURRENT_DATE / CURRENT_DATE - 1) на момент
-- выполнения скрипта, не захардкожены.
--
-- Дальше: DEFAULT CURRENT_TIMESTAMP на обе колонки для новых строк + триггер,
-- который сам проставляет updated_at при любом UPDATE строки (в т.ч. когда
-- категоризатор проставляет hub_id/cluster_id/topic_id).
--
-- Безопасно перезапускать.

BEGIN;

-- 1. Колонки (если ещё не добавлены)
ALTER TABLE common.requests ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
ALTER TABLE common.requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- 2. Бэкфилл: всё — вчерашней датой
UPDATE common.requests
SET created_at = COALESCE(created_at, (CURRENT_DATE - 1)::timestamp),
    updated_at = COALESCE(updated_at, (CURRENT_DATE - 1)::timestamp);

-- 3. Исключение — эта партия помечается сегодняшней датой
UPDATE common.requests
SET created_at = CURRENT_DATE::timestamp,
    updated_at = CURRENT_DATE::timestamp
WHERE request IN (
    'сколько стоит ддос ez',
    'сколько стоит ддос ez москва',
    'ddos услуги ez',
    'сервера с защитой от ddos',
    'сервер с ddos защитой',
    'купить ддос',
    'сервер с ддос защитой',
    'заказать ddos',
    'заказать ддос атаку ez',
    'ddos купить',
    'ддос на сервер',
    'ddos server',
    'ддос атака купить',
    'ддос для серверов',
    'ddos сервис ez москва',
    'ддос услуги ez москва',
    'ддос купить',
    'серверы с защитой от ddos',
    'ddos dedicated server',
    'ddos сервис ez',
    'ддос атака заказать',
    'ddos attack buy',
    'ddos атака заказать',
    'ddos windows server',
    'dos server'
);

-- 4. DEFAULT для новых строк, которые появятся дальше (обычные INSERT/импорты)
ALTER TABLE common.requests ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE common.requests ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;

-- 5. Триггер: updated_at сам обновляется при любом UPDATE строки (в т.ч. когда
-- категоризатор проставляет hub_id/cluster_id/topic_id) — по тому же паттерну,
-- что уже используется в services/wordstat/schema.sql.
CREATE OR REPLACE FUNCTION common.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_requests_updated_at ON common.requests;

CREATE TRIGGER update_requests_updated_at
    BEFORE UPDATE ON common.requests
    FOR EACH ROW
    EXECUTE FUNCTION common.update_updated_at_column();

COMMIT;
