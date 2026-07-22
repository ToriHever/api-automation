# GSC-дашборды в DataLens

Документация того, что живёт **только в DataLens** (QL-чарты, датасеты, RichText-формулы) —
это не хранится в БД/репозитории, поэтому легко забыть логику. SQL-вью, на которых всё
строится, — в [schema.sql](schema.sql).

## Источник данных

`gsc.search_console` — сырые данные Google Search Console (event_date, request, target_url → id
из `common.site_map`, clicks, impressions, ctr, position). Коллектор: `services/gsc/GSCCollector.js`.

⚠️ Ежедневный сбор был нестабилен с октября 2025 по конец апреля 2026 (сбои cron —
см. историю в этом чате от 2026-07-21). Полноценная непрерывная история есть примерно
с конца апреля 2026 — из-за этого сравнение "год к году" на некоторых страницах/кластерах
может показывать пусто за `previous`, это не баг.

## Цепочка вью (services/analytics/schema.sql)

```
gsc.search_console
      │
      ▼
v_gsc_requests_daily   — + project_name/cluster_topvisor_name (через topvisor.dim_keywords/
      │                    dim_groups), is_cluster_keyword, is_brand (common.brand_keywords),
      │                    site (RU/EN/other по домену common.site_map.url)
      ▼
v_gsc_requests_agg     — current/prev (скользящие 30 дней), БЕЗ бренда (NOT is_brand),
      │                    группировка request × project_name × cluster_topvisor_name
      ▼
v_gsc_requests_kpi     — готовые ТОП3/5/10/все (bucket) × режим all/keywords_only (mode) ×
                           project_name/cluster_topvisor_name, current/prev + %-динамика

v_gsc_requests_daily (is_brand) ──▶ v_gsc_requests_kpi_brand — та же bucket-логика,
                                      но только site (RU/EN), без project/cluster/mode

gsc.search_console + TopVisor ──▶ v_gsc_monthly / v_gsc_yearly — сводка по месяцам/годам
                                      для отдельной большой таблицы (не часть основной цепочки,
                                      строится напрямую из gsc.search_console)
```

`product_name`/`common.products` в цепочке больше нет — таблица содержала дубли по `url_id`,
JOIN на неё размножал строки `gsc.search_console` и искажал средние (см. "Известные грабли").
Дропнута (`DROP TABLE common.products CASCADE`). "Продуктом"/меткой страницы теперь везде
служит связка `project_name`/`cluster_topvisor_name` через TopVisor.

Брендовые запросы определяются в `v_gsc_requests_daily`:
```sql
EXISTS (SELECT 1 FROM common.brand_keywords bk WHERE sc.request ILIKE '%' || bk.keyword || '%')
```
Список брендовых слов — таблица `common.brand_keywords`.

## QL-чарт 1: KPI по кластеру (сумма кликов/показов, средние CTR/позиция)

Источник — `gsc.search_console` напрямую (не через вью выше — считался отдельно под кластерный
фильтр до появления `v_gsc_requests_*`). Резолвит целевой URL кластера через
`topvisor.dim_keywords → dim_groups → dim_projects → dim_projects_engines`.

Параметры QL: `project_name`, `cluster_topvisor_name`, `event_date_from`/`event_date_to`,
`mode` (`all` — все GSC-запросы по целевому URL кластера / `keywords_only` — только те, что
реально есть в `dim_keywords`), `compare_mode` (`yoy` — год к году / `pop` — период к периоду).

Для year-over-year/period-over-period график строится с `day_offset` на оси X (день от начала
периода) и `period` (`current`/`previous`) как разбивка/легенда — не используем `event_date`
напрямую на оси X, иначе current и previous не совпадут по дням.

## QL-чарт 2: Таблица запросов по кластеру

Тот же принцип (резолв URL кластера через TopVisor), но группировка по `sc.request` вместо
агрегирования в одну строку. Параметры: `project_name`, `cluster_topvisor_name`,
`event_date_from`/`event_date_to`, `mode`, `brand_filter` (`all`/`brand`/`non_brand`),
`position_filter` (`all`/`top3`/`top5`/`top10`/`custom`) + `position_custom_min`/
`position_custom_max` (Float, с дефолтами вроде `0`/`100` — иначе на пресетах, отличных от
`custom`, всё равно словишь ошибку типа, см. грабли ниже). Колонки: `request`, `clicks_sum`,
`impressions_sum`, `ctr_avg`, `position_avg`, `is_cluster_keyword`, `is_brand`.

Границы бакетов позиции (`HAVING` по `AVG(sc.position)`, не `WHERE` по сырой `sc.position` —
фильтровать нужно по средней позиции запроса за период, а не по позиции отдельного дня):
`top3` — `<= 3.5`, `top5` — `> 3.5 и <= 5.5`, `top10` — `> 5.5 и <= 10.5`.

## QL-чарт 3: Таблица запросов только по бренду

