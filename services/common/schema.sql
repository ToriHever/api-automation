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
