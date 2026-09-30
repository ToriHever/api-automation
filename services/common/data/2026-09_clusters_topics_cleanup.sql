-- services/common/data/2026-09_clusters_topics_cleanup.sql
-- Чистка справочников кластеров и тем от старой таксономии.
--
-- Кластеры 1–14 и 16 — это бывшие «хабы» (Сети, Кибербезопасность, Информационная
-- безопасность, DS / Дедик / Выделенный, Киберугрозы, Web-технологии, VPS/VDS,
-- Хостинг, Уязвимости, DNS, Сайт, DDoS, Бренд, Бренд Конкурент) и 'Конкретный тип
-- атаки'. Кластер — это интент (Что/Как/Цены/Защита...), а не тема, поэтому такие
-- значения удаляются, а строки пересчитываются категоризатором.
-- Тема 'удалить' — старая рабочая пометка (VBA), тоже удаляется.
--
-- Что происходит со строками:
--   1. Старое значение сохраняется в common.requests_category_legacy
--      (request_id, kind = 'cluster'/'topic', old_id, old_name) — на случай, если
--      пометки понадобятся.
--   2. cluster_id / topic_id у этих строк становится NULL; следующий прогон
--      категоризатора (npm run categorize) назначит новые значения.
--
-- Порядок запуска: СНАЧАЛА этот файл, ПОТОМ npm run categorize.
-- Идемпотентно. Не перезапускать импорты семантического ядра после чистки.
--
-- Кластеры 15 'Балансировка' и 17 'Тест' НЕ трогаем (используются).

BEGIN;

CREATE TABLE IF NOT EXISTS common.requests_category_legacy (
    request_id  INTEGER NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('cluster', 'topic')),
    old_id      INTEGER NOT NULL,
    old_name    TEXT NOT NULL,
    archived_at TIMESTAMP NOT NULL DEFAULT now(),
    PRIMARY KEY (request_id, kind)
);

COMMENT ON TABLE common.requests_category_legacy IS 'Снимок старых значений cluster/topic, удалённых в 2026-09 (бывшие хабы в кластерах 1–14/16, тема ''удалить''). Только для справки, ничего не читает.';

-- Кластеры: только совпадение И id, И имени — чтобы не удалить не то при расхождении.
CREATE TEMP TABLE _legacy_clusters ON COMMIT DROP AS
SELECT cluster_id, cluster_name FROM common.clusters
WHERE (cluster_id, cluster_name) IN (
    (1, 'Сети'), (2, 'Кибербезопасность'), (3, 'Информационная безопасность'),
    (4, 'DS / Дедик / Выделенный'), (5, 'Киберугрозы'), (6, 'Web-технологии'),
    (7, 'VPS/VDS'), (8, 'Хостинг'), (9, 'Уязвимости'), (10, 'DNS'), (11, 'Сайт'),
    (12, 'DDoS'), (13, 'Бренд'), (14, 'Бренд Конкурент'), (16, 'Конкретный тип атаки')
);

INSERT INTO common.requests_category_legacy (request_id, kind, old_id, old_name)
SELECT r.request_id, 'cluster', c.cluster_id, c.cluster_name
FROM common.requests r
JOIN _legacy_clusters c ON c.cluster_id = r.cluster_id
ON CONFLICT (request_id, kind) DO NOTHING;

UPDATE common.requests SET cluster_id = NULL
WHERE cluster_id IN (SELECT cluster_id FROM _legacy_clusters);

DELETE FROM common.clusters
WHERE cluster_id IN (SELECT cluster_id FROM _legacy_clusters);

-- Тема 'удалить'
INSERT INTO common.requests_category_legacy (request_id, kind, old_id, old_name)
SELECT r.request_id, 'topic', t.topic_id, t.topic_name
FROM common.requests r
JOIN common.topics t ON t.topic_id = r.topic_id
WHERE t.topic_name = 'удалить'
ON CONFLICT (request_id, kind) DO NOTHING;

UPDATE common.requests SET topic_id = NULL
WHERE topic_id IN (SELECT topic_id FROM common.topics WHERE topic_name = 'удалить');

DELETE FROM common.topics WHERE topic_name = 'удалить';

COMMIT;
