# 📁 СТРУКТУРА ПРОЕКТА АВТОМАТИЗАЦИИ API

```
/opt/api-automation/
├── 📁 config/                          # Конфигурации
│   ├── 📄 database.json                # Настройки БД для каждого сервиса
│   ├── 📄 schedules.json               # Расписания запуска скриптов
│   ├── 📄 telegram.json                # Настройки уведомлений Telegram
│   └── 📄 services.json                # Конфигурация всех сервисов
│
├── 📁 core/                            # Базовые модули системы
│   ├── 📄 BaseCollector.js             # Базовый класс для всех коллекторов
│   ├── 📄 DatabaseManager.js           # Менеджер подключений к БД
│   ├── 📄 Logger.js                    # Система логирования
│   ├── 📄 NotificationManager.js       # Менеджер уведомлений
│   ├── 📄 ScheduleManager.js           # Менеджер расписаний
│   └── 📄 StatusTracker.js             # Трекер статусов выполнения
│
├── 📁 services/                        # Коллекторы данных по сервисам
│   ├── 📁 wordstat/
│   │   ├── 📄 WordStatCollector.js     # Коллектор WordStat
│   │   ├── 📄 config.json              # Конфиг сервиса
│   │   └── 📄 schema.sql               # SQL схема для WordStat
│   │   keywords/
│   │     ├── dynamics_keywords.txt        # Ключи для метода dynamics
│   │     └── top_keywords.txt             # Ключи для метода topRequests
│   │
│   ├── 📁 clarity/
│   │   ├── 📄 ClarityCollector.js      # Коллектор Clarity
│   │   ├── 📄 config.json
│   │   └── 📄 schema.sql
│   │
│   ├── 📁 ga4/
│   │   ├── 📄 GA4Collector.js          # Коллектор Google Analytics 4
│   │   ├── 📄 config.json
│   │   └── 📄 schema.sql
│   │
│   ├── 📁 gsc/
│   │   ├── 📄 GSCCollector.js          # Коллектор Google Search Console
│   │   ├── 📄 config.json
│   │   └── 📄 schema.sql
│   │
│   ├── 📁 yandex-metrika/
│   │   ├── 📄 YandexMetrikaCollector.js
│   │   ├── 📄 config.json
│   │   └── 📄 schema.sql
│   │
│   └── 📁 topvisor/
│       ├── 📄 TopVisorCollector.js     # Коллектор TopVisor
│       ├── 📄 config.json
│       └── 📄 schema.sql
│
├── 📁 scripts/                         # Исполняемые скрипты
│   ├── 📄 run-all.js                   # Запуск всех коллекторов
│   ├── 📄 run-service.js               # Запуск конкретного сервиса
│   ├── 📄 health-check.js              # Проверка состояния системы
│   ├── 📄 migrate-db.js                # Миграции БД
│   └── 📄 send-daily-report.js         # Отправка дневного отчета
│
├── 📁 cron/                            # Скрипты для автоматизации
│   ├── 📄 daily-morning.sh             # Утренний запуск (08:00)
│   ├── 📄 daily-evening.sh             # Вечерний запуск (20:00)
│   ├── 📄 hourly-check.sh              # Почасовые проверки
│   └── 📄 weekly-maintenance.sh        # Еженедельное обслуживание
│
├── 📁 logs/                            # Логи системы
│   ├── 📁 services/                    # Логи по сервисам
│   │   ├── wordstat/
│   │   ├── clarity/
│   │   ├── ga4/
│   │   ├── gsc/
│   │   ├── yandex-metrika/
│   │   └── topvisor/
│   ├── 📁 system/                      # Системные логи
│   └── 📁 errors/                      # Логи ошибок
│
├── 📁 tests/                           # Тесты
│   ├── 📁 unit/                        # Юнит тесты
│   ├── 📁 integration/                 # Интеграционные тесты
│   ├── 📄 test-connections.js          # Тест подключений к API/БД
│   └── 📄 test-notifications.js        # Тест уведомлений
│
├── 📁 utils/                           # Утилиты
│   ├── 📄 dateHelper.js                # Помощники для работы с датами
│   ├── 📄 debug-universal.js           # Диагностика API 
│   ├── 📄 apiHelper.js                 # Помощники для API запросов
│   ├── 📄 dbHelper.js                  # Помощники для БД
│   └── 📄 validator.js                 # Валидаторы данных
│
├── 📁 monitoring/                      # Мониторинг и отчеты
│   ├── 📄 dashboard.js                 # Дашборд статусов
│   ├── 📄 report-generator.js          # Генератор отчетов
│   └── 📄 metrics-collector.js         # Сбор метрик производительности
│
├── 📁 backups/                         # Резервные копии конфигов
│   └── 📄 .gitkeep
│
├── 📄 .env                             # Переменные окружения
├── 📄 .env.example                     # Пример переменных окружения
├── 📄 package.json                     # Зависимости проекта
├── 📄 package-lock.json
├── 📄 README.md                        # Документация проекта
├── 📄 CHANGELOG.md                     # История изменений
└── 📄 docker-compose.yml               # Для контейнеризации (опционально)
```

