# 📡 Google Alerts Collector

Мониторинг упоминаний бренда/темы через RSS-фиды [Google Alerts](https://www.google.com/alerts),
почасовой сбор. Бесплатно — фиды публичные, без API-ключа.

Пишет в две таблицы:
- `common.google_alerts` — сырые упоминания (одна строка на статью/страницу), см. [schema.sql](schema.sql).
- `common.notes` — та же лента событий, что заполняет Telegram-бот ([services/notes](../notes)),
  категория **«Google Alerts»** (заведена автоматически в `schema.sql`).

## Настройка алертов

1. Зайди на [google.com/alerts](https://www.google.com/alerts), создай алерт по нужному запросу
   (например «DDoS-Guard» или конкретная фраза для мониторинга упоминаний).
2. В настройках алерта (⚙️ «Показать параметры») смени способ доставки на **«RSS-канал»**.
3. Справа появится иконка RSS — скопируй её ссылку вида
   `https://www.google.com/alerts/feeds/XXXXXXXXX/YYYYYYYYY`.
4. Повтори для всех нужных алертов.

## `.env`

```bash
GOOGLE_ALERTS_FEEDS=Упоминание DDoS|https://www.google.com/alerts/feeds/XXX/YYY;Упоминание бренда|https://www.google.com/alerts/feeds/XXX/ZZZ
GOOGLE_ALERTS_STOPWORDS=выборы,ЦИК,Госдума   # опционально, через запятую, регистр не важен
```

Формат `GOOGLE_ALERTS_FEEDS`: `Имя алерта|URL фида`, несколько алертов — через `;`.
`Имя алерта` идёт в `alert_name` (свободный текст, не справочник) и используется
как заголовок заметки, если в самом упоминании нет title.

## 🚀 Запуск

```bash
npm run collect:google-alerts
# или
node scripts/run-service.js google-alerts
```

## 🕐 Расписание (cron)

Почасово, отдельная строка (сервис `enabled: false` в `config/services.json` —
не входит в общий батч):

```bash
0 * * * * cd /opt/api-automation && node scripts/run-service.js google-alerts >> logs/services/google-alerts/hourly_$(date +\%Y\%m\%d).log 2>&1
```

## Как это работает

- `fetchData()` читает все фиды из `GOOGLE_ALERTS_FEEDS` через `rss-parser`.
- `validateRecord()` отсеивает записи без распознаваемого домена и те, где
  заголовок/сниппет содержит стоп-слово из `GOOGLE_ALERTS_STOPWORDS`.
- `recordExists()` проверяет дубли **по `entry_id` ИЛИ `url`** — если одна и
  та же статья попалась под двумя разными алертами (разные `entry_id`, тот
  же `url`), она не задублируется ни в `google_alerts`, ни в `notes`.
- `insertRecord()` сначала пишет сырую строку в `common.google_alerts`,
  затем отдельным запросом — заметку в `common.notes`. Если вторая вставка
  не удалась (например, категория `Google Alerts` ещё не заведена) — сырое
  упоминание всё равно останется сохранённым, ошибка просто логируется.

## Редирект-ссылки Google

Google иногда отдаёт в RSS не прямую ссылку на статью, а редирект вида
`google.com/url?...&url=<реальный_url>` — `resolveUrl()` разворачивает его
перед сохранением, так что в `url`/`domain` всегда конечный адрес, не Google.

## Устранение неполадок

### `GOOGLE_ALERTS_FEEDS не задан`
Проверь `.env` — формат строго `Имя|URL` через `;` между алертами, без
лишних пробелов вокруг `|`.

### `Категория "Google Alerts" не найдена в common.notes_categories`
`schema.sql` этого сервиса добавляет категорию, но **не создаёт** саму
таблицу `common.notes_categories` — она из `services/notes/schema.sql`.
Если notes-бот ещё не разворачивали на этой БД — примени его схему первой:
```bash
psql "$DATABASE_URL" -f services/notes/schema.sql
psql "$DATABASE_URL" -f services/google-alerts/schema.sql
```
