# 🚀 WordStat Collector - Быстрый старт

## Концепция работы

### ✅ Что изменилось:

1. **Внешний файл с запросами**: `services/wordstat/keywords/dynamics_keywords.txt`
   - Не зашито в код
   - Легко редактировать без изменения кода
   - Поддержка комментариев (строки с `#`)
   
2. **Автоматический расчет периода**: 
   - Запускается 1-го числа каждого месяца
   - Автоматически собирает данные за **предыдущий полный месяц**
   - Учитывает количество дней в месяце (28/29/30/31)

3. **Примеры**:
   ```
   Запуск 1 января   → Данные: 1-31 декабря (31 день)
   Запуск 1 февраля  → Данные: 1-31 января (31 день)
   Запуск 1 марта    → Данные: 1-28 февраля (28 дней, или 29 в високосный год)
   Запуск 1 апреля   → Данные: 1-31 марта (31 день)
   ```

## 📦 Установка (3 команды)

```bash
# 1. Запустить скрипт настройки
chmod +x scripts/setup-wordstat.sh
./scripts/setup-wordstat.sh

# 2. Добавить API токен в .env
echo "WORDSTAT_API_KEY=ваш_токен_здесь" >> .env

# 3. Добавить ваши запросы
nano services/wordstat/keywords/dynamics_keywords.txt
```

## 📝 Редактирование списка запросов

### Формат файла `dynamics_keywords.txt`:

```text
# Комментарии начинаются с #
# Каждый запрос с новой строки
# Пустые строки игнорируются

# Группа 1: Основные запросы
организатор распространения информации
ори организаторы распространения информации

# Группа 2: Защита
ddos защита
анализ защищенности

# Группа 3: Аналоги
cloudflare аналог
cloudflare российский аналог
```

### Как редактировать:

```bash
# Открыть файл в редакторе
nano services/wordstat/keywords/dynamics_keywords.txt

# Или использовать любой текстовый редактор
vim services/wordstat/keywords/dynamics_keywords.txt
code services/wordstat/keywords/dynamics_keywords.txt
```

## 🕐 Настройка автоматического запуска

### В `config/services.json`:

```json
{
  "wordstat": {
    "enabled": true,
    "schedule": "0 9 1 * *",
    "priority": 2,
    "timeout": 300000,
    "retries": 2,
    "dateOffset": 0,
    "description": "Запускается 1-го числа месяца в 09:00"
  }
}
```

### Расшифровка cron:

```
0 9 1 * *
│ │ │ │ │
│ │ │ │ └─── День недели (0-7, любой)
│ │ │ └───── Месяц (1-12, любой)
│ │ └─────── День месяца (1, первое число)
│ └───────── Час (9, 09:00)
└─────────── Минута (0)

Результат: Каждое 1-е число каждого месяца в 09:00
```

### Альтернативные варианты расписания:

```bash
# Каждое 1-е число в 09:00
"schedule": "0 9 1 * *"

# Каждое 1-е число в 02:00 (ночью)
"schedule": "0 2 1 * *"

# Каждое 2-е число в 10:00 (если 1-го выходной)
"schedule": "0 10 2 * *"

# Первый понедельник месяца в 09:00
"schedule": "0 9 1-7 * 1"
```

## 🔧 Настройка CRON на сервере

### Добавить в crontab:

```bash
# Открыть crontab
crontab -e

# Добавить строку (запуск 1-го числа в 09:00)
0 9 1 * * cd /opt/api-automation && /opt/api-automation/cron/wordstat-monthly.sh >> /opt/api-automation/logs/system/cron.log 2>&1
```

### Создать скрипт `cron/wordstat-monthly.sh`:

```bash
#!/bin/bash
# Ежемесячный запуск WordStat коллектора

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR" || exit 1

export NODE_ENV=production
export PATH="/usr/bin:/bin:/usr/local/bin:$PATH"

# Логируем запуск
echo "🚀 WordStat Monthly Run - $(date '+%Y-%m-%d %H:%M:%S')"

# Запускаем коллектор
node scripts/run-service.js wordstat

exit_code=$?

if [ $exit_code -eq 0 ]; then
    echo "✅ WordStat завершен успешно - $(date '+%Y-%m-%d %H:%M:%S')"
else
    echo "❌ WordStat завершен с ошибкой (код: $exit_code) - $(date '+%Y-%m-%d %H:%M:%S')"
fi

exit $exit_code
```

```bash
# Сделать исполняемым
chmod +x cron/wordstat-monthly.sh
```

## 🧪 Тестирование

### 1. Проверка подключения к API:

```bash
node utils/debug-universal.js wordstat
```

### 2. Тестовый запуск (автоматический период):

```bash
npm run collect:wordstat
```

Вывод будет таким:
```
🚀 WordStat Collector запущен
📅 Автоматический расчет периода: 2024-12-01 - 2024-12-31
📅 Предыдущий месяц: декабрь 2024
📅 Дней в месяце: 31
📝 Загружено 47 ключевых слов из файла
⚡ Режим быстрой обработки: до 10 запросов одновременно
```