Аналог чарта 2, но **без** `cluster_keywords`/`target_urls` (никакого `JOIN` на TopVisor-
структуру вообще) — бренд-трафик не привязан к конкретному кластеру/странице и не должен
теряться на страницах, которые TopVisor не отслеживает. Источник — `gsc.search_console`
напрямую + `EXISTS` на `common.brand_keywords`. Параметры: `event_date_from`/`event_date_to`,
`position_filter`/`position_custom_min`/`position_custom_max` (та же логика, что в чарте 2).
`project_name`/`cluster_topvisor_name`/`mode`/`brand_filter` тут не нужны — чарт по
определению весь про бренд.

## Датасет-чарт: KPI-блоки (v_gsc_requests_kpi / v_gsc_requests_kpi_brand)

Обычный Датасет (не QL) поверх вью. RichText-поля `top3_block`/`top5_block`/`top10_block`/
`summary_block` (плюс объединяющее поле = сумма всех четырёх через `+`) читают уже готовые
числа из вью, никакой агрегации в DataLens не считают — только `MAX(IF [bucket]='top3' THEN
[requests_current] END)` (обязательная обёртка в агрегатную функцию для RichText-поля) и
раскраска/стрелки ▲▼.

**Важно про `NULL`:** DataLens проверяет каждое вхождение `MAX(IF ... END)` независимо — внешний
`IS NULL`-чек не защищает повторное использование того же выражения в `>= 0` или `ABS(...)`.
Такие места оборачивай в `IFNULL(MAX(IF ...), 0)`, иначе `ERR.DS_API.FORMULA.TRANSLATION:
Invalid comparison with NULL`.

Для `v_gsc_requests_kpi` фильтрация по `mode` (`all`/`keywords_only`) делается **Селектором на
дашборде**, привязанным к полю `mode` (не в формулах — формулы используют только `[bucket]`).
Для `v_gsc_requests_kpi_brand` фильтр — только по `site` (RU/EN), полей `project_name`/
`cluster_topvisor_name`/`mode` там нет вообще (сознательно, чтобы не терять брендовый трафик
на страницах, не отслеживаемых в TopVisor).

### Известные грабли (на будущее)

- **`CREATE OR REPLACE VIEW`** в Postgres не даёт убрать/переставить колонки — только дописать
  в конец. Если меняешь состав/порядок полей — `DROP VIEW` + `CREATE VIEW` заново (и не забыть
  дропнуть/пересоздать заодно всё, что зависит: `DROP` в Postgres требует явного порядка —
  сначала листья зависимостей, `v_gsc_requests_kpi`/`v_gsc_requests_kpi_brand`, потом
  `v_gsc_requests_agg`, потом `v_gsc_requests_daily`).
- **`is_cluster_keyword` как `BOOL_OR` поверх уже агрегированного bucket** — не работает
  (почти всегда `TRUE`, т.к. в топ-3/5/10 обычно попадает хотя бы один трекаемый запрос).
  Правильно — разводить `mode` как отдельное измерение **до** агрегации (см. `buckets` CTE
  в `v_gsc_requests_kpi`), а не постфактум флагом.
- Джойн `totals`/`pivoted` по `project_name`/`cluster_topvisor_name` — через
  `IS NOT DISTINCT FROM`, не `=`, потому что эти поля бывают `NULL` (страница вне TopVisor-
  структуры), а обычный `=` с `NULL` всегда даёт `NULL`.
- **`INNER JOIN` на справочник с дублями молча размножает и искажает данные.** Так было с
  `common.products`: дубли по `url_id` заставляли `JOIN` возвращать по несколько строк на
  один факт из `gsc.search_console`, из-за чего `AVG(position)` съезжал и запросы попадали не
  в тот bucket (top5 вместо top3 и т.п.). Если после смены источника числа "поплыли" без
  видимой причины — в первую очередь проверяй `COUNT(*)` до и после джойна на подозрительный
  справочник, а не гадай на самой агрегации.
- **CTR обязательно взвешенный** (`SUM(clicks) / SUM(impressions)`), не `AVG(ctr)` по строкам/
  запросам. `AVG` даёт "средний CTR отдельного запроса" — метрику, где мелкий запрос с 1
  показом и 1 кликом (100% CTR) весит наравне с запросом с 5000 показов, и итог может быть как
  сильно завышен, так и занижен относительно реального `clicks/impressions`. Сам GSC в
  агрегированных отчётах считает именно `SUM/SUM`. Применено во всех местах, где CTR считается
  не по одной строке: `v_gsc_requests_agg.ctr`, `v_gsc_requests_kpi(_brand).ctr_avg`.
- **Прежде чем `DROP TABLE ... CASCADE`, проверяй ВСЕ зависимые объекты**, не только те, что
  сам трогал в текущей задаче — `common.products` тянула за собой `v_gsc_monthly`/
  `v_gsc_yearly`, о которых в моменте забыли, они оказались живыми и использовались в другой
  таблице DataLens. `SELECT * FROM pg_depend`/информационная схема или хотя бы явный вопрос
  "точно нигде не используется?" — до дропа, не после.
