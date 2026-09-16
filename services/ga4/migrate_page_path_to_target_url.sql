-- services/ga4/migrate_page_path_to_target_url.sql
-- Разовая миграция ga4.web_vitals.page_path (TEXT, относительный путь без
-- домена) -> target_url (FK на common.site_map), по аналогии с
-- topvisor.positions.relevant_url_id (см. services/topvisor/topvisor_url_normalization.sql).
--
-- Нужна, потому что до этой миграции GA4Collector писал page_path напрямую
-- (без домена), из-за чего эти данные было невозможно связать с остальной БД
-- (все другие таблицы хранят полный URL через common.site_map) и фильтровать
-- по кластеру/группе TopVisor или по ссылке.
--
-- Запускать ОДИН раз на сервере ДО обновления кода (git pull) на версию с
-- target_url в GA4Collector.js/schema.sql. Домен захардкожен — единственный
-- сайт, с которого шлётся событие webVitals (services/ga4/config.json.domain).

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'ga4' AND table_name = 'web_vitals' AND column_name = 'page_path'
    ) THEN
        RAISE NOTICE 'Колонка page_path отсутствует — миграция уже выполнена, ничего не делаем';
        RETURN;
    END IF;

    -- Шаг 1: добавляем target_url (пока nullable, заполним ниже)
    ALTER TABLE ga4.web_vitals ADD COLUMN IF NOT EXISTS target_url INTEGER REFERENCES common.site_map(id);

    -- Шаг 2: наполняем common.site_map полными URL (домен + путь)
    INSERT INTO common.site_map (url)
    SELECT DISTINCT rtrim('https://ddos-guard.ru' || page_path, '/')
    FROM ga4.web_vitals
    WHERE page_path IS NOT NULL
    ON CONFLICT (url) DO NOTHING;

    -- Шаг 3: проставляем target_url по совпадению URL
    UPDATE ga4.web_vitals wv
    SET target_url = sm.id
    FROM common.site_map sm
    WHERE sm.url = rtrim('https://ddos-guard.ru' || wv.page_path, '/')
      AND wv.target_url IS NULL;
END $$;

-- Шаг 4: проверка, что всё смигрировалось
DO $$
DECLARE
    v_not_migrated INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_not_migrated FROM ga4.web_vitals WHERE target_url IS NULL;

    IF v_not_migrated > 0 THEN
        RAISE WARNING '% строк(и) не удалось смигрировать (target_url IS NULL) — миграция ОСТАНОВЛЕНА, page_path НЕ удалён, PK не менялся', v_not_migrated;
    ELSE
        RAISE NOTICE 'Миграция успешна: все строки получили target_url';
    END IF;
END $$;

-- Шаг 4.5: склейка дублей. Разные варианты page_path (например, с "/" и без
-- "/" на конце) после нормализации могут схлопнуться в один и тот же
-- target_url — без этого шага Шаг 5 упадёт на создании уникального PRIMARY
-- KEY (event_date, metric_name, target_url) с ошибкой "duplicate key".
DO $$
DECLARE
    v_dup_groups INTEGER;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'ga4' AND table_name = 'web_vitals' AND column_name = 'page_path'
    ) THEN
        RETURN;
    END IF;

    SELECT COUNT(*) INTO v_dup_groups FROM (
        SELECT event_date, metric_name, target_url
        FROM ga4.web_vitals
        GROUP BY event_date, metric_name, target_url
        HAVING COUNT(*) > 1
    ) d;

    IF v_dup_groups = 0 THEN
        RAISE NOTICE 'Дублей (event_date, metric_name, target_url) не найдено — склейка не нужна';
        RETURN;
    END IF;

    RAISE NOTICE 'Найдено % групп(ы) с дублями по target_url — склеиваю (сумма event_count, взвешенное metric_value)', v_dup_groups;

    CREATE TEMP TABLE _web_vitals_merged AS
    SELECT
        event_date,
        metric_name,
        target_url,
        SUM(event_count) AS event_count,
        SUM(metric_value * event_count) / NULLIF(SUM(event_count), 0) AS metric_value,
        MIN(page_path) AS page_path,
        MIN(created_at) AS created_at
    FROM ga4.web_vitals
    GROUP BY event_date, metric_name, target_url;

    DELETE FROM ga4.web_vitals;

    INSERT INTO ga4.web_vitals (event_date, metric_name, target_url, event_count, metric_value, page_path, created_at)
    SELECT event_date, metric_name, target_url, event_count, metric_value, page_path, created_at
    FROM _web_vitals_merged;

    DROP TABLE _web_vitals_merged;

    RAISE NOTICE 'Склейка дублей завершена';
END $$;

-- Шаг 5: финализация схемы — выполняется, только если миграция полностью
-- прошла (Шаг 4 не показал warning). Если увидели warning выше — НЕ
-- выполняйте этот блок, а сначала разберитесь, почему остались NULL
-- (SELECT DISTINCT page_path FROM ga4.web_vitals WHERE target_url IS NULL).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'ga4' AND table_name = 'web_vitals' AND column_name = 'page_path'
    ) THEN
        RETURN;
    END IF;

    IF EXISTS (SELECT 1 FROM ga4.web_vitals WHERE target_url IS NULL) THEN
        RAISE EXCEPTION 'Финализация остановлена: есть строки без target_url, см. Шаг 4';
    END IF;

    ALTER TABLE ga4.web_vitals ALTER COLUMN target_url SET NOT NULL;
    ALTER TABLE ga4.web_vitals DROP CONSTRAINT IF EXISTS web_vitals_pkey;
    ALTER TABLE ga4.web_vitals ADD PRIMARY KEY (event_date, metric_name, target_url);
    ALTER TABLE ga4.web_vitals DROP COLUMN page_path;

    CREATE INDEX IF NOT EXISTS idx_web_vitals_target_url ON ga4.web_vitals(target_url);

    RAISE NOTICE 'Схема финализирована: page_path удалён, target_url — часть PRIMARY KEY';
END $$;
