-- services/common/data/2026-09_hubs_cleanup.sql
-- Чистка справочника common.hubs: удаляем старые «зачатки» хабов, которые не
-- были тематическими, и переименовываем слишком общий хаб 'Атака'.
--
-- Удаляются (решение владельца семантики):
--   'Блог'            — раньше метка «запрос пойдёт на блог»; теперь определяется
--                       типом запроса (инфо / коммерч. и т.д.), а не хабом.
--   'Пикабу'          — метка запросов, которые забирает внешняя площадка.
--   'EN key'          — метка ключей англоязычного сайта.
--   'БЗ: Технологии', 'БЗ: Инструкции', 'БЗ: Термины'
--                     — метки запросов, которые «сидят» в базе знаний.
-- Переименование:
--   'Атака' -> 'Атаки (общее)': сюда попадают разновидности ddos без прямого
--   упоминания ddos/атаки и атаки других типов.
--
-- Что происходит с запросами из удалённых хабов:
--   1. Перед удалением их старый хаб сохраняется в common.requests_hub_legacy
--      (request_id, hub_id, hub_name) — чтобы метки «блог/пикабу/БЗ/EN» не пропали.
--   2. hub_id у этих запросов становится NULL, и следующий прогон категоризатора
--      (npm run categorize) назначит им хаб по ключевым словам.
--
-- Порядок запуска: СНАЧАЛА этот файл, ПОТОМ npm run categorize.
-- Идемпотентно: повторный запуск ничего не ломает (снимок — ON CONFLICT DO
-- NOTHING, удаление/переименование — по имени).
--
-- Не перезапускать импорты семантического ядра (2026-07_semantic_core_import.sql,
-- 2026-08_semantic_core_import_v2.sql) после чистки: они создают отсутствующие хабы
-- по имени и могут вернуть удалённые.

BEGIN;

CREATE TABLE IF NOT EXISTS common.requests_hub_legacy (
    request_id  INTEGER PRIMARY KEY,
    hub_id      INTEGER NOT NULL,
    hub_name    TEXT NOT NULL,
    archived_at TIMESTAMP NOT NULL DEFAULT now()
);

COMMENT ON TABLE common.requests_hub_legacy IS 'Снимок старых хабов (Блог/Пикабу/EN key/БЗ:*), удалённых из common.hubs в 2026-09. Только для справки, ничего не читает.';

INSERT INTO common.requests_hub_legacy (request_id, hub_id, hub_name)
SELECT r.request_id, h.hub_id, h.hub_name
FROM common.requests r
JOIN common.hubs h ON h.hub_id = r.hub_id
WHERE h.hub_name IN ('Блог', 'Пикабу', 'EN key', 'БЗ: Технологии', 'БЗ: Инструкции', 'БЗ: Термины')
ON CONFLICT (request_id) DO NOTHING;

UPDATE common.requests SET hub_id = NULL
WHERE hub_id IN (
    SELECT hub_id FROM common.hubs
    WHERE hub_name IN ('Блог', 'Пикабу', 'EN key', 'БЗ: Технологии', 'БЗ: Инструкции', 'БЗ: Термины')
);

DELETE FROM common.hubs
WHERE hub_name IN ('Блог', 'Пикабу', 'EN key', 'БЗ: Технологии', 'БЗ: Инструкции', 'БЗ: Термины');

UPDATE common.hubs SET hub_name = 'Атаки (общее)'
WHERE hub_name = 'Атака'
  AND NOT EXISTS (SELECT 1 FROM common.hubs WHERE hub_name = 'Атаки (общее)');

COMMIT;
