-- ============================================
-- REPORTS: спрос по продуктам (Wordstat) для сезонных индексов
-- Заполняется scripts/wordstat-product-demand.js
-- ============================================

CREATE SCHEMA IF NOT EXISTS reports;

-- Привязка фраза -> продукт. Источник привязки: группы проекта ddos-guard.ru в Топвизоре.
-- Частотность самих фраз лежит в wordstat.dynamics_range (по request_id и месяцам).
-- is_active = false — фразу временно не учитывать в спросе (без удаления привязки).
CREATE TABLE IF NOT EXISTS reports.demand_phrases (
    request_id INTEGER NOT NULL REFERENCES common.requests(request_id),
    product TEXT NOT NULL,             -- L3-4 | L7 | VDS | DS | Хостинг | Главная
    topvisor_group TEXT,               -- исходная группа в Топвизоре
    source TEXT NOT NULL DEFAULT 'topvisor',
    is_active BOOLEAN NOT NULL DEFAULT true,
    fetched_from DATE,                 -- диапазон, за который динамика последний раз успешно собрана
    fetched_to DATE,
    fetched_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (request_id, product)
);

COMMENT ON TABLE reports.demand_phrases IS 'Фразы, по которым считается спрос по продуктам. Привязка к продукту — из групп Топвизора (ddos-guard.ru). Не учитывать группы DDG VM, Cloudflare, dCAPTCHA, Аудит ИБ, ОРИ и проекты Блог/Термины.';

-- Помесячный спрос по продукту = сумма частотности активных фраз продукта.
-- phrases — сколько фраз вошло в сумму за месяц (для контроля полноты данных).
CREATE OR REPLACE VIEW reports.v_demand_product_monthly AS
SELECT dp.product,
       d.month,
       SUM(d.frequency)::bigint AS frequency,
       COUNT(DISTINCT d.request_id) AS phrases
FROM reports.demand_phrases dp
JOIN wordstat.dynamics_range d ON d.request_id = dp.request_id
WHERE dp.is_active
GROUP BY dp.product, d.month;

-- Спрос год к году: месяц против того же месяца год назад. Для спроса при двух сезонах данных это надёжнее нормы
-- (каждый месяц сравнивается с реальным значением, а не с моделью, на которой он сам обучен).
-- comparable = true, если в обоих месяцах в сумму вошло одинаковое число фраз (иначе сравнение нечестное).
CREATE OR REPLACE VIEW reports.v_demand_yoy AS
SELECT cur.product,
       cur.month,
       cur.frequency,
       prev.frequency AS frequency_prev_year,
       ROUND(100.0 * (cur.frequency::numeric / NULLIF(prev.frequency, 0) - 1), 1) AS yoy_pct,
       (cur.phrases = prev.phrases) AS comparable,
       cur.phrases
FROM reports.v_demand_product_monthly cur
LEFT JOIN reports.v_demand_product_monthly prev
       ON prev.product = cur.product AND prev.month = (cur.month - INTERVAL '1 year')::date;

COMMENT ON VIEW reports.v_demand_yoy IS 'Спрос Wordstat по продуктам: месяц к тому же месяцу год назад (yoy_pct, %). Сравнивать только строки с comparable = true.';

-- Равновесный индекс спроса по продукту. Сумма частотностей (v_demand_product_monthly) в продуктах с общей
-- «головной» фразой повторяет её одну: DS на 92% «защищенный сервер», L7 на 83% «защита сайта», VDS на 68% «vps».
-- Здесь каждая фраза нормируется на своё среднее по всем месяцам и входит с одинаковым весом: индекс месяца =
-- среднее относительных значений фраз. Для читаемости индекс переводится в «запросы в месяц»: умножается на сумму
-- средних фраз пула, то есть на среднем месяце равен обычной сумме. Берутся фразы со средней частотностью >= 30
-- (мелкие шумят). Формат колонок как у v_demand_product_monthly (product, month, frequency, phrases) + idx (100 = средний месяц).
CREATE OR REPLACE VIEW reports.v_demand_index_monthly AS
WITH f AS (
    SELECT dp.product, dp.request_id, d.month, d.frequency
    FROM reports.demand_phrases dp
    JOIN wordstat.dynamics_range d ON d.request_id = dp.request_id
    WHERE dp.is_active
),
m AS (
    SELECT product, request_id, AVG(frequency) AS mean_f
    FROM f GROUP BY product, request_id
    HAVING AVG(frequency) >= 30
),
tot AS (
    SELECT product, SUM(mean_f) AS total_mean FROM m GROUP BY product
)
SELECT f.product,
       f.month,
       ROUND(AVG(f.frequency / m.mean_f) * t.total_mean)::bigint AS frequency,
       ROUND(100 * AVG(f.frequency / m.mean_f), 1) AS idx,
       COUNT(*)::int AS phrases
FROM f
JOIN m USING (product, request_id)
JOIN tot t USING (product)
GROUP BY f.product, f.month, t.total_mean;

COMMENT ON VIEW reports.v_demand_index_monthly IS 'Равновесный индекс спроса по продуктам (каждая фраза со своим средним, одинаковый вес). frequency — индекс в единицах «запросов в месяц»; idx — 100 = средний месяц. Основа рядов demand_* в seasonality-index.js (режим --demand-weighting equal, по умолчанию).';

-- Год к году по равновесному индексу; сравнивать строки с comparable = true.
CREATE OR REPLACE VIEW reports.v_demand_index_yoy AS
SELECT cur.product,
       cur.month,
       cur.frequency,
       prev.frequency AS frequency_prev_year,
       ROUND(100.0 * (cur.frequency::numeric / NULLIF(prev.frequency, 0) - 1), 1) AS yoy_pct,
       (cur.phrases = prev.phrases) AS comparable,
       cur.phrases
FROM reports.v_demand_index_monthly cur
LEFT JOIN reports.v_demand_index_monthly prev
       ON prev.product = cur.product AND prev.month = (cur.month - INTERVAL '1 year')::date;
