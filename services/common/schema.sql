-- services/common/schema.sql
-- Таблица-связка запрос <-> URL (многие-ко-многим).
-- common.requests и common.site_map уже существуют (см. services/topvisor/schema.sql,
-- services/gsc/schema.sql) — этот файл только добавляет связь между ними, ничего не меняет
-- в них самих.

CREATE SCHEMA IF NOT EXISTS common;

CREATE TABLE IF NOT EXISTS common.request_urls (
    request_id INTEGER NOT NULL REFERENCES common.requests(request_id),
    site_map_id INTEGER NOT NULL REFERENCES common.site_map(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (request_id, site_map_id)
);

CREATE INDEX IF NOT EXISTS idx_request_urls_site_map
    ON common.request_urls(site_map_id);

COMMENT ON TABLE common.request_urls IS 'Связь запрос <-> URL, многие-ко-многим (один запрос может относиться к нескольким страницам)';

-- ============================================================
-- common.products — ⚠️ УСТАРЕВШАЯ, НЕ ИСПОЛЬЗУЕТСЯ (см. ниже)
-- ============================================================
-- ИСПРАВЛЕНО (2026-09): предыдущая версия этого комментария (закоммичена по
-- ошибке — таблица была найдена в незакоммиченных правках без понимания, что
-- это) утверждала, что таблицу активно использует analytics.v_gsc_*. Это
-- было верно только в прошлом. По факту, судя по services/analytics/schema.sql
-- (коммит 99d5407 "analytics: убрать product_name/common.products"):
--   таблица дропнута из v_gsc_monthly/v_gsc_yearly/v_gsc_requests_daily —
--   содержала ДУБЛИ по url_id, искажавшие цифры. Эти view сейчас группируются
--   через TopVisor (project_name/cluster_topvisor_name из topvisor.dim_keywords/
--   dim_groups), не через common.products.
--
-- Таблица (и, возможно, данные в ней) физически может ещё существовать в БД,
-- но ни один текущий скрипт или view её не читает. Не использовать как
-- источник группировки для новых чартов — если нужна группировка URL/запросов
-- без привязки к TopVisor, смотри common.requests.hub_id -> common.hubs
-- (хабы вроде 'DDoS'/'Хостинг'/'VDS'/'WAF' — активно поддерживаются, см.
-- services/common/data/2026-08_categorize_requests.sql) — так сделано в
-- analytics.v_serp_results (services/analytics/schema.sql).
CREATE TABLE IF NOT EXISTS common.products (
    id SMALLSERIAL PRIMARY KEY,
    url_id SMALLINT NOT NULL REFERENCES common.site_map(id),
    product_name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_url_id
    ON common.products(url_id);

COMMENT ON TABLE common.products IS 'УСТАРЕВШАЯ. Раньше ручная группировка URL по продуктам для v_gsc_*, дропнута из-за дублей по url_id (см. комментарий выше и services/analytics/schema.sql). Ничего в репозитории её больше не читает.';
