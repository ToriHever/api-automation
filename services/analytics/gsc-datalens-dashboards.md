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
      │                    группировка product_name × request
      ▼
v_gsc_requests_kpi     — готовые ТОП3/5/10/все (bucket) × режим all/keywords_only (mode) ×
                           product_name/project_name/cluster_topvisor_name, current/prev + %-динамика

v_gsc_requests_daily (is_brand) ──▶ v_gsc_requests_kpi_brand — та же bucket-логика,
                                      но только site (RU/EN), без project/cluster/mode
```

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
`event_date_from`/`event_date_to`, `mode`, `brand_filter` (`all`/`brand`/`non_brand`).
Колонки: `request`, `clicks_sum`, `impressions_sum`, `ctr_avg`, `position_avg`,
`is_cluster_keyword`, `is_brand`.

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
  в конец. Если меняешь состав/порядок полей — `DROP VIEW` + `CREATE VIEW` заново.
- **`is_cluster_keyword` как `BOOL_OR` поверх уже агрегированного bucket** — не работает
  (почти всегда `TRUE`, т.к. в топ-3/5/10 обычно попадает хотя бы один трекаемый запрос).
  Правильно — разводить `mode` как отдельное измерение **до** агрегации (см. `buckets` CTE
  в `v_gsc_requests_kpi`), а не постфактум флагом.
- Джойн `totals`/`pivoted` по `project_name`/`cluster_topvisor_name` — через
  `IS NOT DISTINCT FROM`, не `=`, потому что эти поля бывают `NULL` (страница вне TopVisor-
  структуры), а обычный `=` с `NULL` всегда даёт `NULL`.
