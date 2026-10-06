-- services/reports/analysis/gsc_price_requests.sql
-- Все запросы из GSC с ценовым интентом: цена, стоимость, сколько стоит, прайс, тариф, расценки, price/cost.
-- Намеренно НЕ берём «купить», «заказать», «недорого», «дешёвый» — это коммерческий интент, но не прямой запрос цены.
-- Весь период, что есть в gsc.search_console (полноценные данные — с 2025-09).
-- Запуск на VDS: psql -f services/reports/analysis/gsc_price_requests.sql
-- Для выгрузки в CSV: psql -c "\copy (<запрос ниже>) TO 'gsc_price_requests.csv' CSV HEADER"

WITH base AS (
    SELECT
        sc.request,
        LOWER(sc.request)                                                  AS q,
        SUM(sc.impressions)                                                AS impressions,
        SUM(sc.clicks)                                                     AS clicks,
        SUM(sc.position * sc.impressions) / NULLIF(SUM(sc.impressions), 0) AS avg_position,
        MIN(sc.event_date)                                                 AS first_date,
        MAX(sc.event_date)                                                 AS last_date,
        COUNT(DISTINCT sc.target_url)                                      AS urls
    FROM gsc.search_console sc
    GROUP BY sc.request
),
tagged AS (
    SELECT
        b.*,
        CASE
            WHEN q ~ '(^|[^а-яёa-z0-9])(сколько (стоит|стоят|будет стоить|обойд[её]тся|платить)|почём|почем($|[^а-яё]))' THEN 'сколько стоит'
            WHEN q ~ '(^|[^а-яёa-z0-9])стоимост[а-яё]*'                                                 THEN 'стоимость'
            WHEN q ~ '(^|[^а-яёa-z0-9])цен(а|ы|у|е|ой|ам|ами|ах|ник|ники)?($|[^а-яё])'                    THEN 'цена'
            WHEN q ~ '(^|[^а-яёa-z0-9])прайс[а-яё-]*'                                                   THEN 'прайс'
            WHEN q ~ '(^|[^а-яёa-z0-9])тариф[а-яё]*'                                                    THEN 'тариф'
            WHEN q ~ '(^|[^а-яёa-z0-9])расценк[а-яё]*'                                                  THEN 'расценки'
            WHEN q ~ '(^|[^а-яёa-z0-9])(price|prices|pricing|cost|costs)($|[^a-z0-9])'            THEN 'price (en)'
        END AS price_kind
    FROM base b
)
SELECT
    request,
    price_kind,
    impressions,
    clicks,
    ROUND((clicks::numeric / NULLIF(impressions, 0)) * 100, 2) AS ctr_pct,
    ROUND(avg_position::numeric, 1)                           AS avg_position,
    urls,
    first_date,
    last_date
FROM tagged
WHERE price_kind IS NOT NULL
ORDER BY impressions DESC;
