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
-- common.products — ручная группировка URL для дашбордов
-- ============================================================
-- Уже существует в БД, здесь только задокументирована (IF NOT EXISTS — no-op на проде).
--
-- Заполняется и поддерживается ВРУЧНУЮ — ни один скрипт в этом репозитории её
-- не читает и не пишет. Задаёт человекочитаемые группы URL ("продукты") для
-- фильтрации на дашбордах.
--
-- ВАЖНО: несмотря на отсутствие автоматизации, таблица активно используется —
-- на неё завязаны view в схеме analytics (сама схема analytics в этом
-- репозитории пока не описана, живёт только на сервере):
--   analytics.v_gsc_monthly        JOIN common.products p ON p.url_id = target_url
--   analytics.v_gsc_yearly         JOIN common.products p ON p.url_id = target_url
--   analytics.v_gsc_requests_daily JOIN common.products p ON p.url_id = target_url
-- (v_gsc_requests_agg / v_gsc_requests_brand / v_gsc_requests_brand_agg зависят
-- от неё косвенно, через v_gsc_requests_daily).
--
-- При миграции site_map (30.03.2026, см. old_table_mar_db/README.md) url_id в
-- этой таблице был сознательно перемаппирован вместе с остальными зависимыми
-- таблицами — то есть она признана важной, не мусор и не забытый черновик.
CREATE TABLE IF NOT EXISTS common.products (
    id SMALLSERIAL PRIMARY KEY,
    url_id SMALLINT NOT NULL REFERENCES common.site_map(id),
    product_name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_url_id
    ON common.products(url_id);

COMMENT ON TABLE common.products IS 'Ручная группировка URL по продуктам для фильтрации на дашбордах. Заполняется вручную, используется view в схеме analytics (v_gsc_monthly, v_gsc_yearly, v_gsc_requests_daily и производные)';
