# common.requests — справочник запросов

`common.requests` — центральная таблица-справочник поисковых запросов, на которую ссылаются
`topvisor.positions`, `wordstat.dynamics_range`/`dynamics_range_daily`, `common.requests_words`
(леммы), `common.request_urls` и несколько аналитических вью (`analytics.topvisor_group_kpi_monthly`,
`analytics.topvisor_relevance_visibility`, `analytics.v_serp_results`, `common.v_request_groups`,
`common.v_requests_lemmatized`, `wordstat.dynamics_summary`, `wordstat.dynamics_with_change`).

## Как наполняется

1. **`scripts/sync-gsc-requests.js`** — переносит новые тексты запросов из `gsc.search_console`
   в `common.requests` (идемпотентно, `ON CONFLICT (request) DO NOTHING`). До 2026-09-30 этого шага
   в пайплайне не было вообще — `GSCCollector.js` пишет только в `gsc.search_console`/`common.site_map`,
   ничего не добавляя в `common.requests`, из-за чего часть запросов из GSC никогда не попадала
   в справочник и, соответственно, не категоризировалась.
2. **`scripts/categorize-requests.js`** — прогоняет `services/common/data/2026-08_categorize_requests.sql`
   (автокатегоризация по словарю ключевых слов: `hub_id`/`cluster_id`/`topic_id`/`type_request_id`).
   Идемпотентно, трогает только строки с `NULL` в соответствующем поле — уже проставленные категории
   не перезаписывает.

Оба шага вызываются автоматически в `scripts/run-service.js` сразу после успешного сбора GSC
(сначала синк, потом категоризация; сбой любого из шагов не валит сам сбор — данные GSC к этому
моменту уже сохранены).

Разовый прогон вручную:
```bash
node scripts/sync-gsc-requests.js
node scripts/categorize-requests.js
```

## Известные грабли (на будущее)

- **`request_id` был `smallint`** (максимум 32767) вместе с бэкающей его последовательностью
  `requests_id_seq1` — упёрлись в лимит при первом запуске `sync-gsc-requests.js` 2026-09-30
  (в таблице на тот момент уже было ~61k запросов). Все таблицы с FK на `request_id`
  (`common.requests_words`, `wordstat.dynamics_range*`, `lemmatizer.*`, `topvisor.positions`)
  уже были объявлены как `integer` — расширение (`services/common/data/2026-09_widen_requests_id_seq.sql`)
  просто привело PK в соответствие с тем, что остальная схема и так ожидала.
- **Postgres не даёт `ALTER COLUMN TYPE`, пока есть зависимые вью.** У `request_id` их было 9.
  4 из них (`common.v_request_groups`, `common.v_requests_lemmatized`, `wordstat.dynamics_summary`,
  `wordstat.dynamics_with_change`) оказались "теневыми" — существовали только на сервере, не были
  отражены в репозитории (тот же паттерн, что и со схемой `analytics.*` — см. историю в
  `services/analytics/gsc-datalens-dashboards.md`). Миграция `2026-09_widen_requests_id_seq.sql`
  дропает все 9, меняет тип, пересоздаёт все 9 обратно один-в-один (определения сняты через
  `pg_get_viewdef` прямо с прод-базы, не по памяти) — заодно зафиксировала их в git.
- **FK на `request_id` в большинстве таблиц без `ON DELETE CASCADE`** (только у
  `common.requests_words` есть каскад). Значит `DELETE FROM common.requests` без явной проверки
  падает с `foreign key constraint`, если у запроса уже есть позиции/частоты в
  `topvisor.positions`/`wordstat.dynamics_range*`. При чистке (см. ниже) обязательно оборачивать
  условие в `NOT EXISTS` по всем таблицам без каскада, иначе либо ошибка, либо (что хуже) случайно
  включённый каскад сотрёт реальную историю трафика вместе с текстом запроса.
- **2026-09-30, разовая чистка**: после бэкфилла через `sync-gsc-requests.js` в `common.requests`
  добавилось ~16k новых запросов; ~14 435 из них (созданные в тот же день, без `hub_id`/`cluster_id`,
  без единой ссылки в `topvisor.positions`/`wordstat.dynamics_range*`/`common.request_urls`) были
  удалены как "мусор" — запросы, вообще не поддающиеся автокатегоризации и не привязанные ни к
  какой реальной активности. `topic_id` сознательно не учитывался как критерий (слишком общая
  категория, не показатель того, что запрос "определился"). Бэкап удалённых строк:
  `common.requests_deleted_backup_20260930`.
