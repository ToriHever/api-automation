# 📋 КОМАНДЫ УПРАВЛЕНИЯ
##🚀 Основные команды запуска
### Запуск отдельных сервисов
```bash
# Запуск конкретного сервиса (автоматический режим - вчерашний день)
node scripts/run-service.js topvisor
node scripts/run-service.js wordstat
node scripts/run-service.js clarity
node scripts/run-service.js ga4
node scripts/run-service.js gsc
node scripts/run-service.js yandex-metrika

# Запуск всех активных сервисов
node scripts/run-service.js
```

### Ручной режим с датами

```bash
# Запуск за конкретную дату
node scripts/run-service.js topvisor --start-date 2025-09-15 --end-date 2025-09-15

# Запуск за период
node scripts/run-service.js gsc --start-date 2025-09-01 --end-date 2025-09-15

# Ручной режим с флагом
node scripts/run-service.js topvisor --manual --start-date 2025-09-15 --end-date 2025-09-15
```

### Принудительная перезапись данных
```bash
# Перезаписать существующие данные
node scripts/run-service.js topvisor --force

# Ручной режим с перезаписью
node scripts/run-service.js topvisor --start-date 2025-09-15 --end-date 2025-09-15 --force
```
## 🔐 Авторизация Google

```bash
# Первичная авторизация Google (для GA4 и GSC)
node scripts/auth-google.js

# Тестирование авторизации
node tests/test-google-auth.js

```
## 🧪 Тестирование и диагностика
### Проверка подключений
```bash
# Универсальная диагностика сервиса
node utils/debug-universal.js topvisor
node utils/debug-universal.js gsc
node utils/debug-universal.js ga4

# Диагностика с конкретной датой
node utils/debug-universal.js topvisor 2025-09-15
```
### Тестирование интеграций
```bash
# Тест Google авторизации
node tests/test-google-auth.js

# Тест Telegram уведомлений
node tests/test-telegram.js

# Тест подключений к API (старый)
node tests/test-connections.js
```

## 📊 Мониторинг и отчеты
```bash
# Отправка дневного отчета
node scripts/send-daily-report.js

# Проверка здоровья системы
node scripts/health-check.js

# Тихая проверка здоровья
node scripts/health-check.js --silent
```

## 🗄️ Управление базой данных
```bash
# Миграция БД
node scripts/migrate-db.js

# Запуск всех сервисов (альтернативный скрипт)
node scripts/run-all.js

# Категоризация common.requests (cluster/topic/hub по ключевым словам).
# Идемпотентно — трогает только строки с NULL. Автоматически запускается
# после успешного сбора GSC (scripts/run-service.js).
npm run categorize
```

## 📈 Разовая выгрузка трафика GA4 + Яндекс.Метрика (36 мес.)
```bash
# Трафик по дням и каналам за 36 месяцев, отдельно ru (ddos-guard.ru) и en (ddos-guard.net),
# строго эти хосты без поддоменов. Пишет в reports.traffic_daily (схема создаётся сама,
# services/reports/schema.sql), повторный запуск = upsert без дублей.
node scripts/traffic-history-36m.js

# Только один источник / сайт / другой период
node scripts/traffic-history-36m.js --source ga4 --site ru
node scripts/traffic-history-36m.js --source metrika --months 12
```
Нужно в `.env`: `GA4_PROPERTY_ID`, `YANDEX_METRIKA_COUNTER_ID`, `YANDEX_METRIKA_TOKEN`
(OAuth со scope `metrika:read`). Если счётчики/property разные для ru и en — `*_RU` / `*_EN`.

Нюансы:
- `reports.traffic_daily.sessions`: GA4 sessions / Метрика visits; `engaged_sessions` только у GA4.
- `users` нельзя суммировать по каналам (один человек в нескольких каналах).
- Данные ru начинаются с ~середины 2024 (в GA4 и Метрике), en — с 2023-10. Периоды Метрики с `sampled=true` — оценки, округляются до целых.
- Если в оболочке сервера экспортирована переменная-заглушка (например `YANDEX_METRIKA_COUNTER_ID=your_counter_id`), `dotenv` не перезапишет её значением из `.env` — сделать `unset`.

