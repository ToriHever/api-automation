### 30.03.26
# Миграция site_map (март 2026)

## Проблема
GSC коллектор падал с ошибкой nextval: reached maximum value of sequence "site_map_id_seq" (32767). Справочник common.site_map разросся до лимита SMALLSERIAL из-за мусорных URL которые коллектор записывал без нормализации: параметры запросов (?tag=...&page=2), Google Text Fragments (#:~:text=...), дубли протоколов (http:// vs https://) и префиксов (/info/blog vs /blog). Вместо ожидаемых ~1000 URL сайта справочник содержал 32 767 записей.

## Что было сделано
Проведена контролируемая миграция с маппингом старых ID на новые:

Все URL нормализованы, справочник сжат с 32 767 до 618 уникальных записей
Тип колонки target_url в gsc.search_console изменён с SMALLINT на INTEGER (лимит увеличен с 32 767 до 2 147 483 647)
Старые ID обновлены на новые во всех связанных таблицах: gsc.search_console, common.products, topvisor.positions
Восстановлены все зависимые вьюхи: analytics.v_gsc_requests_daily, v_gsc_monthly, v_gsc_yearly, v_gsc_requests_agg, v_gsc_requests_brand, v_gsc_requests_brand_agg, gsc.top3_queries_ctr
Удалён сломанный триггер update_gsc_updated_at (ссылался на несуществующее поле updated_at)

## Почему сохранены CSV на сервере

url_mapping.csv и site_map_old.csv сохранены как страховка для 188 144 висячих записей в gsc.search_console — это данные за 2024-2025 год с target_url которых никогда не было в справочнике (историческая ошибка, существовавшая до миграции). Если в будущем потребуется восстановить URL для этих записей — маппинг и оригинальный справочник доступны в CSV.