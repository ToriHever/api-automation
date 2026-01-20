-- =====================================================
-- МИГРАЦИЯ: Нормализация relevant_url в topvisor.positions
-- =====================================================
-- Цель: Заменить текстовый столбец relevant_url на ID из справочника common.site_map
-- Автор: API Automation System
-- Дата: 2025
-- =====================================================

-- Шаг 1: Проверка существования таблиц и столбцов
DO $$
BEGIN
    -- Проверяем существование таблицы common.site_map
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables 
                   WHERE table_schema = 'common' 
                   AND table_name = 'site_map') THEN
        RAISE EXCEPTION 'Таблица common.site_map не существует. Сначала создайте справочник URL.';
    END IF;
    
    -- Проверяем существование таблицы topvisor.positions
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables 
                   WHERE table_schema = 'topvisor' 
                   AND table_name = 'positions') THEN
        RAISE EXCEPTION 'Таблица topvisor.positions не существует.';
    END IF;
    
    RAISE NOTICE 'Проверка таблиц пройдена успешно';
END $$;

-- Шаг 2: Добавление нового столбца relevant_url_id (если еще не существует)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'topvisor' 
                   AND table_name = 'positions' 
                   AND column_name = 'relevant_url_id') THEN
        ALTER TABLE topvisor.positions 
        ADD COLUMN relevant_url_id INTEGER REFERENCES common.site_map(id);
        
        RAISE NOTICE 'Добавлен столбец relevant_url_id';
    ELSE
        RAISE NOTICE 'Столбец relevant_url_id уже существует';
    END IF;
END $$;

-- Шаг 3: Заполнение справочника common.site_map уникальными URL
DO $$
DECLARE
    v_count INTEGER;
    v_inserted INTEGER;
BEGIN
    -- Подсчитываем количество уникальных URL
    SELECT COUNT(DISTINCT relevant_url) INTO v_count
    FROM topvisor.positions 
    WHERE relevant_url IS NOT NULL 
    AND relevant_url != ''
    AND relevant_url_id IS NULL;
    
    RAISE NOTICE 'Найдено % уникальных URL для добавления в справочник', v_count;
    
    -- Вставляем уникальные URL в справочник
    INSERT INTO common.site_map (url)
    SELECT DISTINCT relevant_url
    FROM topvisor.positions
    WHERE relevant_url IS NOT NULL 
    AND relevant_url != ''
    AND relevant_url_id IS NULL
    ON CONFLICT (url) DO NOTHING;
    
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RAISE NOTICE 'Добавлено % новых URL в справочник common.site_map', v_inserted;
END $$;

-- Шаг 4: Заполнение столбца relevant_url_id на основе маппинга
DO $$
DECLARE
    v_updated INTEGER;
    v_batch_size INTEGER := 10000;
    v_offset INTEGER := 0;
    v_total_updated INTEGER := 0;
    v_batch_updated INTEGER;
BEGIN
    RAISE NOTICE 'Начинаем обновление relevant_url_id...';
    
    -- Обновляем батчами для оптимизации производительности
    LOOP
        UPDATE topvisor.positions p
        SET relevant_url_id = sm.id
        FROM common.site_map sm
        WHERE p.relevant_url = sm.url
        AND p.relevant_url IS NOT NULL
        AND p.relevant_url != ''
        AND p.relevant_url_id IS NULL
        AND p.id IN (
            SELECT id 
            FROM topvisor.positions
            WHERE relevant_url IS NOT NULL
            AND relevant_url != ''
            AND relevant_url_id IS NULL
            ORDER BY id
            LIMIT v_batch_size
            OFFSET v_offset
        );
        
        GET DIAGNOSTICS v_batch_updated = ROW_COUNT;
        v_total_updated := v_total_updated + v_batch_updated;
        
        EXIT WHEN v_batch_updated = 0;
        
        v_offset := v_offset + v_batch_size;
        
        -- Логирование прогресса
        IF v_offset % 50000 = 0 THEN
            RAISE NOTICE 'Обработано % записей...', v_offset;
        END IF;
    END LOOP;
    
    RAISE NOTICE 'Обновлено % записей с relevant_url_id', v_total_updated;
END $$;

-- Шаг 5: Обработка пустых URL (устанавливаем NULL)
UPDATE topvisor.positions
SET relevant_url_id = NULL
WHERE (relevant_url IS NULL OR relevant_url = '')
AND relevant_url_id IS NULL;

-- Шаг 6: Создание индексов для оптимизации
CREATE INDEX IF NOT EXISTS idx_positions_relevant_url_id 
ON topvisor.positions(relevant_url_id);

