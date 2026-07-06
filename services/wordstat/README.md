# 📊 WordStat Collector

Коллектор для автоматизированного сбора данных из Yandex Search API (Wordstat).

> ⚠️ **Важно**: в июле 2026 Yandex вывел из эксплуатации старый API `api.wordstat.yandex.net`.
> Сервис теперь работает через **Yandex Search API v2** (`searchapi.api.cloud.yandex.net`),
> часть платформы AI Studio / Yandex Cloud. Ниже — актуальная архитектура.

## 🎯 Методы сбора

### 1. **Динамика частотности (dynamics)**
- Сбор частотности ключевых слов по месяцам
- Данные за предыдущий полный месяц
- Пишет в таблицу `wordstat.tmp_dynamics`

### 2. **Связанные запросы (top)**
- Топ связанных запросов для каждого ключевого слова
- Данные актуальны на дату запуска
- Пишет в таблицу `wordstat.top_requests`
- Фразы хранятся в справочнике `common.wordstat_phrases`

## 📁 Структура сервиса

```
services/wordstat/
├── WordStatCollector.js       # Основной класс коллектора
├── config.json                # Конфигурация сервиса
├── schema.sql                 # SQL схема (таблицы, триггеры, очередь)
├── README.md                  # Этот файл
└── keywords/
    ├── dynamics_keywords.txt  # Ключи для метода dynamics
    └── top_keywords.txt       # Ключи для метода top
```

## 🔑 Авторизация (Yandex Cloud)

API работает через сервисный аккаунт Yandex Cloud с ролью `search-api.webSearch.user`
на каталоге, где он создан, плюс **привязанный активный платёжный аккаунт**
(без него все запросы падают с `403 Permission denied`, даже при верных ролях).

Добавьте в `.env`:
```bash
WORDSTAT_API_KEY=ваш_api_ключ
WORDSTAT_FOLDER_ID=b1g...        # ID каталога, где создан сервисный аккаунт
WORDSTAT_MAX_PER_RUN=80          # опционально, лимит запросов за 1 запуск (см. ниже про квоту)
```