### 3. Ручной запуск за свой период:

```bash
# За один месяц
node scripts/run-service.js wordstat \
  --start-date 2024-11-01 \
  --end-date 2024-11-30

# За несколько месяцев
node scripts/run-service.js wordstat \
  --start-date 2024-01-01 \
  --end-date 2024-12-31
```

### 4. Проверка данных в БД:

```sql
-- Сколько записей собрано
SELECT COUNT(*) FROM wordstat.tmp_dynamics;

-- Последние 10 записей
SELECT * FROM wordstat.tmp_dynamics 
ORDER BY created_at DESC 
LIMIT 10;

-- Статистика по месяцам
SELECT month, COUNT(*) as records, SUM(frequency) as total
FROM wordstat.tmp_dynamics
GROUP BY month
ORDER BY month DESC;
```

## 📊 Примеры SQL запросов

### Топ-10 запросов по частотности:

```sql
SELECT request, SUM(frequency) as total_freq
FROM wordstat.tmp_dynamics
GROUP BY request
ORDER BY total_freq DESC
LIMIT 10;
```

### Динамика конкретного запроса:

```sql
SELECT month, frequency
FROM wordstat.tmp_dynamics
WHERE request = 'ddos защита'
ORDER BY month;
```

### Рост/падение по месяцам:

```sql
WITH monthly_totals AS (
  SELECT 
    month,
    SUM(frequency) as total_freq,
    LAG(SUM(frequency)) OVER (ORDER BY month) as prev_freq
  FROM wordstat.tmp_dynamics
  GROUP BY month
)
SELECT 
  month,
  total_freq,
  prev_freq,
  ROUND(((total_freq - prev_freq) * 100.0 / NULLIF(prev_freq, 0)), 2) as growth_percent
FROM monthly_totals
ORDER BY month DESC;
```

## ⚠️ Важные замечания

### 1. Файл с запросами:

- ✅ **Можно редактировать в любое время** - следующий запуск подхватит изменения
- ✅ **Комментарии с `#`** - удобно группировать запросы
- ✅ **Пустые строки игнорируются** - можно оставлять для читаемости
- ❌ **НЕ коммитить в Git** - добавьте в `.gitignore` если содержит чувствительные данные

### 2. Автоматический период:

- ✅ **Всегда полный предыдущий месяц** - от 1-го до последнего числа
- ✅ **Учитывает високосные года** - февраль будет 28 или 29 дней
- ✅ **Учитывает разную длину месяцев** - 30 или 31 день
- ⚠️ **Не перезаписывает данные** - установите `FORCE_OVERRIDE=true` для перезаписи

### 3. Ограничения API:

- 📊 **10 запросов/секунду** - коллектор соблюдает автоматически
- ⏱️ **Пакетная обработка** - до 10 одновременных запросов
- 🔄 **Автоматические повторы** - при 429 ошибке

## 🆘 Решение проблем

### Ошибка: "Файл с ключевыми словами не найден"

```bash
# Создайте файл
touch services/wordstat/keywords/dynamics_keywords.txt

# Добавьте запросы
echo "ddos защита" >> services/wordstat/keywords/dynamics_keywords.txt
```

### Ошибка: "WORDSTAT_API_KEY не найден"

```bash
# Добавьте в .env
echo "WORDSTAT_API_KEY=ваш_токен" >> .env
```

### Ошибка: "API недоступен"

1. Проверьте валидность токена на https://oauth.yandex.ru/
2. Убедитесь, что токен не истёк
3. Проверьте доступ к api.wordstat.yandex.net

### Данные не записываются в БД

```sql
-- Проверьте существование схемы
SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'wordstat';

-- Если схемы нет, создайте
\i services/wordstat/schema.sql
```

## 📈 Мониторинг

### Telegram уведомления:

После каждого запуска вы получите сообщение:

```
✅ Сбор данных завершен
📅 Дата: 2024-12-01 - 2024-12-31
📊 Записей добавлено: 1,410
⏱️ Время выполнения: 147 сек.

📈 По запросам:
• Успешно: 47
• Ошибок: 0
```

### Логи:

```bash
# Все логи сервиса
tail -f logs/services/wordstat/debug.log

# Последние 100 строк
tail -n 100 logs/services/wordstat/debug.log
```

---

## ✅ Итоговый чеклист

- [ ] Установлен Node.js и PostgreSQL
- [ ] Создана структура папок (`./scripts/setup-wordstat.sh`)
- [ ] Получен API токен WordStat
- [ ] Добавлен `WORDSTAT_API_KEY` в `.env`
- [ ] Заполнен файл `dynamics_keywords.txt`
- [ ] Создана схема БД (`schema.sql`)
- [ ] Включен сервис в `config/services.json`
- [ ] Настроен cron для ежемесячного запуска
- [ ] Выполнен тестовый запуск
- [ ] Проверены данные в БД

---

**Готово!** 🎉 WordStat коллектор настроен и будет автоматически собирать данные каждое 1-е число месяца.