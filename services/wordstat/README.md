# 📊 WordStat Collector

Коллектор для автоматизированного сбора данных из Яндекс.Wordstat API.

## 🎯 Возможности

### 1. **Динамика частотности (dynamics)**
- Сбор частотности ключевых слов по месяцам
- Исторические данные для анализа трендов
- Автоматический запуск 1-го числа месяца

### 2. **Связанные запросы (topRequests)**
- Топ связанных запросов для каждого ключевого слова
- Ассоциированные запросы
- Ежедневное обновление данных

## 📁 Структура сервиса

```
services/wordstat/
├── WordStatCollector.js       # Основной класс коллектора
├── config.json                 # Конфигурация сервиса
├── schema.sql                  # SQL схема БД
├── README.md                   # Этот файл
└── keywords/                   # Папка с ключевыми словами
    ├── README.md               # Инструкции по управлению ключами
    ├── dynamics_keywords.txt   # Ключи для метода dynamics
    └── top_keywords.txt        # Ключи для метода topRequests
```

## 🚀 Быстрый старт

### 1. Настройка окружения

Добавьте в `.env`:
```bash
# WordStat API
WORDSTAT_API_TOKEN=your_yandex_direct_api_token_here
```

### 2. Активация сервиса

Отредактируйте `config/services.json`:
```json
{
  "wordstat": {
    "enabled": true,
    "schedule": "0 9 * * *",
    "priority": 2,
    "timeout": 300000,
    "retries": 2,
    "dateOffset": -31,
    "description": "Яндекс.Wordstat частотность запросов",
    "env_prefix": "WORDSTAT_"
  }
}
```

### 3. Добавление ключевых слов

Отредактируйте файлы в папке `keywords/`:

**dynamics_keywords.txt** (для отслеживания динамики):
```
купить квартиру москва
снять квартиру спб
аренда квартиры краснодар
```

**top_keywords.txt** (для анализа связанных запросов):
```
недвижимость
автомобили
туризм
```

### 4. Инициализация БД

Схема создастся автоматически при первом запуске, но можно запустить вручную:
```bash
psql -U youruser -d yourdb -f services/wordstat/schema.sql
```

### 5. Первый запуск

```bash
# Запуск обоих методов
node run-service.js wordstat

# Запуск только dynamics
node run-service.js wordstat --method dynamics

# Запуск только topRequests
node run-service.js wordstat --method top
```

## 📊 Использование

### Ручной запуск

```bash
# Обычный запуск (за период по умолчанию)
node run-service.js wordstat

# Ручной режим (с интерактивными вопросами)
node run-service.js wordstat --manual

# Принудительная перезапись существующих данных
node run-service.js wordstat --force
```

### Автоматический запуск через cron

Сервис настроен на автоматический запуск:
- **dynamics**: 1-го числа каждого месяца в 02:00
- **topRequests**: Ежедневно в 09:00

Настройка в `config.json`:
```json
{
  "methods": {
    "dynamics": {
      "schedule": "0 2 1 * *"
    },
    "topRequests": {
      "schedule": "0 9 * * *"
    }
  }
}
```

## 🗄️ Структура данных

### Таблицы

#### 1. **wordstat.check_keywords**
Справочник ключевых слов для проверки
```sql
id                 SERIAL PRIMARY KEY
keyword            VARCHAR(255) UNIQUE
check_dynamics     BOOLEAN
check_top_requests BOOLEAN
is_active          BOOLEAN
created_at         TIMESTAMP
updated_at         TIMESTAMP
```

#### 2. **wordstat.wordstat_dynamics**
История частотности по месяцам
```sql
id              SERIAL PRIMARY KEY
request_id      INTEGER FK → common.requests
event_date      DATE (последний день месяца)
base_frequency  INTEGER
created_at      TIMESTAMP
updated_at      TIMESTAMP
UNIQUE (request_id, event_date)
```

#### 3. **wordstat.top_requests**
Связанные запросы
```sql
id               SERIAL PRIMARY KEY
base_keyword_id  INTEGER FK → check_keywords
phrase           VARCHAR(255)
count            INTEGER
check_date       DATE
created_at       TIMESTAMP
updated_at       TIMESTAMP
UNIQUE (base_keyword_id, phrase, check_date)
```

#### 4. **wordstat.associations**
Ассоциированные запросы
```sql
id               SERIAL PRIMARY KEY
base_keyword_id  INTEGER FK → check_keywords
phrase           VARCHAR(255)
count            INTEGER
check_date       DATE
created_at       TIMESTAMP
updated_at       TIMESTAMP
UNIQUE (base_keyword_id, phrase, check_date)
```

## 📈 Аналитика

### Views для быстрого доступа к данным

#### 1. Динамика с изменениями
```sql
SELECT * FROM wordstat.v_dynamics_with_names
WHERE request = 'купить квартиру москва'
ORDER BY event_date DESC
LIMIT 12;
```

#### 2. Связанные запросы и ассоциации
```sql
SELECT * FROM wordstat.v_keyword_tree
WHERE base_keyword = 'недвижимость'
AND check_date = CURRENT_DATE
ORDER BY count DESC;
```

#### 3. Статистика по ключевым словам
```sql
SELECT * FROM wordstat.v_keywords_stats
WHERE is_active = TRUE
ORDER BY dynamics_months DESC;
```

### Полезные запросы

