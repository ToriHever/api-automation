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
