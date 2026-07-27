-- services/yandex-serp/schema.sql
-- Полная выдача Yandex Search API (v2) по частотным запросам —
-- в отличие от topvisor.positions хранит не только нашу позицию,
-- а весь ТОП-N выдачи (конкуренты тоже).

CREATE SCHEMA IF NOT EXISTS yandex;

CREATE TABLE IF NOT EXISTS yandex.serp_results (
    id                      SERIAL PRIMARY KEY,
    event_date              DATE NOT NULL,
    request                 TEXT NOT NULL,
    search_type             TEXT NOT NULL DEFAULT 'SEARCH_TYPE_RU',
    overall_position        INTEGER NOT NULL,
    group_position          INTEGER,
    doc_position_in_group   INTEGER,
    domain                  TEXT,
    url                     TEXT NOT NULL,
    title                   TEXT,
    snippet                 TEXT,
    target_url_id           INTEGER REFERENCES common.site_map(id),
    is_own_domain           BOOLEAN NOT NULL DEFAULT false,
    created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (event_date, request, search_type, url)
);

COMMENT ON TABLE yandex.serp_results IS 'Полная выдача Yandex Search API (v2, TOP-N) по частотным запросам из topvisor.dim_keywords/services/yandex-serp/keywords. Одна строка = один документ в выдаче за день.';
COMMENT ON COLUMN yandex.serp_results.request IS 'Текст поискового запроса (совпадает с topvisor.dim_keywords.name для джойна)';
COMMENT ON COLUMN yandex.serp_results.overall_position IS 'Сквозная позиция документа в выдаче (1, 2, 3…)';
COMMENT ON COLUMN yandex.serp_results.group_position IS 'Позиция домена-группы на странице (GROUP_MODE_DEEP)';
COMMENT ON COLUMN yandex.serp_results.doc_position_in_group IS 'Позиция документа внутри группы домена';
COMMENT ON COLUMN yandex.serp_results.is_own_domain IS 'true, если домен входит в config.json → ownDomains';
COMMENT ON COLUMN yandex.serp_results.target_url_id IS 'id страницы из common.site_map, если url удалось сматчить с уже известной нормализованной страницей';

CREATE INDEX IF NOT EXISTS idx_serp_results_date_request ON yandex.serp_results(event_date, request);
CREATE INDEX IF NOT EXISTS idx_serp_results_own_domain ON yandex.serp_results(is_own_domain) WHERE is_own_domain;
CREATE INDEX IF NOT EXISTS idx_serp_results_domain ON yandex.serp_results(domain);
