-- services/google-updates/schema.sql
-- Апдейты алгоритмов Google (Search Status Dashboard) → таблица + события в ленту
-- Telegram-бота (common.notes, см. services/notes/schema.sql).

CREATE SCHEMA IF NOT EXISTS common;

CREATE TABLE IF NOT EXISTS common.google_updates (
    id             SERIAL PRIMARY KEY,
    incident_id    TEXT NOT NULL UNIQUE,
    title          TEXT NOT NULL,
    update_type    TEXT NOT NULL,
    service_name   TEXT,
    severity       TEXT,
    status_impact  TEXT,
    begin_at       TIMESTAMPTZ NOT NULL,
    end_at         TIMESTAMPTZ,
    begin_date     DATE NOT NULL,
    end_date       DATE,
    modified_at    TIMESTAMPTZ,
    description    TEXT,
    url            TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_google_updates_begin_date ON common.google_updates(begin_date);

COMMENT ON TABLE common.google_updates IS 'Апдейты алгоритмов Google из Search Status Dashboard (incidents.json). Одна строка на инцидент; end_at пуст, пока раскатка идёт.';
COMMENT ON COLUMN common.google_updates.incident_id IS 'id инцидента в Search Status Dashboard — естественный ключ.';
COMMENT ON COLUMN common.google_updates.update_type IS 'core | spam | discover | helpful_content | reviews | other — определяется по названию.';
COMMENT ON COLUMN common.google_updates.begin_date IS 'Дата начала раскатки в таймзоне сервиса (Europe/Moscow), для join с gsc.search_console.event_date.';

-- Категория для common.notes_categories. Таблицу создаёт services/notes/schema.sql;
-- если её ещё нет, пропускаем вставку (иначе упала бы вся схема), коллектор потом
-- сам сообщит, что категории нет.
DO $$
BEGIN
    IF to_regclass('common.notes_categories') IS NOT NULL THEN
        INSERT INTO common.notes_categories (category_name, icon)
        VALUES ('Google Updates', '🔄')
        ON CONFLICT (category_name) DO NOTHING;
    END IF;
END $$;
