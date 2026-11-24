<!-- docs-db:generated -->
# Связи между объектами

> Автоматически сгенерировано. Не редактировать вручную.

Физических внешних ключей между разрешёнными таблицами: 41.

| Таблица | Ограничение | Колонки | Ссылается на | ON DELETE | ON UPDATE |
|---|---|---|---|---|---|
| `ai.cluster_competitor_summary` | `cluster_competitor_summary_cluster_id_fkey` | `cluster_id` | `ai.clusters` (`cluster_id`) | CASCADE | NO ACTION |
| `ai.cluster_competitor_summary` | `cluster_competitor_summary_run_id_fkey` | `run_id` | `ai.runs` (`run_id`) | NO ACTION | NO ACTION |
| `ai.cluster_members` | `cluster_members_cluster_id_fkey` | `cluster_id` | `ai.clusters` (`cluster_id`) | CASCADE | NO ACTION |
| `ai.cluster_members` | `cluster_members_request_id_fkey` | `request_id` | `common.requests` (`request_id`) | CASCADE | NO ACTION |
| `ai.clusters` | `clusters_head_request_id_fkey` | `head_request_id` | `common.requests` (`request_id`) | SET NULL | NO ACTION |
| `ai.clusters` | `clusters_run_id_fkey` | `run_id` | `ai.runs` (`run_id`) | CASCADE | NO ACTION |
| `ai.request_embeddings` | `request_embeddings_request_id_fkey` | `request_id` | `common.requests` (`request_id`) | CASCADE | NO ACTION |
| `ai.request_embeddings` | `request_embeddings_run_id_fkey` | `run_id` | `ai.runs` (`run_id`) | NO ACTION | NO ACTION |
| `ai.request_intent` | `request_intent_request_id_fkey` | `request_id` | `common.requests` (`request_id`) | CASCADE | NO ACTION |
| `ai.request_intent` | `request_intent_run_id_fkey` | `run_id` | `ai.runs` (`run_id`) | NO ACTION | NO ACTION |
| `ai.snippet_analysis` | `snippet_analysis_run_id_fkey` | `run_id` | `ai.runs` (`run_id`) | NO ACTION | NO ACTION |
| `ai.snippet_analysis` | `snippet_analysis_serp_result_id_fkey` | `serp_result_id` | `yandex.serp_results` (`id`) | CASCADE | NO ACTION |
| `common.notes` | `notes_category_id_fkey` | `category_id` | `common.notes_categories` (`category_id`) | NO ACTION | NO ACTION |
| `common.request_urls` | `request_urls_request_id_fkey` | `request_id` | `common.requests` (`request_id`) | NO ACTION | NO ACTION |
| `common.request_urls` | `request_urls_site_map_id_fkey` | `site_map_id` | `common.site_map` (`id`) | NO ACTION | NO ACTION |
| `common.requests_words` | `requests_words_request_id_fkey` | `request_id` | `common.requests` (`request_id`) | CASCADE | NO ACTION |
| `common.requests_words` | `requests_words_word_id_fkey` | `word_id` | `common.request_words` (`word_id`) | CASCADE | NO ACTION |
| `common.requests` | `fk_cluster_topvisor` | `cluster_topvisor_id` | `common.clusters_topvisor` (`cluster_topvisor_id`) | NO ACTION | NO ACTION |
| `common.requests` | `fk_hub` | `hub_id` | `common.hubs` (`hub_id`) | NO ACTION | NO ACTION |
| `common.requests` | `fk_requests_clusters` | `cluster_id` | `common.clusters` (`cluster_id`) | NO ACTION | NO ACTION |
| `common.requests` | `fk_type_request` | `type_request_id` | `common.type_request` (`type_request_id`) | NO ACTION | NO ACTION |
| `common.requests` | `requests_group_id_fkey` | `group_id` | `common.request_groups` (`group_id`) | NO ACTION | NO ACTION |
| `common.requests` | `requests_topic_id_fkey` | `topic_id` | `common.topics` (`topic_id`) | NO ACTION | NO ACTION |
| `ga4.web_vitals` | `web_vitals_target_url_fkey` | `target_url` | `common.site_map` (`id`) | NO ACTION | NO ACTION |
| `gsc.top_queries_by_page` | `top_queries_by_page_group_id_fkey` | `group_id` | `common.request_groups` (`group_id`) | NO ACTION | NO ACTION |
| `public.jira_issue_links` | `jira_issue_links_source_issue_key_fkey` | `source_issue_key` | `public.jira_issues` (`issue_key`) | CASCADE | NO ACTION |
| `reports.demand_phrases` | `demand_phrases_request_id_fkey` | `request_id` | `common.requests` (`request_id`) | NO ACTION | NO ACTION |
| `topvisor.dim_groups` | `dim_groups_project_id_fkey` | `project_id` | `topvisor.dim_projects` (`id`) | NO ACTION | NO ACTION |
| `topvisor.dim_keywords` | `dim_keywords_group_id_fkey` | `group_id` | `topvisor.dim_groups` (`id`) | NO ACTION | NO ACTION |
| `topvisor.dim_keywords` | `dim_keywords_project_id_fkey` | `project_id` | `topvisor.dim_projects` (`id`) | NO ACTION | NO ACTION |
| `topvisor.dim_project_regions` | `dim_project_regions_project_id_fkey` | `project_id` | `topvisor.dim_projects` (`id`) | NO ACTION | NO ACTION |
| `topvisor.dim_project_regions` | `dim_project_regions_searcher_id_fkey` | `searcher_id` | `topvisor.dim_searchers` (`id`) | NO ACTION | NO ACTION |
| `topvisor.positions` | `fk_positions_request` | `request_id` | `common.requests` (`request_id`) | SET NULL | NO ACTION |
| `topvisor.positions` | `fk_project_engine` | `project_engine_id` | `common.dim_projects_engines` (`id`) | NO ACTION | NO ACTION |
| `topvisor.positions` | `positions_relevant_url_id_fkey` | `relevant_url_id` | `common.site_map` (`id`) | NO ACTION | NO ACTION |
| `wordstat.check_list` | `check_list_request_id_fkey` | `request_id` | `common.requests` (`request_id`) | NO ACTION | NO ACTION |
| `wordstat.dynamics_range_daily` | `dynamics_range_daily_request_id_fkey` | `request_id` | `common.requests` (`request_id`) | NO ACTION | NO ACTION |
| `wordstat.dynamics_range` | `fk_dynamics_range_request` | `request_id` | `common.requests` (`request_id`) | NO ACTION | NO ACTION |
| `wordstat.top_requests` | `top_requests_base_phrase_id_fkey` | `base_phrase_id` | `common.wordstat_phrases` (`id`) | NO ACTION | NO ACTION |
| `wordstat.top_requests` | `top_requests_related_phrase_id_fkey` | `related_phrase_id` | `common.wordstat_phrases` (`id`) | NO ACTION | NO ACTION |
| `yandex.serp_results` | `serp_results_target_url_id_fkey` | `target_url_id` | `common.site_map` (`id`) | NO ACTION | NO ACTION |

## Логические связи

Ручные логические связи не заданы.

Mermaid-диаграммы разделены по доменам и находятся в соответствующих разделах.

[Назад к навигации](index.md)
