-- services/common/data/2026-09_widen_requests_id_seq.sql
-- common.requests.request_id был smallint (максимум 32767) вместе с бэкающей
-- его последовательностью requests_id_seq1 — упёрлись в лимит при первом
-- запуске scripts/sync-gsc-requests.js (2026-09-30). Все таблицы, ссылающиеся
-- на request_id по FK (common.requests_words, wordstat.dynamics_range*,
-- lemmatizer.*, topvisor.positions), уже используют integer — расширение
-- просто приводит PK в соответствие с тем, что остальная схема и так ждала.
--
-- Применить: psql "$DATABASE_URL" -f services/common/data/2026-09_widen_requests_id_seq.sql

BEGIN;

ALTER TABLE common.requests
    ALTER COLUMN request_id TYPE integer;

ALTER SEQUENCE common.requests_id_seq1
    AS integer
    MAXVALUE 2147483647;

COMMIT;