**Топ-10 запросов по росту частотности:**
```sql
SELECT 
    request,
    event_date,
    base_frequency,
    prev_frequency,
    frequency_change,
    ROUND(100.0 * frequency_change / NULLIF(prev_frequency, 0), 2) as growth_percent
FROM wordstat.v_dynamics_with_names
WHERE prev_frequency IS NOT NULL
ORDER BY frequency_change DESC
LIMIT 10;
```

**Связанные запросы с наибольшей частотностью:**
```sql
SELECT 
    base_keyword,
    phrase,
    count,
    check_date
FROM wordstat.v_keyword_tree
WHERE type = 'top_request'
AND check_date = CURRENT_DATE
ORDER BY count DESC
LIMIT 20;
```

**Сравнение частотности за последние 6 месяцев:**
```sql
SELECT 
    r.request,
    d.event_date,
    d.base_frequency
FROM wordstat.wordstat_dynamics d
JOIN common.requests r ON d.request_id = r.id
WHERE d.event_date >= CURRENT_DATE - INTERVAL '6 months'
ORDER BY r.request, d.event_date DESC;
```

## ⚙️ Конфигурация

### Rate Limiting
- **10 запросов в секунду** (100ms между запросами)
- **1000 запросов в день** (лимит API)

### Retry механизм
- **Максимум 5 попыток** при ошибках
- Обработка **429 Too Many Requests** (извлечение retry-after)
- Обработка **503 Service Unavailable** (экспоненциальная задержка)

### Таймауты
- **30 секунд** на один API запрос
- **300 секунд (5 минут)** на весь процесс сбора

## 🔍 Логирование

Логи сохраняются в:
```
logs/services/wordstat/debug.log
```

### Уровни логирования
- `info` - основная информация о процессе
- `warn` - предупреждения (дубликаты, ошибки API)
- `error` - критические ошибки
- `debug` - детальная информация для отладки

### Примеры логов

**Успешный запуск:**
```
[wordstat] Starting wordstat collector
[wordstat] Синхронизация ключевых слов из файлов в БД
[wordstat] Загружено 15 ключей из dynamics_keywords.txt
[wordstat] Синхронизировано: dynamics=15, topRequests=10
[wordstat] Запуск сбора данных dynamics
[wordstat] Сбор dynamics за период: 2025-08-01 - 2025-08-31
[wordstat] Найдено 15 ключей для dynamics
[wordstat] Получено 45 dynamics записей
[wordstat] Обработка 45 записей
[wordstat] wordstat collector completed successfully
```

## 🛠️ Управление ключевыми словами

### Через файлы (рекомендуемый способ)

1. Отредактируйте `.txt` файлы в папке `keywords/`
2. Запустите синхронизацию (происходит автоматически при запуске)

### Через SQL (прямое управление)

**Добавить новый ключ:**
```sql
INSERT INTO wordstat.check_keywords (keyword, check_dynamics, check_top_requests)
VALUES ('новый запрос', TRUE, TRUE);
```

**Отключить ключ:**
```sql
UPDATE wordstat.check_keywords 
SET is_active = FALSE 
WHERE keyword = 'старый запрос';
```

**Посмотреть активные ключи:**
```sql
SELECT keyword, check_dynamics, check_top_requests 
FROM wordstat.check_keywords 
WHERE is_active = TRUE
ORDER BY keyword;
```

## ⚠️ Важные замечания

### 1. Токен API
- Требуется токен Яндекс.Директ API
- Получить: https://oauth.yandex.ru/
- Права: `"apikey:manage"`

### 2. Лимиты API
- **10 запросов/сек** - соблюдается автоматически
- **1000 запросов/день** - отслеживается в коде
- При превышении лимита скрипт остановится

### 3. Даты для dynamics
- Всегда собираются данные за **прошлый полный месяц**
- Даты `startDate` и `endDate` игнорируются
- Запускать рекомендуется 1-2 числа месяца

### 4. Даты для topRequests
- Используется `startDate` как `check_date`
- Данные можно собирать ежедневно
- История сохраняется для анализа изменений

### 5. Дубликаты
- Используется `ON CONFLICT DO NOTHING` по умолчанию
- Для обновления используйте `--force`
- Уникальность гарантируется составными ключами

## 🐛 Troubleshooting

### Проблема: "Wordstat API недоступен"
**Решение:**
1. Проверьте токен в `.env`
2. Убедитесь, что токен не истёк
3. Проверьте права токена

### Проблема: "Достигнут дневной лимит запросов"
**Решение:**
1. Подождите до следующего дня
2. Уменьшите количество ключевых слов
3. Разделите проверку на несколько дней

### Проблема: "429 Too Many Requests"
**Решение:**
- Скрипт автоматически обработает и подождёт
- Если повторяется - проверьте другие скрипты, использующие API

### Проблема: "Не найден маппинг для request_id"
**Решение:**
1. Проверьте, что ключ существует в `common.requests`
2. Синхронизация должна создать запись автоматически
3. При необходимости добавьте вручную:
```sql
INSERT INTO common.requests (request) VALUES ('ваш ключ');
```

## 📚 Дополнительная информация

### Документация API
- [Яндекс.Директ API v5](https://yandex.ru/dev/direct/doc/dg/concepts/about.html)
- [Метод KeywordsResearch](https://yandex.ru/dev/direct/doc/dg/objects/keyword.html)

### Связанные сервисы
- TopVisor - позиции и ранжирование
- Google Analytics - веб-аналитика
- Google Search Console - поисковая аналитика

## 📧 Поддержка

При возникновении проблем:
1. Проверьте логи в `logs/services/wordstat/`
2. Убедитесь в корректности конфигурации
3. Проверьте доступность API
4. Свяжитесь с администратором системы