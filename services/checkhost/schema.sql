-- services/checkhost/schema.sql
-- Результаты проверки доменов из l7.clients через Check-Host API (check-dns)
-- + обогащение геоданными (Location/AS/ISP-Org) через ip-api.com.
-- Одна строка на домен: при каждом прогоне запись перезаписывается (UPSERT
-- по domain), а не дописывается новой строкой — checkhost независим от
-- расписания/статуса domains-meta и всегда держит свежий снимок по домену.

CREATE SCHEMA IF NOT EXISTS l7;

CREATE TABLE IF NOT EXISTS l7.checkhost_scan (
    id              SERIAL PRIMARY KEY,
    client_id       BIGINT,
    domain          TEXT NOT NULL,
    checked_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    request_id      TEXT,
    resolved_ips    JSONB,
    ip              TEXT,
    country         TEXT,
    region          TEXT,
    city            TEXT,
    isp             TEXT,
    org             TEXT,
    as_number       TEXT,
    as_name         TEXT,
    dns_success     BOOLEAN NOT NULL DEFAULT false,
    geoip_success   BOOLEAN NOT NULL DEFAULT false,
    error_message   TEXT
);

COMMENT ON TABLE l7.checkhost_scan IS 'Снимок проверки доменов из l7.clients: IP резолвится через Check-Host API (check-dns), Location/AS/ISP-Org — через ip-api.com по резолвленному IP. Одна строка = один домен, перезаписывается (UPSERT по domain) при каждом прогоне.';
COMMENT ON COLUMN l7.checkhost_scan.checked_at IS 'Время последнего прогона, в котором обновлялась эта строка.';
COMMENT ON COLUMN l7.checkhost_scan.resolved_ips IS 'Все IP (A-записи), увиденные на разных нодах Check-Host, с частотой встречаемости — [{"ip":"1.2.3.4","count":2}, ...].';
COMMENT ON COLUMN l7.checkhost_scan.ip IS 'Каноничный IP — самый частый среди resolved_ips (при равенстве — первый увиденный).';
COMMENT ON COLUMN l7.checkhost_scan.as_number IS 'Номер автономной системы, например AS15169.';
COMMENT ON COLUMN l7.checkhost_scan.as_name IS 'Название организации автономной системы, например Google LLC.';
COMMENT ON COLUMN l7.checkhost_scan.dns_success IS 'true, если удалось резолвить хотя бы один IP через Check-Host.';
COMMENT ON COLUMN l7.checkhost_scan.geoip_success IS 'true, если ip-api.com вернул успешный ответ (status=success) по каноничному IP.';

-- Уникальный индекс по domain — опора для UPSERT (ON CONFLICT (domain)) и
-- гарантия «один домен — одна строка».
DROP INDEX IF EXISTS l7.idx_checkhost_scan_domain;
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkhost_scan_domain_unique ON l7.checkhost_scan(domain);
CREATE INDEX IF NOT EXISTS idx_checkhost_scan_checked_at ON l7.checkhost_scan(checked_at);
CREATE INDEX IF NOT EXISTS idx_checkhost_scan_ip ON l7.checkhost_scan(ip);
