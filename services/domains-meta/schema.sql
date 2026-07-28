-- services/domains-meta/schema.sql
-- Результаты сбора мета-информации по доменам из l7.clients.
-- Аппенд-лог: каждый прогон дописывает новые строки (по одной на домен),
-- существующие строки не обновляются.

CREATE SCHEMA IF NOT EXISTS l7;

CREATE TABLE IF NOT EXISTS l7.domains_meta_scan (
    id              SERIAL PRIMARY KEY,
    client_id       BIGINT,
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

-- ============================================================
-- Категоризация сайтов по содержимому title/description/keywords/h1/og_title.
-- Эвристика по ключевым словам (не ML) — эти UPDATE идемпотентны
-- (AND site_type IS NULL) и выполняются автоматически при каждом запуске
-- коллектора (createSchema() гоняет этот файл целиком), так что новые
-- домены категоризируются сами по себе на следующий день после скана.
--
-- Порядок правил имеет значение: то, что применилось раньше, "застолбило"
-- строку — следующее правило её уже не тронет (site_type IS NULL перестаёт
-- быть true). Если нужно поменять приоритет — меняй порядок блоков ниже.
--
-- \m / \M в regex — границы начала/конца слова (аналог \b). У обрезанных
-- корней (новост, проституток) \M не ставим — иначе слово должно
-- заканчиваться ровно на этом корне и не матчит словоформы с окончаниями.
-- ============================================================

ALTER TABLE l7.domains_meta_scan ADD COLUMN IF NOT EXISTS site_type TEXT;

COMMENT ON COLUMN l7.domains_meta_scan.site_type IS 'Категория сайта по эвристике на ключевых словах в title/description/keywords/h1/og_title. NULL = не подошёл ни под одно правило ниже.';

-- СМИ / новостные издания
UPDATE l7.domains_meta_scan
SET site_type = 'СМИ'
WHERE site_type IS NULL
  AND concat_ws(' ', title, description, keywords, h1, og_title) ~* (
      '\mновост|\mСМИ\M|\mиздани|\mгазет|\mжурнал|информационн(ое|ые)? агентств|' ||
      '\mинформагентств|\mмедиахолдинг|\mредакци|\mмедиаресурс|' ||
      'news portal|news website|media outlet|\mnewspaper\M|\mnews\M'
  );

-- Эскорт / интим-услуги
UPDATE l7.domains_meta_scan
SET site_type = 'эскорт/интим-услуги'
WHERE site_type IS NULL
  AND concat_ws(' ', title, description, keywords, h1, og_title) ~* (
      '\mпроститутк|\mпутан|\mшлюх|\mиндивидуалк|' ||
      'интим[- ]?услуг|\mэскорт|снять девушку|вызвать проститутку|' ||
      'секс[- ]?услуг|интим за деньги|досуг с девушк'
  );
