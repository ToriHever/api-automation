-- services/common/data/2026-08_recategorize_waf.sql
-- Разовая переразметка: сбросить cluster_id и topic_id для всех запросов с
-- хабом 'WAF' (там накопилось много ошибочных категорий/тем), чтобы
-- существующий категоризатор (services/common/data/2026-08_categorize_requests.sql)
-- пересчитал их заново по той же логике — он трогает только NULL, поэтому
-- обычный повторный прогон сам по себе ничего бы не поправил.
--
-- hub_id НЕ трогаем — сбрасываются только cluster_id/topic_id, хаб остаётся 'WAF'.
--
-- Порядок применения:
--   1. Выполнить этот файл (сброс).
--   2. Выполнить services/common/data/2026-08_categorize_requests.sql (пересчёт).

BEGIN;

UPDATE common.requests
SET cluster_id = NULL,
    topic_id = NULL
WHERE hub_id = (SELECT hub_id FROM common.hubs WHERE hub_name = 'WAF');

COMMIT;
