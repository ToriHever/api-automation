# 📊 WordStat Collector

Коллектор для автоматизированного сбора данных из Яндекс.Wordstat API.

## 🎯 Методы сбора

### 1. **Динамика частотности (dynamics)**
- Сбор частотности ключевых слов по месяцам
- Данные за предыдущий полный месяц
- Автоматический запуск 1-го числа месяца
- Пишет в таблицу `wordstat.tmp_dynamics`

### 2. **Связанные запросы (top)**
- Топ связанных запросов для каждого ключевого слова
- Данные актуальны на дату запуска
- Ежедневное обновление данных
- Пишет в таблицу `wordstat.top_requests`
- Фразы хранятся в справочнике `common.wordstat_phrases`

## 📁 Структура сервиса

```
services/wordstat/
├── WordStatCollector.js       # Основной класс коллектора
├── config.json                # Конфигурация сервиса
├── schema.sql                 # SQL схема (триггеры)
├── README.md                  # Этот файл
└── keywords/
    ├── dynamics_keywords.txt  # Ключи для метода dynamics
    └── top_keywords.txt       # Ключи для метода top
```

## 🚀 Быстрый старт

### 1. Настройка окружения

Добавьте в `.env`:
```bash
WORDSTAT_API_TOKEN=your_token_here
```

### 2. Активация сервиса

В `config/services.json`:
```json
{
  "wordstat": {
    "enabled": true,
    "schedule": "0 9 1 * *",
    "priority": 2,
    "timeout": 300000,
    "retries": 2,
    "dateOffset": 0,
    "description": "Яндекс.Wordstat. Запускается 1-го числа каждого месяца",
    "env_prefix": "WORDSTAT_"
  }
}
```

### 3. Добавление ключевых слов

**`dynamics_keywords.txt`** — запросы для отслеживания частотности по месяцам:
```
# Комментарии начинаются с #
ddos защита
защита от ddos атак
антиддос
```

**`top_keywords.txt`** — запросы для сбора связанных фраз:
```
ddos guard
защита сайта от
защита сети ddos
```

## 📊 Запуск

### Оба метода (по умолчанию)
```bash
npm run collect:wordstat
```

### Только топ связанных запросов
```bash
npm run collect:wordstat:top
```

### Только динамика частотности
```bash
npm run collect:wordstat:dynamics
```

### Ручной запуск с датами
```bash
node scripts/run-service.js wordstat --start-date 2025-01-01 --end-date 2025-01-31
node scripts/run-service.js wordstat --method top
node scripts/run-service.js wordstat --method dynamics
node scripts/run-service.js wordstat --force
```

## 🗄️ Структура БД

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

### Связи
- `tmp_dynamics.request_id` → `common.requests.request_id`
- `tmp_dynamics.group_id` = `common.requests.cluster_topvisor_id`
- `top_requests.base_phrase_id` → `common.wordstat_phrases.id`
- `top_requests.related_phrase_id` → `common.wordstat_phrases.id`

> ⚠️ `top_requests` **не связан** с `common.requests`. Фразы живут отдельно в `common.wordstat_phrases`.

## ⚙️ Логика работы

### Метод dynamics
1. Читает ключи из `dynamics_keywords.txt`
2. Для каждого ключа ищет `request_id` в `common.requests` — если не найден, запись пропускается с предупреждением
3. Запрашивает `POST /v1/dynamics` за предыдущий полный месяц
4. Пишет в `wordstat.tmp_dynamics`

### Метод top
1. Читает ключи из `top_keywords.txt`
2. Запрашивает `POST /v1/topRequests` для каждого ключа
3. Все фразы (базовые и связанные) автоматически создаются в `common.wordstat_phrases` если не существуют
4. Пишет в `wordstat.top_requests`

### Расчёт периода для dynamics
Всегда собирается предыдущий полный месяц:
```
Запуск 1 января  → данные за декабрь
Запуск 1 февраля → данные за январь
Запуск 1 марта   → данные за февраль
```

## ⚙️ Rate Limiting
- Пакетная обработка по **10 запросов** параллельно
- Пауза **1 секунда** между пакетами
- При ошибке **429** — автоматический повтор через 2 секунды

## 🔍 Полезные SQL запросы

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

### Рост/падение частотности по месяцам
```sql
SELECT
    r.request,
    d.month,
    d.frequency,
    LAG(d.frequency) OVER (PARTITION BY d.request_id ORDER BY d.month) AS prev_frequency,
    d.frequency - LAG(d.frequency) OVER (PARTITION BY d.request_id ORDER BY d.month) AS change
FROM wordstat.tmp_dynamics d
JOIN common.requests r ON d.request_id = r.request_id
ORDER BY r.request, d.month DESC;
```

## 🛠️ Управление ключевыми словами

Редактируйте `.txt` файлы в папке `keywords/` — изменения подхватятся при следующем запуске автоматически.

Формат файла:
```
# Это комментарий — игнорируется
# Пустые строки тоже игнорируются

ddos защита
защита от ddos атак
```

> Если запрос из `dynamics_keywords.txt` отсутствует в `common.requests` — он будет пропущен с предупреждением в логах. Для метода `top` это не критично — фразы создаются автоматически.

## 🐛 Troubleshooting

### "WordStat API недоступен: 400"
Данные за запрашиваемый месяц ещё не готовы в Wordstat. Подождите несколько дней после начала месяца и запустите снова.

### "Пропуск dynamics — не найден в common.requests"
Запрос из `dynamics_keywords.txt` отсутствует в справочнике `common.requests`. Добавьте вручную:
```sql
INSERT INTO common.requests (request) VALUES ('ваш запрос');
```

### "WORDSTAT_API_TOKEN environment variable is required"
Добавьте токен в `.env`:
```bash
WORDSTAT_API_TOKEN=ваш_токен
```

### Проверка собранных данных
```sql
-- Dynamics: последние записи
SELECT r.request, d.month, d.frequency
FROM wordstat.tmp_dynamics d
JOIN common.requests r ON d.request_id = r.request_id
ORDER BY d.created_at DESC
LIMIT 10;

-- Top: последние записи
SELECT bp.phrase, rp.phrase, t.count, t.check_date
FROM wordstat.top_requests t
JOIN common.wordstat_phrases bp ON t.base_phrase_id = bp.id
JOIN common.wordstat_phrases rp ON t.related_phrase_id = rp.id
ORDER BY t.created_at DESC
LIMIT 10;
```

## 📚 API

- Endpoint dynamics: `POST https://api.wordstat.yandex.net/v1/dynamics`
- Endpoint top: `POST https://api.wordstat.yandex.net/v1/topRequests`
- Документация: https://yandex.ru/dev/direct/doc/