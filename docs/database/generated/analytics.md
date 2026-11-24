<!-- docs-db:generated -->
# Аналитические объекты

> Автоматически сгенерировано. Не редактировать вручную.

Таблиц: 1. Представлений: 14.

## Таблицы

### `analytics.gsc_period_comparison`

Описание не задано.

#### Колонки

| # | Колонка | Тип | Допустимость | Атрибуты | По умолчанию | Описание |
|---:|---|---|---|---|---|---|
| 1 | `product_name` | `text` | NULL | — | — | — |
| 2 | `request` | `text` | NULL | — | — | — |
| 3 | `period` | `text` | NULL | — | — | — |
| 4 | `clicks` | `bigint` | NULL | — | — | — |
| 5 | `impressions` | `bigint` | NULL | — | — | — |
| 6 | `ctr` | `numeric` | NULL | — | — | — |
| 7 | `position` | `numeric` | NULL | — | — | — |
| 8 | `in_top3` | `integer` | NULL | — | — | — |
| 9 | `in_top5` | `integer` | NULL | — | — | — |
| 10 | `in_top10` | `integer` | NULL | — | — | — |

## Представления

### `analytics.topvisor_group_kpi_monthly`

Описание не задано.

| # | Колонка | Тип | Описание |
|---:|---|---|---|
| 1 | `event_month` | `date` | — |
| 2 | `group_name` | `text` | — |
| 3 | `project_name` | `character varying(100)` | — |
| 4 | `search_engine` | `character varying(50)` | — |
| 5 | `relevance_pct` | `numeric` | — |
| 6 | `visibility_pct` | `numeric` | — |
| 7 | `avg_position_relevant` | `numeric` | — |
| 8 | `avg_position_not_relevant` | `numeric` | — |

#### Зависимости

- `common.dim_projects_engines`
- `common.requests`
- `common.site_map`
- `topvisor.dim_groups`
- `topvisor.dim_keywords`
- `topvisor.positions`

### `analytics.topvisor_group_kpi_period`

Описание не задано.

| # | Колонка | Тип | Описание |
|---:|---|---|---|
| 1 | `period` | `text` | — |
| 2 | `group_name` | `text` | — |
| 3 | `project_name` | `character varying(100)` | — |
| 4 | `search_engine` | `character varying(50)` | — |
| 5 | `relevance_pct` | `numeric` | — |
| 6 | `visibility_pct` | `numeric` | — |
| 7 | `avg_position_relevant` | `numeric` | — |
| 8 | `avg_position_not_relevant` | `numeric` | — |

#### Зависимости

- `common.dim_projects_engines`
- `common.site_map`
- `topvisor.dim_groups`
- `topvisor.dim_keywords`
- `topvisor.positions`

### `analytics.topvisor_relevance_visibility`

Описание не задано.

| # | Колонка | Тип | Описание |
|---:|---|---|---|
| 1 | `event_date` | `date` | — |
| 2 | `event_month` | `date` | — |
| 3 | `group_name` | `text` | — |
| 4 | `target_url` | `text` | — |
| 5 | `project_name` | `character varying(100)` | — |
| 6 | `search_engine` | `character varying(50)` | — |
| 7 | `request` | `text` | — |
| 8 | `request_id` | `integer` | — |
| 9 | `position` | `integer` | — |
| 10 | `is_relevant` | `integer` | — |
| 11 | `frequency` | `integer` | — |
| 12 | `visibility_coefficient` | `integer` | — |

#### Зависимости

- `common.dim_projects_engines`
- `common.requests`
- `common.site_map`
- `topvisor.dim_groups`
- `topvisor.dim_keywords`
- `topvisor.positions`

### `analytics.v_ga4_web_vitals_daily`

Описание не задано.

| # | Колонка | Тип | Описание |
|---:|---|---|---|
| 1 | `event_date` | `date` | — |
| 2 | `metric_name` | `text` | — |
| 3 | `url` | `text` | — |
| 4 | `event_count` | `integer` | — |
| 5 | `metric_value` | `double precision` | — |
| 6 | `project_name` | `character varying(100)` | — |
| 7 | `cluster_topvisor_name` | `text` | — |
| 8 | `rating` | `text` | — |

#### Зависимости

- `common.dim_projects_engines`
- `common.site_map`
- `ga4.web_vitals`
- `topvisor.dim_groups`
- `topvisor.dim_keywords`
- `topvisor.dim_projects`

### `analytics.v_gsc_longtail_requests`

Описание не задано.

