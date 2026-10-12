# 🔄 Google Updates Collector

Апдейты алгоритмов Google (core, spam, Discover и т.д.) из официального
[Search Status Dashboard](https://status.search.google.com/). Бесплатно, без ключа.

Источник — `https://status.search.google.com/incidents.json` (тот же набор данных
отдаётся в Atom: `https://status.search.google.com/en/feed.atom`). JSON выбран из-за
готовых полей `begin`/`end` и названия апдейта.

Пишет в две таблицы:
- `common.google_updates` — одна строка на апдейт (даты начала/конца раскатки, тип), см. [schema.sql](schema.sql).
- `common.notes` — лента событий Telegram-бота, категория **«Google Updates»**: два события на апдейт
  (начало раскатки на дату начала, завершение — на дату конца).

## Зачем две таблицы

Так же устроен `google-alerts`, у таблиц разные задачи:
- `common.google_updates` — данные для анализа. Структурированные даты начала и конца и тип апдейта
  позволяют соединять апдейты с `gsc.search_console` и считать клики до и после (пример внизу).
- `common.notes` — лента событий для Telegram-бота и аннотаций в DataLens. Это текст с датой и категорией,
  по ней ничего не посчитать.

Запись в `notes` необязательная для работы сервиса: если категории «Google Updates» нет, ошибка только
пишется в лог, а строка в `google_updates` всё равно сохраняется.

## Порядок развёртывания

```bash
psql "$DATABASE_URL" -f services/notes/schema.sql      # если notes-бот ещё не разворачивали
psql "$DATABASE_URL" -f services/google-updates/schema.sql
```

(Схема также применяется автоматически при каждом запуске коллектора.)

## 🚀 Запуск

```bash
npm run collect:google-updates
# или
node scripts/run-service.js google-updates
```

Первый запуск подтягивает всю историю, которую отдаёт фид (около 9 месяцев), и пишет
в `common.notes` событие «начало раскатки» по каждому апдейту датой начала.

## 🕐 Расписание (cron)

Раз в сутки, отдельная строка (сервис `enabled: false` в `config/services.json` — не входит в общий батч):

```bash
0 7 * * * cd /opt/api-automation && node scripts/run-service.js google-updates >> logs/services/google-updates/daily_$(date +\%Y\%m\%d).log 2>&1
```

## `.env` (всё опционально)

```bash
GOOGLE_UPDATES_SERVICES=Ranking          # какие сервисы дашборда брать, через запятую (по умолчанию Ranking)
GOOGLE_UPDATES_FEED_URL=                 # переопределить адрес фида
```

## Как это работает

- Запись считается «уже есть», только если поле `modified` инцидента не изменилось, иначе
  пропустили бы завершение раскатки (`end` появляется позже `begin`).
- При первом появлении апдейта пишется заметка «начало раскатки», при появлении `end` — заметка «раскатка завершена».
- `--force` перезаписывает поля, заметки не дублирует.
- `update_type` определяется по названию: `core`, `spam`, `discover`, `helpful_content`, `reviews`, `other`.

## Пример: совместить с GSC

```sql
SELECT u.title, u.begin_date, u.end_date,
       SUM(sc.clicks) FILTER (WHERE sc.event_date BETWEEN u.begin_date - 14 AND u.begin_date - 1) / 14.0 AS clicks_day_before,
       SUM(sc.clicks) FILTER (WHERE sc.event_date BETWEEN COALESCE(u.end_date, u.begin_date) + 1 AND COALESCE(u.end_date, u.begin_date) + 14) / 14.0 AS clicks_day_after
FROM common.google_updates u
JOIN gsc.search_console sc ON sc.event_date BETWEEN u.begin_date - 14 AND COALESCE(u.end_date, u.begin_date) + 14
JOIN common.site_map sm ON sm.id = sc.target_url AND sm.url ILIKE 'https://ddos-guard.ru%'
GROUP BY u.title, u.begin_date, u.end_date
ORDER BY u.begin_date;
```
