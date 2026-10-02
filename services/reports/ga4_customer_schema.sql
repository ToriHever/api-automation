-- ============================================
-- REPORTS: клиентский путь из GA4 (по customer_id, совпадает с id клиента в админке)
-- Заполняется scripts/ga4-customer-journey.js. customer_id — внутренний идентификатор, в отчёты наружу не выводить.
-- ============================================

CREATE SCHEMA IF NOT EXISTS reports;

-- События пути по клиенту: регистрация, корзина, оформление, способ оплаты, оплата (день × клиент × событие × первый источник)
CREATE TABLE IF NOT EXISTS reports.ga4_customer_events (
    event_date DATE NOT NULL,
    customer_id TEXT NOT NULL,
    event_name TEXT NOT NULL,
    first_channel TEXT NOT NULL DEFAULT '',     -- firstUserDefaultChannelGroup: Organic Search, Direct, Paid Search, …
    first_source TEXT NOT NULL DEFAULT '',
    first_medium TEXT NOT NULL DEFAULT '',
    first_campaign TEXT NOT NULL DEFAULT '',
    event_count INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_date, customer_id, event_name, first_channel, first_source, first_medium, first_campaign)
);
CREATE INDEX IF NOT EXISTS idx_ga4_customer_events_cust ON reports.ga4_customer_events(customer_id);

-- Оплаты (purchase) с деталями из параметров события
CREATE TABLE IF NOT EXISTS reports.ga4_customer_purchases (
    event_date DATE NOT NULL,
    customer_id TEXT NOT NULL,
    transaction_id TEXT NOT NULL DEFAULT '',
    coupon TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT '',
    value NUMERIC(14,2) NOT NULL DEFAULT 0,      -- 0 = значение не передано
    payment_type TEXT NOT NULL DEFAULT '',
    period TEXT NOT NULL DEFAULT '',
    event_count INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_date, customer_id, transaction_id, coupon, currency, payment_type, period, value)
);
CREATE INDEX IF NOT EXISTS idx_ga4_customer_purchases_cust ON reports.ga4_customer_purchases(customer_id);

COMMENT ON TABLE reports.ga4_customer_events IS 'События воронки GA4 по customer_id и каналу ПЕРВОГО визита пользователя (не сессии). Тестовые стенды исключены.';
COMMENT ON TABLE reports.ga4_customer_purchases IS 'purchase из GA4 с купоном, валютой, суммой, способом оплаты. value — из параметра события, валюта в currency (RUB/USD).';

-- Клиент: первый канал, дата регистрации, первая оплата, срок, число оплат, тест L3-4 (купон L3_PAID_TEST_99)
CREATE OR REPLACE VIEW reports.v_ga4_customer_journey AS
WITH ev AS (
    SELECT customer_id,
           MIN(event_date) FILTER (WHERE event_name = 'registration') AS reg_date,
           MIN(event_date) FILTER (WHERE event_name = 'purchase') AS first_purchase_date,
           SUM(event_count) FILTER (WHERE event_name = 'begin_checkout') AS checkouts,
           (ARRAY_AGG(first_channel ORDER BY event_date) FILTER (WHERE first_channel <> ''))[1] AS first_channel,
           (ARRAY_AGG(first_source ORDER BY event_date) FILTER (WHERE first_source <> ''))[1] AS first_source,
           (ARRAY_AGG(first_medium ORDER BY event_date) FILTER (WHERE first_medium <> ''))[1] AS first_medium
    FROM reports.ga4_customer_events GROUP BY customer_id
),
pu AS (
    SELECT customer_id, SUM(event_count) AS purchases,
           BOOL_OR(coupon = 'L3_PAID_TEST_99') AS had_l3_test,
           BOOL_OR(coupon <> '' AND coupon <> 'L3_PAID_TEST_99') AS had_other_coupon
    FROM reports.ga4_customer_purchases GROUP BY customer_id
)
SELECT ev.customer_id, ev.first_channel, ev.first_source, ev.first_medium, ev.reg_date, ev.first_purchase_date,
       (ev.first_purchase_date - ev.reg_date) AS days_to_purchase,
       COALESCE(ev.checkouts, 0) AS checkouts, COALESCE(pu.purchases, 0) AS purchases,
       COALESCE(pu.had_l3_test, false) AS had_l3_test, COALESCE(pu.had_other_coupon, false) AS had_other_coupon
FROM ev LEFT JOIN pu USING (customer_id);

COMMENT ON VIEW reports.v_ga4_customer_journey IS 'Клиентский путь по GA4: канал первого визита, регистрация, первая оплата, число оплат, признак теста L3-4. Клиент без регистрации в GA4 (зарегистрировался до 2026 или не попал в событие) имеет reg_date = NULL.';

-- Конверсия регистраций месяца в оплату (по каналу): сколько оплатили в тот же месяц / за 30 / за 90 дней.
-- За 30/90 дней корректно только для месяцев, прошедших этот срок до последней даты данных.
CREATE OR REPLACE VIEW reports.v_ga4_registration_funnel_monthly AS
SELECT date_trunc('month', reg_date)::date AS month,
       CASE WHEN first_channel = 'Organic Search' THEN 'Organic' ELSE 'Прочие' END AS grp,
       COUNT(*) AS registered,
       COUNT(*) FILTER (WHERE first_purchase_date IS NOT NULL AND days_to_purchase <= 0) AS paid_same_day,
       COUNT(*) FILTER (WHERE first_purchase_date IS NOT NULL AND days_to_purchase <= 30) AS paid_30d,
       COUNT(*) FILTER (WHERE first_purchase_date IS NOT NULL AND days_to_purchase <= 90) AS paid_90d,
       COUNT(*) FILTER (WHERE first_purchase_date IS NOT NULL) AS paid_any,
       COUNT(*) FILTER (WHERE had_l3_test) AS l3_test
FROM reports.v_ga4_customer_journey
WHERE reg_date IS NOT NULL
GROUP BY 1, 2;

COMMENT ON VIEW reports.v_ga4_registration_funnel_monthly IS 'Регистрации месяца по каналу первого визита и доля оплативших (в день регистрации, за 30, 90 дней, когда-либо).';
