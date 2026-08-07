-- services/notes/schema.sql
-- Заметки о внешних событиях (апдейты алгоритмов Google/Яндекс и т.п.),
-- вносятся через Telegram-бота (scripts/notes-bot.js), читаются в DataLens
-- как таблица событий (common.v_notes).

CREATE SCHEMA IF NOT EXISTS common;

CREATE TABLE IF NOT EXISTS common.notes_categories (
    category_id   SERIAL PRIMARY KEY,
    category_name TEXT NOT NULL UNIQUE,
    icon          TEXT
);

COMMENT ON TABLE common.notes_categories IS 'Фиксированный справочник категорий заметок (показывается кнопками в Telegram-боте при создании заметки).';

INSERT INTO common.notes_categories (category_name, icon) VALUES
    ('Сайт', NULL),
    ('Рассылки', NULL),
    ('Реклама', NULL),
    ('ЯБизнес', NULL),
    ('GMaps', NULL),
    ('Google', '🔍'),
    ('Яндекс', '🟡'),
    ('Блог', NULL),
    ('Продуктовые', NULL)
ON CONFLICT (category_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS common.notes (
    id           SERIAL PRIMARY KEY,
    title        TEXT NOT NULL,
    description  TEXT,
    event_date   DATE NOT NULL,
    category_id  INTEGER NOT NULL REFERENCES common.notes_categories(category_id),
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by   TEXT
);

COMMENT ON TABLE common.notes IS 'Заметки о внешних событиях (апдейты алгоритмов поисковиков и т.п.), вносятся через Telegram-бота.';
COMMENT ON COLUMN common.notes.created_by IS 'Telegram chat_id отправителя — для отладки, не для авторизации (авторизация — по TELEGRAM_CHAT_ID в самом боте).';

CREATE INDEX IF NOT EXISTS idx_notes_event_date ON common.notes(event_date);
CREATE INDEX IF NOT EXISTS idx_notes_category ON common.notes(category_id);

-- Источник для DataLens-таблицы "Заметки" (название/описание/дата/категория+иконка)
CREATE OR REPLACE VIEW common.v_notes AS
SELECT
    n.id,
    n.title,
    n.description,
    n.event_date,
    nc.category_name,
    nc.icon,
    n.created_at
FROM common.notes n
JOIN common.notes_categories nc ON nc.category_id = n.category_id
ORDER BY n.event_date DESC;

COMMENT ON VIEW common.v_notes IS 'Заметки с развёрнутым названием категории — источник данных для таблицы "Заметки" в DataLens.';