| # | Колонка | Тип | Описание |
|---:|---|---|---|
| 1 | `request` | `text` | — |
| 2 | `url` | `text` | — |
| 3 | `project_name` | `text` | — |
| 4 | `cluster_topvisor_name` | `text` | — |
| 5 | `site` | `text` | — |
| 6 | `is_cluster_keyword` | `boolean` | — |
| 7 | `word_count` | `integer` | — |
| 8 | `is_long_tail` | `boolean` | — |
| 9 | `clicks_current` | `bigint` | — |
| 10 | `clicks_prev` | `bigint` | — |
| 11 | `dyn_clicks_pct` | `numeric` | — |
| 12 | `impressions_current` | `bigint` | — |
| 13 | `impressions_prev` | `bigint` | — |
| 14 | `dyn_impressions_pct` | `numeric` | — |
| 15 | `ctr_current` | `numeric` | — |
| 16 | `ctr_prev` | `numeric` | — |
| 17 | `dyn_ctr_pct` | `numeric` | — |
| 18 | `position_current` | `numeric` | — |
| 19 | `position_prev` | `numeric` | — |
| 20 | `position_delta_abs` | `numeric` | — |

#### Зависимости

- `analytics.v_gsc_requests_daily`

### `analytics.v_gsc_monthly`

Описание не задано.

| # | Колонка | Тип | Описание |
|---:|---|---|---|
| 1 | `project_name` | `character varying(100)` | — |
| 2 | `cluster_topvisor_name` | `text` | — |
| 3 | `period_start` | `date` | — |
| 4 | `clicks` | `bigint` | — |
| 5 | `impressions` | `bigint` | — |
| 6 | `ctr` | `numeric` | — |
| 7 | `position` | `numeric` | — |
| 8 | `clicks_formatted` | `text` | — |
| 9 | `impressions_formatted` | `text` | — |
| 10 | `is_incomplete` | `boolean` | — |

#### Зависимости

- `common.dim_projects_engines`
- `common.site_map`
- `gsc.search_console`
- `topvisor.dim_groups`
- `topvisor.dim_keywords`
- `topvisor.dim_projects`

### `analytics.v_gsc_requests_agg`

Описание не задано.

| # | Колонка | Тип | Описание |
|---:|---|---|---|
| 1 | `request` | `text` | — |
| 2 | `period` | `text` | — |
| 3 | `clicks` | `bigint` | — |
| 4 | `impressions` | `bigint` | — |
| 5 | `ctr` | `numeric` | — |
| 6 | `position` | `numeric` | — |
| 7 | `in_top3` | `integer` | — |
| 8 | `in_top5` | `integer` | — |
| 9 | `in_top10` | `integer` | — |
| 10 | `project_name` | `text` | — |
| 11 | `cluster_topvisor_name` | `text` | — |
| 12 | `is_cluster_keyword` | `boolean` | — |

#### Зависимости

- `analytics.v_gsc_requests_daily`

### `analytics.v_gsc_requests_daily`

Описание не задано.

| # | Колонка | Тип | Описание |
|---:|---|---|---|
| 1 | `event_date` | `date` | — |
| 2 | `request` | `text` | — |
| 3 | `clicks` | `integer` | — |
| 4 | `impressions` | `integer` | — |
| 5 | `ctr` | `numeric` | — |
| 6 | `position` | `numeric` | — |
| 7 | `project_name` | `text` | — |
| 8 | `cluster_topvisor_name` | `text` | — |
| 9 | `is_cluster_keyword` | `boolean` | — |
| 10 | `is_brand` | `boolean` | — |
| 11 | `site` | `text` | — |
| 12 | `url` | `text` | — |

#### Зависимости

- `analytics.v_topvisor_group_target_urls`
- `analytics.v_topvisor_keyword_cluster_map`
- `common.brand_keywords`
- `common.site_map`
- `gsc.search_console`

### `analytics.v_gsc_requests_kpi`

Описание не задано.

| # | Колонка | Тип | Описание |
|---:|---|---|---|
| 1 | `project_name` | `text` | — |
| 2 | `cluster_topvisor_name` | `text` | — |
| 3 | `bucket` | `text` | — |
| 4 | `mode` | `text` | — |
| 5 | `requests_current` | `bigint` | — |
| 6 | `requests_prev` | `bigint` | — |
| 7 | `dyn_requests_pct` | `numeric` | — |
| 8 | `clicks_current` | `numeric` | — |
| 9 | `clicks_prev` | `numeric` | — |
| 10 | `dyn_clicks_pct` | `numeric` | — |
| 11 | `impressions_current` | `numeric` | — |
| 12 | `impressions_prev` | `numeric` | — |
| 13 | `dyn_impressions_pct` | `numeric` | — |
| 14 | `ctr_current` | `numeric` | — |
| 15 | `ctr_prev` | `numeric` | — |
| 16 | `dyn_ctr_pct` | `numeric` | — |
| 17 | `position_current` | `numeric` | — |
| 18 | `position_prev` | `numeric` | — |
| 19 | `dyn_position_pct` | `numeric` | — |
| 20 | `pct_of_total` | `numeric` | — |