Ключ и сервисный аккаунт удобнее всего создавать сразу через
[aistudio.yandex.ru](https://aistudio.yandex.ru) — мастер сам заведёт сервисный
аккаунт с нужной ролью при создании API-ключа.

## ⚙️ Квота API — самое важное ограничение

| Лимит | Значение |
|---|---|
| Запросов в секунду | 10 |
| **Запросов в час** | **100** |

Часовая квота — общая для функциональности Wordstat (`topRequests` + `dynamics`
делят один бюджет). Именно поэтому сервис устроен через **очередь с сохранением
прогресса в БД** — за один запуск обрабатывается не более `WORDSTAT_MAX_PER_RUN`
(по умолчанию 80, с запасом от 100) фраз, а не сколько угодно как раньше.

### Как работает очередь (`wordstat.collection_queue`)

1. При первом запуске для нового периода (новый месяц для `dynamics`, новый день
   для `top`) все фразы из `.txt`-файла добавляются в очередь со статусом `pending`.
2. Каждый запуск берёт из очереди до `WORDSTAT_MAX_PER_RUN` фраз (в приоритете —
   те, что ещё не пытались или пытались меньше раз), обрабатывает их с паузой
   между запросами, и помечает каждую `done` или `error`.
3. Фразы со статусом `error` автоматически попадают в следующую попытку
   (максимум 5 попыток), пока не закончится месяц/день сбора — временный сбой
   API не теряет фразу навсегда.
4. Когда все фразы периода получили статус `done` — сбор для этого периода
   считается завершённым, следующий запуск в это окно просто ничего не найдёт
   в очереди и завершится без действий.

Раньше при ошибке `429` код пытался повторить запрос **внутри того же запуска**
через 2 секунды — это приводило к зависанию, если причиной было исчерпание
именно часовой квоты (retry никогда не помогал в рамках того же часа). Сейчас
retry убран — фраза уходит в `error` и получает новую попытку только в
следующем часовом запуске.

### Расчёт периода для dynamics
Всегда собирается предыдущий полный месяц:
```
Запуск 1 января  → данные за декабрь
Запуск 1 февраля → данные за январь
```

## 🕐 Расписание (cron)

Поскольку часовая квота не позволяет собрать сотни фраз за один запуск,
сервис теперь запускается **каждый час в течение нескольких дней**, чтобы
очередь успела дособраться:

```bash
# WordStat top — с 1 по 2 число, каждый час с 8:00 до 20:00
0 8-20 1-2 * * cd /opt/api-automation && node scripts/run-service.js wordstat --method top >> logs/services/wordstat/daily_$(date +\%Y\%m\%d).log 2>&1

# WordStat dynamics — с 3 по 5 число, каждый час с 8:00 до 20:00
0 8-20 3-5 * * cd /opt/api-automation && node scripts/run-service.js wordstat --method dynamics >> logs/services/wordstat/daily_$(date +\%Y\%m\%d).log 2>&1
```

## 🚀 Запуск вручную

```bash
node scripts/run-service.js wordstat --method top
node scripts/run-service.js wordstat --method dynamics
node scripts/run-service.js wordstat --force
```

> Флаги `--start-date`/`--end-date` на `dynamics` больше не влияют — период
> для `dynamics` всегда вычисляется автоматически как предыдущий полный месяц
> (обязательное требование API: диапазон дат для месячной статистики должен
> точно совпадать с границами календарного месяца).

## 🗄️ Структура БД

### `wordstat.collection_queue`
Очередь сбора с сохранением прогресса между запусками.
```
id            serial     PK
method        varchar    'dynamics' | 'top'
phrase        text
period_start  date       для dynamics — первый день месяца
period_end    date       для dynamics — последний день месяца
check_date    date       для top — дата сбора
status        varchar    'pending' | 'done' | 'error'
attempts      int
last_error    text
created_at    timestamp
processed_at  timestamp
UNIQUE (method, phrase, period_start, period_end, check_date)
```

### `wordstat.tmp_dynamics`
Частотность запросов по месяцам.
```
request_id  smallint  FK → common.requests.request_id
group_id    smallint  cluster_topvisor_id из common.requests (может быть NULL)
month       date      Первое число месяца (YYYY-MM-01)
frequency   integer
created_at  timestamp
updated_at  timestamp
UNIQUE (request_id, month)
```

### `wordstat.top_requests`
Связанные запросы на дату проверки.
```
id                serial    PK
base_phrase_id    integer   FK → common.wordstat_phrases.id
related_phrase_id integer   FK → common.wordstat_phrases.id
count             integer
check_date        date
created_at        timestamp
updated_at        timestamp
UNIQUE (base_phrase_id, related_phrase_id, check_date)
```

### `common.wordstat_phrases`
Справочник фраз для метода top. Фразы уникальны.
```
id      serial  PK
phrase  text    UNIQUE
```

## 🔍 Полезные SQL запросы

### Статус текущей очереди
```sql
SELECT method, status, COUNT(*) 
FROM wordstat.collection_queue
GROUP BY method, status
ORDER BY method, status;
```

### Фразы, которые падают с ошибками несколько раз подряд
```sql
SELECT method, phrase, attempts, last_error, processed_at
FROM wordstat.collection_queue
WHERE status = 'error' AND attempts >= 3
ORDER BY attempts DESC;
```

### Динамика конкретного запроса за последние 12 месяцев
```sql
SELECT r.request, d.month, d.frequency
FROM wordstat.tmp_dynamics d
JOIN common.requests r ON d.request_id = r.request_id
WHERE r.request = 'ddos защита'
ORDER BY d.month DESC
LIMIT 12;
```

### Топ связанных фраз на сегодня
```sql
SELECT 
    bp.phrase AS base,
    rp.phrase AS related,
    t.count,
    t.check_date
FROM wordstat.top_requests t
JOIN common.wordstat_phrases bp ON t.base_phrase_id = bp.id
JOIN common.wordstat_phrases rp ON t.related_phrase_id = rp.id
WHERE t.check_date = CURRENT_DATE
ORDER BY t.count DESC
LIMIT 20;
```

## 🛠️ Управление ключевыми словами

Редактируйте `.txt` файлы в папке `keywords/` — изменения подхватятся
автоматически, но только для **нового** периода (нового месяца для dynamics,
нового дня для top). Если фраза добавлена в файл, когда очередь на текущий
период уже создана, она попадёт в сбор только со следующего периода.

Формат файла:
```
# Это комментарий — игнорируется
# Пустые строки тоже игнорируются

ddos защита
защита от ddos атак
```

## 🐛 Troubleshooting

### `403 Permission denied` (перечисляет folder/cloud/organization)
Почти всегда означает, что у облака нет активного платёжного аккаунта
(`ACTIVE`/`TRIAL_ACTIVE`), а не проблему с ролями IAM. Проверьте раздел
«Биллинг» в консоли Yandex Cloud.

### `429` с сообщением `wordstatRequestsPerHour.rate rate quota limit exceed`
Часовая квота (100 запросов) исчерпана — либо ручными тестами (curl, повторные
запуски), либо самим сбором. Подождите до начала следующего часа. Проверить
текущий прогресс можно SQL-запросом «Статус текущей очереди» выше — если там
есть `pending`, ждать не нужно, они дособерутся на следующем часовом cron.

### "to_date: invalid value ... Invalid time format"
Даты для API должны быть в RFC3339 (`2026-06-01T00:00:00Z`), а не просто
`YYYY-MM-DD`. Для `PERIOD_MONTHLY` `toDate` обязан быть последним днём месяца.

### "num_phrases: Value must be in the range of 1 to 2000"
В теле запроса `/topRequests` отсутствует или равно `0` поле `numPhrases`.

### "Пропуск dynamics — не найден в common.requests"
Запрос из `dynamics_keywords.txt` отсутствует в справочнике `common.requests`.
Добавьте вручную:
```sql
INSERT INTO common.requests (request) VALUES ('ваш запрос');
```

### "WORDSTAT_API_KEY и WORDSTAT_FOLDER_ID обязательны"
Проверьте `.env` — обе переменные обязательны при новой авторизации через
Yandex Search API. Старая `WORDSTAT_API_TOKEN` (Bearer-токен) больше не
используется.

## 📚 API

- Базовый URL: `https://searchapi.api.cloud.yandex.net/v2/wordstat`
- Endpoint dynamics: `POST /dynamics`
- Endpoint top: `POST /topRequests`
- Авторизация: заголовок `Authorization: Api-Key <ключ>`
- Документация: https://aistudio.yandex.ru/docs/ru/search-api/concepts/wordstat.html
- Квоты и лимиты: https://aistudio.yandex.ru/docs/ru/search-api/concepts/limits.html
```
