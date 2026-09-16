# 🔍 Yandex SERP Collector

Собирает полную выдачу Yandex Search API (`/v2/web/search`, ТОП-N, включая
конкурентов) по фиксированному списку запросов — независимо от TopVisor.
Пишет в `yandex.serp_results` (см. [schema.sql](schema.sql)).

## Список запросов

`services/yandex-serp/keywords/target_keywords.txt` — один запрос на строку.
Строки с `#` — комментарии, игнорируются (как в Wordstat-файлах).

## Конфиг ([config.json](config.json))

- `maxKeywordsPerRun` — **жёсткий потолок без очереди**: [`loadKeywords()`](YandexSerpCollector.js)
  просто обрезает список до первых N строк (`slice(0, limit)`). Если фраз в
  файле больше — лишние молча никогда не соберутся, без ошибки и без лога.
  Держи это число ≥ количества строк в `target_keywords.txt`.
- `resultsPerQuery` — глубина выдачи, на которую проверяется позиция (20 по
  умолчанию — топ-20 достаточно для продуктовых/статейных запросов).
- `ownDomains` — домены, которые помечаются `is_own_domain = true` и
  резолвятся в `target_url_id` через `common.site_map`.

## 💰 Деньги — дороже Wordstat в ~24 раза за запрос

Метод «Дневные синхронные текстовые запросы» — **~0,485 ₽/запрос** по прайсу
(грант, который его покрывал, закончился 2026-09-02 — см. разбор биллинга в
истории чата). Для сравнения, Wordstat — ~0,02 ₽/запрос.

Формула: `запросов_в_списке × количество_запусков_в_месяц × 0,485 ₽`.

Поэтому сервис собирается **раз в неделю**, не ежедневно (`config/services.json`
→ `yandex-serp.enabled: false`, отдельная еженедельная cron-строка, НЕ общий
утренний батч вместе с topvisor/gsc).

## 🕐 Расписание (cron)

```bash
# Yandex SERP — раз в неделю, понедельник в 12:00
0 12 * * 1 cd /opt/api-automation && node scripts/run-service.js yandex-serp >> logs/services/yandex-serp/weekly_$(date +\%Y\%m\%d).log 2>&1
```

## 🚀 Запуск вручную

```bash
node scripts/run-service.js yandex-serp
```

## 📊 Данные для DataLens — `analytics.v_serp_results`

Вью в [`services/analytics/schema.sql`](../analytics/schema.sql) даёт два
независимых фильтра, оба **без привязки к TopVisor**:

- **`target_url`** — наш URL из `common.site_map` (тот же принцип, что у
  `gsc.search_console.target_url` / `topvisor.positions.relevant_url_id` —
  любая будущая site_map-таблица может выставить такой же `target_url` и
  делить этот фильтр в DataLens).
- **`group_name`** — из `common.requests.hub_id → common.hubs.hub_name`
  (хабы вроде `DDoS`/`Хостинг`/`VDS`/`WAF`), **не** `topvisor.dim_groups`.

Строки конкурентов (`is_own_domain = false`) в вью остаются, но у них
`target_url`/`group_name` = `NULL` — это ожидаемо.