CREATE INDEX IF NOT EXISTS idx_positions_relevant_url_id_date 
ON topvisor.positions(relevant_url_id, event_date);

-- Шаг 7: Проверка результатов миграции
DO $$
DECLARE
    v_total_records INTEGER;
    v_migrated_records INTEGER;
    v_null_url_records INTEGER;
    v_not_migrated INTEGER;
BEGIN
    -- Общее количество записей
    SELECT COUNT(*) INTO v_total_records
    FROM topvisor.positions;
    
    -- Записи с заполненным relevant_url_id
    SELECT COUNT(*) INTO v_migrated_records
    FROM topvisor.positions
    WHERE relevant_url_id IS NOT NULL;
    
    -- Записи с пустым/NULL relevant_url
    SELECT COUNT(*) INTO v_null_url_records
    FROM topvisor.positions
    WHERE relevant_url IS NULL OR relevant_url = '';
    
    -- Записи, которые не удалось мигрировать
    SELECT COUNT(*) INTO v_not_migrated
    FROM topvisor.positions
    WHERE relevant_url IS NOT NULL 
    AND relevant_url != ''
    AND relevant_url_id IS NULL;
    
    RAISE NOTICE '==========================================';
    RAISE NOTICE 'РЕЗУЛЬТАТЫ МИГРАЦИИ:';
    RAISE NOTICE '==========================================';
    RAISE NOTICE 'Всего записей: %', v_total_records;
    RAISE NOTICE 'Успешно мигрировано: %', v_migrated_records;
    RAISE NOTICE 'Записей с пустым URL: %', v_null_url_records;
    RAISE NOTICE 'Не удалось мигрировать: %', v_not_migrated;
    RAISE NOTICE '==========================================';
    
    -- Если есть немигрированные записи, показываем примеры
    IF v_not_migrated > 0 THEN
        RAISE WARNING 'Найдено % записей, которые не удалось мигрировать', v_not_migrated;
        RAISE NOTICE 'Примеры немигрированных URL:';
        
        FOR r IN (
            SELECT DISTINCT relevant_url
            FROM topvisor.positions
            WHERE relevant_url IS NOT NULL 
            AND relevant_url != ''
            AND relevant_url_id IS NULL
            LIMIT 5
        ) LOOP
            RAISE NOTICE '  - %', r.relevant_url;
        END LOOP;
    END IF;
END $$;

-- Шаг 8: Добавление комментариев к новому столбцу
COMMENT ON COLUMN topvisor.positions.relevant_url_id IS 'ID URL из справочника common.site_map (нормализованная версия relevant_url)';

-- =====================================================
-- ОПЦИОНАЛЬНЫЕ ДЕЙСТВИЯ (выполнять после проверки)
-- =====================================================

-- Опция 1: Создание представления для обратной совместимости
CREATE OR REPLACE VIEW topvisor.positions_with_url AS
SELECT 
    p.*,
    sm.url AS resolved_url
FROM topvisor.positions p
LEFT JOIN common.site_map sm ON p.relevant_url_id = sm.id;

COMMENT ON VIEW topvisor.positions_with_url IS 'Представление positions с разрешенными URL из справочника';

-- Опция 2: Удаление старого столбца (ТОЛЬКО после полной проверки!)
-- ВНИМАНИЕ: Выполнять только после тестирования и обновления кода приложения!
/*
-- Сначала сохраните резервную копию!
CREATE TABLE topvisor.positions_backup_relevant_url AS 
SELECT id, relevant_url 
FROM topvisor.positions;

-- Затем удалите столбец
ALTER TABLE topvisor.positions DROP COLUMN relevant_url;

-- Переименуйте новый столбец (опционально)
-- ALTER TABLE topvisor.positions RENAME COLUMN relevant_url_id TO relevant_url;
*/

-- =====================================================
-- ROLLBACK СКРИПТ (в случае необходимости отката)
-- =====================================================
/*
-- Для отката изменений:
ALTER TABLE topvisor.positions DROP COLUMN IF EXISTS relevant_url_id;
DROP INDEX IF EXISTS idx_positions_relevant_url_id;
DROP INDEX IF EXISTS idx_positions_relevant_url_id_date;
DROP VIEW IF EXISTS topvisor.positions_with_url;

-- Если был удален столбец relevant_url, восстановить из backup:
-- ALTER TABLE topvisor.positions ADD COLUMN relevant_url TEXT DEFAULT '';
-- UPDATE topvisor.positions p
-- SET relevant_url = b.relevant_url
-- FROM topvisor.positions_backup_relevant_url b
-- WHERE p.id = b.id;
*/