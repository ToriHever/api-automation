-- ============================================
-- REPORTS: органический трафик по страницам входа (по месяцам) и связь с покупками
-- Заполняется scripts/traffic-organic-landing.js
-- ============================================

CREATE SCHEMA IF NOT EXISTS reports;

CREATE TABLE IF NOT EXISTS reports.traffic_organic_landing (
    source TEXT NOT NULL,             -- 'ga4' | 'metrika'
    site TEXT NOT NULL,               -- 'ru' | 'en'
    month DATE NOT NULL,              -- первый день месяца (только полные месяцы)
    page TEXT NOT NULL,               -- https://ddos-guard.ru/путь, нижний регистр, без параметров и без / на конце
    engine TEXT NOT NULL,             -- 'Yandex' | 'Google' | 'Other'
    sessions INTEGER NOT NULL DEFAULT 0,   -- GA4 sessions / Метрика visits: сессии, НАЧАВШИЕСЯ на этой странице
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (source, site, month, page, engine)
);

COMMENT ON TABLE reports.traffic_organic_landing IS 'Органические сессии по странице входа (landing page), месяц × страница × поисковик. Страница нормализована так же, как analytics.v_topvisor_group_target_urls.url_norm.';
CREATE INDEX IF NOT EXISTS idx_traffic_organic_landing_month ON reports.traffic_organic_landing(month);

-- Группа страницы: продуктовая страница из Топвизора (target фраз группы) > информационный раздел > прочее.
-- Если URL назначен нескольким группам, берётся продуктовая (L7, L3-4, DS, VDS, Хостинг) раньше «Главной».
CREATE OR REPLACE VIEW reports.v_landing_page_group AS
WITH ranked AS (
    SELECT url_norm,
           CASE cluster_topvisor_name WHEN 'L7' THEN 1 WHEN 'L3-4' THEN 2 WHEN 'DS' THEN 3 WHEN 'VDS/VPS' THEN 4
                                      WHEN 'Хостинг' THEN 5 WHEN 'Главная' THEN 6 END AS pr,
           CASE cluster_topvisor_name WHEN 'VDS/VPS' THEN 'VDS' ELSE cluster_topvisor_name END AS grp
    FROM analytics.v_topvisor_group_target_urls
    WHERE project_name = 'ddos-guard.ru' AND cluster_topvisor_name IN ('L7', 'L3-4', 'DS', 'VDS/VPS', 'Хостинг', 'Главная')
)
SELECT DISTINCT ON (url_norm) url_norm, grp FROM ranked ORDER BY url_norm, pr;

COMMENT ON VIEW reports.v_landing_page_group IS 'Продуктовые страницы по группам Топвизора (проект ddos-guard.ru). Страницы без назначенной группы определяются по пути в v_traffic_landing_group_monthly.';

-- Помесячно по группам: Метрика и GA4 отдельно, поисковики вместе и порознь
CREATE OR REPLACE VIEW reports.v_traffic_landing_group_monthly AS
SELECT t.source, t.site, t.month, t.engine,
       COALESCE(g.grp,
                CASE WHEN t.page ~ '^https://[^/]+/(blog|terms|tutorials|technologies|case-studies|osi-model)(/|$)' THEN 'Информационные'
                     ELSE 'Прочее' END) AS grp,
       SUM(t.sessions)::bigint AS sessions,
       COUNT(DISTINCT t.page) AS pages
FROM reports.traffic_organic_landing t
LEFT JOIN reports.v_landing_page_group g ON g.url_norm = t.page
GROUP BY 1, 2, 3, 4, 5;

COMMENT ON VIEW reports.v_traffic_landing_group_monthly IS 'Органические сессии по странице входа, сгруппированные по продуктовым группам / информационным разделам / прочему. Страница с трафиком, но без группы, попадает в «Прочее».';

-- Месяцы GA4 (ru) с полными данными: сбои сбора (например 30.07–17.08.2025) делают месяц неполным
CREATE OR REPLACE VIEW reports.v_ga4_months_complete AS
SELECT month, (MAX(days_with_data) >= EXTRACT(DAY FROM (month + INTERVAL '1 month' - INTERVAL '1 day'))) AS complete
FROM reports.v_organic_engine_monthly
WHERE source = 'ga4' AND site = 'ru'
GROUP BY month;

