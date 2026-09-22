-- services/google-alerts/schema.sql
-- Google Alerts (RSS) → сырая таблица упоминаний + запись в ленту событий
-- Telegram-бота (common.notes, см. services/notes/schema.sql).

CREATE SCHEMA IF NOT EXISTS common;

CREATE TABLE IF NOT EXISTS common.google_alerts (
    id            SERIAL PRIMARY KEY,
    entry_id      TEXT NOT NULL UNIQUE,
    alert_name    TEXT NOT NULL,
    published_at  TIMESTAMPTZ NOT NULL,
    event_date    DATE NOT NULL,
    domain        TEXT NOT NULL,
    url           TEXT NOT NULL,
    title         TEXT,
    snippet       TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Отдельный UNIQUE на url (не только на entry_id) — одна и та же статья не
-- должна попадать дважды, даже если её поймали два разных алерта с разными
-- entry_id. GoogleAlertsCollector.recordExists() проверяет оба поля перед
-- INSERT, так что на практике конфликт по этому индексу не должен всплывать,
-- но он остаётся последней линией защиты от дублей.
CREATE UNIQUE INDEX IF NOT EXISTS google_alerts_url_uq ON common.google_alerts (url);

CREATE INDEX IF NOT EXISTS idx_google_alerts_event_date ON common.google_alerts(event_date);
CREATE INDEX IF NOT EXISTS idx_google_alerts_domain ON common.google_alerts(domain);

COMMENT ON TABLE common.google_alerts IS 'Сырые упоминания из RSS-фидов Google Alerts (по одной строке на статью/страницу).';
COMMENT ON COLUMN common.google_alerts.entry_id IS 'id/guid элемента RSS-фида (или url, если фид его не отдаёт) — естественный ключ дедупликации в рамках одного алерта.';
COMMENT ON COLUMN common.google_alerts.alert_name IS 'Имя алерта из GOOGLE_ALERTS_FEEDS (например "Упоминание DDoS") — человекочитаемый источник, не FK.';

-- Категория для common.notes_categories (см. services/notes/schema.sql) —
-- под неё пишутся все упоминания из Google Alerts в ленту событий бота.
-- Предполагает, что services/notes/schema.sql уже применён (таблица
-- common.notes_categories существует) — этот файл её не создаёт, только
-- добавляет строку. Если notes-бот ещё не разворачивали — примени сначала
-- services/notes/schema.sql.
INSERT INTO common.notes_categories (category_name, icon) VALUES
    ('Google Alerts', '📡')
ON CONFLICT (category_name) DO NOTHING;