## 🔧 КЛЮЧЕВЫЕ ОСОБЕННОСТИ АРХИТЕКТУРЫ

### 1. Модульность
- Каждый сервис в отдельной папке с собственной конфигурацией
- Базовые классы для переиспользования кода
- Единые интерфейсы для всех коллекторов

### 2. Конфигурационный подход
```json
// config/services.json
{
  "wordstat": {
    "enabled": true,
    "schedule": "0 8 * * *",
    "priority": 1,
    "timeout": 300000,
    "retries": 3
  },
  "topvisor": {
    "enabled": true,
    "schedule": "0 9 * * *", 
    "priority": 2,
    "timeout": 600000,
    "retries": 2
  }
}
```

### 3. Централизованное логирование
- Логи по сервисам и по типам
- Ротация логов
- Структурированные JSON логи для анализа

### 4. Умные уведомления в Telegram
```javascript
// Пример итогового сообщения
📊 ОТЧЕТ ЗА 22.09.2025

🟢 УСПЕШНО:
• WordStat: 1,247 записей
• TopVisor: 3,892 позиции  
• GA4: 156 метрик

🟡 С ПРЕДУПРЕЖДЕНИЯМИ:
• GSC: 2,134 записи (лимит API 85%)
• Clarity: 892 сессии (задержка 15мин)

🔴 ОШИБКИ:
• Яндекс.Метрика: API недоступен
• Время выполнения: 23мин

⏱️ Следующий запуск: завтра в 08:00
```

### 5. Масштабируемость
- Легкое добавление новых сервисов
- Гибкие расписания для каждого сервиса
- Возможность параллельного выполнения
- Приоритизация задач

### 6. Надежность
- Автоматические ретраи при ошибках
- Health checks системы
- Резервное копирование данных
- Мониторинг производительности

### 7. Удобство разработки
- Единые команды запуска
- Тесты для всех компонентов
- Подробная документация
- Контейнеризация для развертывания

## 🚀 КОМАНДЫ УПРАВЛЕНИЯ

```bash
# Запуск всех сервисов
npm run collect:all

# Запуск конкретного сервиса
npm run collect:wordstat
npm run collect:topvisor

# Тестирование до 
npm run test:connections
npm run test:all

# Тестирование для продакшена
# Нужно находится в дирректории /opt/api-automation/
node utils/debug-universal.js topvisor
node utils/debug-universal.js topvisor 2025-09-10

# Мониторинг
npm run dashboard
npm run health-check

# Отправка отчета
npm run report:daily
npm run report:weekly
```

Эта структура обеспечивает максимальную гибкость, надежность и возможности для масштабирования вашей системы автоматизации!
