-- services/wordstat/migrations/2026-07_dynamics_range_add_request_id.sql
-- Миграция wordstat.dynamics_range: phrase (TEXT) -> request_id (INTEGER, FK common.requests)
-- БЕЗ потери уже собранных данных. Выполнять по шагам, проверяя вывод между ними.

-- ============================================================
-- ШАГ 1. Добавить новую колонку (nullable, ничего не ломает)
-- ============================================================
ALTER TABLE wordstat.dynamics_range ADD COLUMN IF NOT EXISTS request_id INTEGER;

-- ============================================================
-- ШАГ 2. Замаппить по точному совпадению текста фразы
-- ============================================================
UPDATE wordstat.dynamics_range d
SET request_id = r.request_id
FROM common.requests r
WHERE r.request = d.phrase
  AND d.request_id IS NULL;

-- ============================================================
-- ШАГ 3. ПРОВЕРКА — какие фразы не замапились (обязательно посмотреть перед шагом 4!)
-- ============================================================
SELECT DISTINCT phrase
FROM wordstat.dynamics_range
WHERE request_id IS NULL
ORDER BY phrase;

-- Если список НЕ пустой — сначала добавь эти фразы в common.requests, например:
--   INSERT INTO common.requests (request) VALUES ('фраза 1'), ('фраза 2')
--   ON CONFLICT (request) DO NOTHING;
-- и повтори ШАГ 2 (он безопасно перезапускаемый — трогает только request_id IS NULL).
-- Только когда ШАГ 3 вернёт 0 строк — переходи к шагу 4.

-- ============================================================
-- ШАГ 4. ПРОВЕРКА — нет ли коллизий (два разных phrase замаппились на один request_id+month)
-- ============================================================
SELECT request_id, month, COUNT(*)
FROM wordstat.dynamics_range
GROUP BY request_id, month
HAVING COUNT(*) > 1;

-- Если что-то вернулось — покажи мне, разберём вручную какую строку оставить
-- (обычно это просто два варианта написания одной фразы, слитых в один request_id).

-- ============================================================
-- ШАГ 5. Финализация — только после того как шаги 3 и 4 пустые
-- ============================================================
ALTER TABLE wordstat.dynamics_range ALTER COLUMN request_id SET NOT NULL;

ALTER TABLE wordstat.dynamics_range
    ADD CONSTRAINT fk_dynamics_range_request
    FOREIGN KEY (request_id) REFERENCES common.requests(request_id);

ALTER TABLE wordstat.dynamics_range DROP CONSTRAINT IF EXISTS dynamics_range_pkey;
ALTER TABLE wordstat.dynamics_range DROP COLUMN phrase;
ALTER TABLE wordstat.dynamics_range ADD PRIMARY KEY (request_id, month);

CREATE INDEX IF NOT EXISTS idx_dynamics_range_request
    ON wordstat.dynamics_range(request_id);

-- Готово: структура таблицы теперь совпадает с services/wordstat/dynamics_range_schema.sql
