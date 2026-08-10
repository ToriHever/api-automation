-- services/lemmatizer/schema.sql
-- Справочник слов + лемм для common.requests.
-- Слово хранится один раз (уникально), рядом — его лемма (нормальная форма,
-- посчитанная через services/lemmatizer/app.py на pymorphy3).
-- Связь запрос <-> слово — многие-ко-многим (в одном запросе несколько слов,
-- одно слово встречается во многих запросах), поэтому отдельная связующая таблица.
--
-- Наполняется/обновляется скриптом scripts/lemmatize-requests.js.
-- Безопасно перезапускать.

CREATE SCHEMA IF NOT EXISTS common;

CREATE TABLE IF NOT EXISTS common.request_words (
    word_id SERIAL PRIMARY KEY,
    word    TEXT NOT NULL UNIQUE,
    lemma   TEXT NOT NULL
);

COMMENT ON TABLE common.request_words IS 'Справочник уникальных слов из common.requests и их лемм (нормальных форм), считается pymorphy3.';
COMMENT ON COLUMN common.request_words.word IS 'Слово в исходном виде (как встретилось в запросе, в нижнем регистре).';
COMMENT ON COLUMN common.request_words.lemma IS 'Лемма (нормальная форма) слова.';

CREATE INDEX IF NOT EXISTS idx_request_words_lemma ON common.request_words(lemma);

CREATE TABLE IF NOT EXISTS common.requests_words (
    request_id INTEGER NOT NULL REFERENCES common.requests(request_id) ON DELETE CASCADE,
    word_id    INTEGER NOT NULL REFERENCES common.request_words(word_id) ON DELETE CASCADE,
    PRIMARY KEY (request_id, word_id)
);

COMMENT ON TABLE common.requests_words IS 'Связь запрос -> слова, из которых он состоит (для поиска/группировки запросов по леммам).';

CREATE INDEX IF NOT EXISTS idx_requests_words_word ON common.requests_words(word_id);

-- Удобная вью: запрос + его леммы одной строкой через пробел (для DataLens/отчётов)
CREATE OR REPLACE VIEW common.v_requests_lemmatized AS
SELECT
    r.request_id,
    r.request,
    string_agg(DISTINCT rw.lemma, ' ' ORDER BY rw.lemma) AS lemmas
FROM common.requests r
JOIN common.requests_words rwds ON rwds.request_id = r.request_id
JOIN common.request_words rw ON rw.word_id = rwds.word_id
GROUP BY r.request_id, r.request;

COMMENT ON VIEW common.v_requests_lemmatized IS 'Запрос вместе со списком лемм его слов (через пробел) — для группировки/поиска похожих запросов в DataLens.';

-- Группировка запросов по одинаковому набору лемм (склонения/число/падеж не важны):
-- 'защита сервера от атак' / 'защита серверов от атак' / 'защиты серверов от атак'
-- дают одну и ту же lemma_signature -> попадают в одну group_id.
CREATE TABLE IF NOT EXISTS common.request_groups (
    group_id         SERIAL PRIMARY KEY,
    lemma_signature  TEXT NOT NULL UNIQUE,
    canonical_request TEXT NOT NULL
);

COMMENT ON TABLE common.request_groups IS 'Группы запросов с одинаковым набором лемм (нормализованных слов) — разные словоформы одного и того же смысла.';
COMMENT ON COLUMN common.request_groups.lemma_signature IS 'Отсортированный уникальный набор лемм запроса, через пробел — ключ группировки.';
COMMENT ON COLUMN common.request_groups.canonical_request IS 'Самый короткий исходный запрос группы — показывается как название группы.';

ALTER TABLE common.requests ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES common.request_groups(group_id);
COMMENT ON COLUMN common.requests.group_id IS 'Группа запроса (common.request_groups) по совпадению набора лемм — проставляется scripts/lemmatize-requests.js.';

CREATE INDEX IF NOT EXISTS idx_requests_group ON common.requests(group_id);

-- Группы с составом (сколько словоформ в группе и какие) — для DataLens
CREATE OR REPLACE VIEW common.v_request_groups AS
SELECT
    rg.group_id,
    rg.canonical_request,
    rg.lemma_signature,
    COUNT(r.request_id)                              AS variants_count,
    string_agg(r.request, ' | ' ORDER BY r.request)   AS variants
FROM common.request_groups rg
JOIN common.requests r ON r.group_id = rg.group_id
GROUP BY rg.group_id, rg.canonical_request, rg.lemma_signature;

COMMENT ON VIEW common.v_request_groups IS 'Группы запросов с полным списком словоформ, входящих в группу — для DataLens.';
