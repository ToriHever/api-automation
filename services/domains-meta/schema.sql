-- services/domains-meta/schema.sql
-- Результаты сбора мета-информации по доменам из l7.clients.
-- Аппенд-лог: каждый прогон дописывает новые строки (по одной на домен),
-- существующие строки не обновляются.

CREATE SCHEMA IF NOT EXISTS l7;

CREATE TABLE IF NOT EXISTS l7.domains_meta_scan (
    id              SERIAL PRIMARY KEY,
    client_id       BIGINT REFERENCES l7.clients(id),
    domain          TEXT NOT NULL,
    scanned_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status_code     INTEGER,
    had_redirect    BOOLEAN NOT NULL DEFAULT false,
    redirect_status TEXT,
    final_url       TEXT,
    title           TEXT,
    description     TEXT,
    keywords        TEXT,
    h1              TEXT,
    og_title        TEXT,
    og_image        TEXT,
    canonical       TEXT,
    robots          TEXT,
    viewport        TEXT,
    charset         TEXT,
    is_captcha      BOOLEAN NOT NULL DEFAULT false,
    success         BOOLEAN NOT NULL DEFAULT false,
    error_message   TEXT
);

COMMENT ON TABLE l7.domains_meta_scan IS 'Лог сбора мета-информации (title/description/keywords/h1 и т.д.) по доменам из l7.clients через Puppeteer. Одна строка = один домен за один прогон скрипта.';
COMMENT ON COLUMN l7.domains_meta_scan.is_captcha IS 'true, если капча/блокировка не снялась после повторного захода — title/description и т.д. в этом случае пустые.';

CREATE INDEX IF NOT EXISTS idx_domains_meta_scan_domain ON l7.domains_meta_scan(domain);
CREATE INDEX IF NOT EXISTS idx_domains_meta_scan_scanned_at ON l7.domains_meta_scan(scanned_at);
CREATE INDEX IF NOT EXISTS idx_domains_meta_scan_captcha ON l7.domains_meta_scan(is_captcha) WHERE is_captcha;
