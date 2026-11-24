<!-- docs-db:generated -->
# Google Search Console

> Автоматически сгенерировано. Не редактировать вручную.

Таблиц: 3. Представлений: 1.

## Таблицы

### `gsc.page_totals_by_period`

Суммарные метрики Google Search Console по URL за период.

> Ограниченный режим: публикуются только структура и проверенные описания. Реальные значения и примеры запрещены.

#### Колонки

| # | Колонка | Тип | Допустимость | Атрибуты | По умолчанию | Описание |
|---:|---|---|---|---|---|---|
| 1 | `url` | `text` | NOT NULL | — | — | — |
| 2 | `period_label` | `text` | NOT NULL | — | — | — |
| 3 | `period_start` | `date` | NOT NULL | — | — | — |
| 4 | `period_end` | `date` | NOT NULL | — | — | — |
| 5 | `clicks` | `integer` | NOT NULL | — | — | — |
| 6 | `impressions` | `integer` | NOT NULL | — | — | — |
| 7 | `ctr` | `double precision` | NULL | — | — | — |
| 8 | `position` | `double precision` | NULL | — | — | — |
| 9 | `created_at` | `timestamp without time zone` | NULL | — | `CURRENT_TIMESTAMP` | — |
| 10 | `updated_at` | `timestamp without time zone` | NULL | — | `CURRENT_TIMESTAMP` | — |

#### Первичный ключ

`page_totals_by_period_pkey`: `url`, `period_label`

#### Индексы

| Имя | Тип | Уникальный | Колонки | Особенности |
|---|---|:---:|---|---|
| `page_totals_by_period_pkey` | `btree` | да | `url`, `period_label` | PRIMARY KEY |

### `gsc.search_console`

Метрики Google Search Console по поисковым запросам и страницам.

> Ограниченный режим: публикуются только структура и проверенные описания. Реальные значения и примеры запрещены.

#### Колонки

| # | Колонка | Тип | Допустимость | Атрибуты | По умолчанию | Описание |
|---:|---|---|---|---|---|---|
| 1 | `request` | `text` | NOT NULL | — | — | — |
| 2 | `target_url` | `integer` | NOT NULL | — | — | — |
| 3 | `clicks` | `integer` | NULL | — | — | — |
| 4 | `impressions` | `integer` | NULL | — | — | — |
| 5 | `ctr` | `numeric(5,4)` | NULL | — | — | — |
| 6 | `position` | `numeric(14,9)` | NULL | — | — | — |
| 7 | `event_date` | `date` | NOT NULL | — | — | — |
| 8 | `hub_id` | `smallint` | NULL | — | — | — |

#### Первичный ключ

`search_console_pkey`: `event_date`, `request`, `target_url`

#### Индексы

| Имя | Тип | Уникальный | Колонки | Особенности |
|---|---|:---:|---|---|
| `idx_search_console_date` | `btree` | нет | `event_date` | — |
| `idx_search_console_date_request` | `btree` | нет | `event_date`, `request` | — |
| `idx_search_console_request` | `btree` | нет | `request` | — |
| `idx_search_console_target_url` | `btree` | нет | `target_url` | — |
| `search_console_pkey` | `btree` | да | `event_date`, `request`, `target_url` | PRIMARY KEY |

### `gsc.top_queries_by_page`

Ограниченный набор поисковых запросов страницы за период.

> Ограниченный режим: публикуются только структура и проверенные описания. Реальные значения и примеры запрещены.

#### Колонки

| # | Колонка | Тип | Допустимость | Атрибуты | По умолчанию | Описание |
|---:|---|---|---|---|---|---|
| 1 | `url` | `text` | NOT NULL | — | — | — |
| 2 | `period_label` | `text` | NOT NULL | — | — | — |
| 3 | `period_start` | `date` | NOT NULL | — | — | — |
| 4 | `period_end` | `date` | NOT NULL | — | — | — |
| 5 | `rank` | `integer` | NOT NULL | — | — | — |
| 6 | `query` | `text` | NOT NULL | — | — | — |
| 7 | `clicks` | `integer` | NOT NULL | — | — | — |
| 8 | `impressions` | `integer` | NOT NULL | — | — | — |
| 9 | `ctr` | `double precision` | NULL | — | — | — |
| 10 | `position` | `double precision` | NULL | — | — | — |
| 11 | `created_at` | `timestamp without time zone` | NULL | — | `CURRENT_TIMESTAMP` | — |
| 12 | `updated_at` | `timestamp without time zone` | NULL | — | `CURRENT_TIMESTAMP` | — |
| 13 | `group_id` | `integer` | NULL | — | — | — |

#### Первичный ключ

`top_queries_by_page_pkey`: `url`, `period_label`, `query`

#### Внешние ключи

| Ограничение | Колонки | Ссылка | ON DELETE | ON UPDATE |
|---|---|---|---|---|
| `top_queries_by_page_group_id_fkey` | `group_id` | `common.request_groups` (`group_id`) | NO ACTION | NO ACTION |

#### Индексы

| Имя | Тип | Уникальный | Колонки | Особенности |
|---|---|:---:|---|---|
| `idx_top_queries_group` | `btree` | нет | `group_id` | — |
| `idx_top_queries_url_period` | `btree` | нет | `url`, `period_label`, `rank` | — |
| `top_queries_by_page_pkey` | `btree` | да | `url`, `period_label`, `query` | PRIMARY KEY |

## Представления

### `gsc.top3_queries_ctr`

Описание не задано.

> Ограниченный режим: публикуются только структура и проверенные описания. Реальные значения и примеры запрещены.

| # | Колонка | Тип | Описание |
|---:|---|---|---|
| 1 | `event_date` | `date` | — |
| 2 | `hub_id` | `smallint` | — |
| 3 | `request` | `text` | — |
| 4 | `target_url` | `integer` | — |
| 5 | `position` | `numeric(14,9)` | — |
| 6 | `ctr` | `numeric(5,4)` | — |
| 7 | `clicks` | `integer` | — |
| 8 | `impressions` | `integer` | — |
| 9 | `calculated_ctr` | `numeric` | — |

#### Зависимости

- `gsc.search_console`

## Диаграмма физических связей

```mermaid
erDiagram
  COMMON_REQUEST_GROUPS ||--o{ GSC_TOP_QUERIES_BY_PAGE : "group_id"
```

[Назад к навигации](index.md)