-- Связь с покупками по кварталам (GA4, все поисковики, только ru): сессии на страницы группы и плательщики группы.
-- Это НЕ конверсия страницы: покупатель мог прийти с главной или из блога. «Информационные» в продукт не входят.
CREATE OR REPLACE VIEW reports.v_purchases_vs_traffic_quarterly AS
WITH tr AS (
    SELECT date_trunc('quarter', t.month)::date AS quarter, t.grp, SUM(t.sessions) AS sessions,
           COUNT(DISTINCT t.month) AS months, COUNT(DISTINCT t.month) FILTER (WHERE m.complete) AS months_ok
    FROM reports.v_traffic_landing_group_monthly t
    LEFT JOIN reports.v_ga4_months_complete m ON m.month = t.month
    WHERE t.source = 'ga4' AND t.site = 'ru'
    GROUP BY 1, 2
),
pu AS (
    SELECT date_trunc('quarter', month)::date AS quarter, product AS grp,
           SUM(new_payers) AS payers, SUM(revenue_rub) AS revenue_rub, COUNT(DISTINCT month) AS months
    FROM reports.purchases_monthly
    GROUP BY 1, 2
)
SELECT tr.quarter, tr.grp, tr.sessions, pu.payers, pu.revenue_rub,
       ROUND(1000.0 * pu.payers / NULLIF(tr.sessions, 0), 2) AS payers_per_1000,
       ROUND(pu.revenue_rub / NULLIF(tr.sessions, 0) * 1000, 0) AS revenue_per_1000,
       (tr.months = 3 AND tr.months_ok = 3 AND pu.months = 3) AS complete
FROM tr JOIN pu ON pu.quarter = tr.quarter AND pu.grp = tr.grp;

COMMENT ON VIEW reports.v_purchases_vs_traffic_quarterly IS 'Квартал × группа: органические сессии на страницы группы (GA4, ru), новые плательщики и сумма из purchases_monthly. payers_per_1000 — не конверсия страницы (покупатель мог прийти с главной/блога), а соотношение для динамики. complete = все 3 месяца есть и GA4 в них без сбоев сбора.';

-- Весь сайт по кварталам: сессии на коммерческие страницы (Главная + продуктовые), на информационные и все новые плательщики из organic
CREATE OR REPLACE VIEW reports.v_traffic_vs_payers_site_quarterly AS
WITH tr AS (
    SELECT date_trunc('quarter', t.month)::date AS quarter,
           SUM(t.sessions) FILTER (WHERE t.grp = 'Главная') AS home,
           SUM(t.sessions) FILTER (WHERE t.grp IN ('L7', 'L3-4', 'DS', 'VDS', 'Хостинг')) AS product_pages,
           SUM(t.sessions) FILTER (WHERE t.grp = 'Информационные') AS informational,
           SUM(t.sessions) FILTER (WHERE t.grp = 'Прочее') AS other,
           COUNT(DISTINCT t.month) AS months, COUNT(DISTINCT t.month) FILTER (WHERE m.complete) AS months_ok
    FROM reports.v_traffic_landing_group_monthly t
    LEFT JOIN reports.v_ga4_months_complete m ON m.month = t.month
    WHERE t.source = 'ga4' AND t.site = 'ru'
    GROUP BY 1
),
pu AS (
    SELECT date_trunc('quarter', month)::date AS quarter, SUM(new_payers_organic) AS payers, SUM(revenue_organic_rub) AS revenue_rub,
           COUNT(DISTINCT month) AS months
    FROM reports.purchases_overall_monthly WHERE revenue_organic_rub IS NOT NULL
    GROUP BY 1
)
SELECT tr.quarter, tr.home, tr.product_pages, tr.informational, tr.other, pu.payers, pu.revenue_rub,
       (tr.months = 3 AND tr.months_ok = 3 AND pu.months = 3) AS complete
FROM tr JOIN pu ON pu.quarter = tr.quarter;

COMMENT ON VIEW reports.v_traffic_vs_payers_site_quarterly IS 'Квартал: органические сессии GA4 по типу страницы входа и все новые плательщики из organic. Нужна, чтобы увидеть, какой трафик связан с покупками.';