## ⏰ Автоматизация через cron
### Прямой запуск bash-скриптов

```bash
# Утренний запуск
bash cron/daily-morning.sh

# Вечерний запуск
bash cron/daily-evening.sh

# Почасовая проверка
bash cron/hourly-check.sh

# Еженедельное обслуживание
bash cron/weekly-maintenance.sh

# Еженедельный бэкап VDS (БД + .env/config + проект), ротация 8 недель
bash cron/weekly-backup.sh
```

### Бэкап VDS
Еженедельно (вс 03:00, cron от **root**): БД + `.env`/config + проект → `/var/backups/api-automation`
и в Yandex Object Storage, ротация 8 недель. Установка, настройки бакета, восстановление
и грабли — в [cron/BACKUP.md](cron/BACKUP.md).

### Запуск конкретного сервиса через cron-скрипт
```bash
# Запуск конкретного сервиса
bash cron/daily-morning.sh topvisor
bash cron/daily-morning.sh gsc
```

## 🎯 Команды с переменными окружения
```bash
# Ручной режим через переменные окружения
MANUAL_MODE=true MANUAL_START_DATE=2025-09-15 MANUAL_END_DATE=2025-09-15 node scripts/run-service.js topvisor

# Принудительная перезапись через переменную
FORCE_OVERRIDE=true node scripts/run-service.js topvisor

# Комбинированный вариант
MANUAL_MODE=true MANUAL_START_DATE=2025-09-01 MANUAL_END_DATE=2025-09-15 FORCE_OVERRIDE=true node scripts/run-service.js gsc

# Обновление Google токенов перед запуском
GOOGLE_TOKEN_REFRESH_ON_START=true node scripts/run-service.js gsc
```

## 📝 Справочные команды
```bash
# Показать справку
node scripts/run-service.js --help
node scripts/run-service.js -h

# Посмотреть доступные сервисы и их статус
node scripts/run-service.js
```

## 🔧 NPM-скрипты (если настроены в package.json)
```bash
# Авторизация
npm run auth:google

# Запуск сервисов
npm run topvisor
npm run gsc
npm run ga4
npm run wordstat
npm run clarity
npm run yandex-metrika

# Запуск всех активных
npm run collect

# Тестирование
npm run test:auth
npm run test:telegram
npm run test:connections

# Диагностика
npm run debug:topvisor
npm run debug:gsc

# Отчеты
npm run report:daily
npm run health:check
```

## 📋 Примеры распространенных сценариев
### Ежедневный сбор данных
```bash
# Автоматический режим (вчерашний день)
node scripts/run-service.js
```

### Восстановление пропущенных данных
```bash
# За конкретный день с перезаписью
node scripts/run-service.js topvisor --start-date 2025-09-10 --end-date 2025-09-10 --force

# За период
node scripts/run-service.js gsc --start-date 2025-09-01 --end-date 2025-09-15
```
### Первичная настройка Google-сервисов
```bash
# 1. Авторизация
node scripts/auth-google.js

# 2. Проверка
node tests/test-google-auth.js

# 3. Первый запуск
node scripts/run-service.js gsc
```

### Диагностика проблем
```bash
# Проверка конкретного сервиса
node utils/debug-universal.js topvisor

# Проверка с датой
node utils/debug-universal.js gsc 2025-09-15

# Проверка авторизации
node tests/test-google-auth.js
```

## 🔄 Команды обслуживания
```bash
# Ротация логов (удаление старше 30 дней)
find logs/ -name "*.log" -type f -mtime +30 -delete

# Просмотр последних логов
tail -f logs/services/topvisor/daily_$(date +%Y%m%d).log
tail -f logs/system/cron.log

# Очистка всех логов
rm -rf logs/services/*/
rm -rf logs/system/*
rm -rf logs/errors/*
```