#### Зависимости

- `analytics.v_gsc_requests_agg`

### `analytics.v_gsc_requests_kpi_brand`

Описание не задано.

| # | Колонка | Тип | Описание |
|---:|---|---|---|
| 1 | `site` | `text` | — |
| 2 | `bucket` | `text` | — |
| 3 | `requests_current` | `bigint` | — |
| 4 | `requests_prev` | `bigint` | — |
| 5 | `dyn_requests_pct` | `numeric` | — |
| 6 | `clicks_current` | `numeric` | — |
| 7 | `clicks_prev` | `numeric` | — |
| 8 | `dyn_clicks_pct` | `numeric` | — |
| 9 | `impressions_current` | `numeric` | — |
| 10 | `impressions_prev` | `numeric` | — |
| 11 | `dyn_impressions_pct` | `numeric` | — |
| 12 | `ctr_current` | `numeric` | — |
| 13 | `ctr_prev` | `numeric` | — |
| 14 | `dyn_ctr_pct` | `numeric` | — |
| 15 | `position_current` | `numeric` | — |
| 16 | `position_prev` | `numeric` | — |
| 17 | `dyn_position_pct` | `numeric` | — |
| 18 | `pct_of_total` | `numeric` | — |

#### Зависимости

- `analytics.v_gsc_requests_daily`

### `analytics.v_gsc_yearly`

Описание не задано.

| # | Колонка | Тип | Описание |
|---:|---|---|---|
| 1 | `project_name` | `character varying(100)` | — |
| 2 | `cluster_topvisor_name` | `text` | — |
| 3 | `period_start` | `date` | — |
| 4 | `clicks` | `bigint` | — |
| 5 | `impressions` | `bigint` | — |
| 6 | `ctr` | `numeric` | — |
| 7 | `position` | `numeric` | — |
| 8 | `clicks_formatted` | `text` | — |
| 9 | `impressions_formatted` | `text` | — |
| 10 | `is_incomplete` | `boolean` | — |

#### Зависимости

- `common.dim_projects_engines`
- `common.site_map`
- `gsc.search_console`
- `topvisor.dim_groups`
- `topvisor.dim_keywords`
- `topvisor.dim_projects`

### `analytics.v_serp_results`

Описание не задано.

| # | Колонка | Тип | Описание |
|---:|---|---|---|
| 1 | `event_date` | `date` | — |
| 2 | `request` | `text` | — |
| 3 | `search_type` | `text` | — |
| 4 | `overall_position` | `integer` | — |
| 5 | `group_position` | `integer` | — |
| 6 | `doc_position_in_group` | `integer` | — |
| 7 | `domain` | `text` | — |
| 8 | `result_url` | `text` | — |
| 9 | `title` | `text` | — |
| 10 | `is_own_domain` | `boolean` | — |
| 11 | `target_url_id` | `integer` | — |
| 12 | `target_url` | `text` | — |
| 13 | `request_id` | `integer` | — |
| 14 | `hub_id` | `smallint` | — |
| 15 | `group_name` | `text` | — |

#### Зависимости

- `common.hubs`
- `common.requests`
- `common.site_map`
- `yandex.serp_results`

### `analytics.v_topvisor_group_target_urls`

Описание не задано.

| # | Колонка | Тип | Описание |
|---:|---|---|---|
| 1 | `project_name` | `text` | — |
| 2 | `cluster_topvisor_name` | `text` | — |
| 3 | `url_norm` | `text` | — |

#### Зависимости

- `topvisor.dim_groups`
- `topvisor.dim_keywords`
- `topvisor.dim_projects`

### `analytics.v_topvisor_keyword_cluster_map`

Описание не задано.

| # | Колонка | Тип | Описание |
|---:|---|---|---|
| 1 | `request` | `text` | — |
| 2 | `cluster_topvisor_name` | `text` | — |
| 3 | `project_name` | `text` | — |

#### Зависимости

- `topvisor.dim_groups`
- `topvisor.dim_keywords`
- `topvisor.dim_projects`

## Диаграмма физических связей

Физические связи внешними ключами в этом домене не заданы.

[Назад к навигации](index.md)
