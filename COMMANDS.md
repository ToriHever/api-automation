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

## 📐 Норма трафика SEO (основа отчёта)
```bash
# Порядок: 1) трафик  2) сезонные индексы  3) норма  (спрос — после сбора Wordstat)
node scripts/traffic-history-36m.js
node scripts/traffic-organic-engines.js
node scripts/seasonality-index.js              # индексы; перед этим внести аномалии в reports.seasonality_events
node scripts/seo-traffic-norm.js --dry-run     # посмотреть норму и отклонения
node scripts/seo-traffic-norm.js               # записать в reports.seo_traffic_norm

# Состав Google-трафика по сегментам (бренд / продукты / информационные / прочее), GSC с 2025-09
node scripts/gsc-segments-monthly.js
```
**Формула:** норма в день = уровень × сезонный индекс месяца; норма за месяц = норма в день × дни месяца.
Уровень = среднее по последним N (`--level-months`, по умолчанию 12) пригодным месяцам значения в день, делённого на индекс.
Коридор = ± max(10%, 2 сигмы разброса пригодных месяцев). Статус месяца: `in_norm` / `below_norm` / `above_norm` / `no_actual` / `forecast` / `no_norm`.
В `reports.seo_traffic_norm` есть `expected_low/high`, `deviation_pct`, `confidence` (`normal` ≥2 сезонов, `low` 1 сезон, `fallback` индекс из Метрики, `none`) и `basis` (из чего сложена норма).
Будущие 12 месяцев (`--horizon`) содержат только норму.

**Что важно помнить при использовании в отчёте:**
- Норма зависит от списка аномальных месяцев (`reports.seasonality_events`). Апрель–сентябрь 2026 у ru — устойчивое падение органики (в основном Google, информационные страницы); чтобы оно не вошло в «норму», его нужно внести как `exclude` и запускать индексы с `--min-months 6`. Иначе норма будет занижена.
- Индексы посчитаны на 1–2 сезонах (данные с 2024-09-16, разделение ru/en) — норма ориентировочная. `confidence = low` там, где индекс по одному сезону.
- Для июля–августа у GA4 нет пригодных наблюдений (сбой GA4 30.07–17.08.2025, аномалия 2026) — индекс берётся из Метрики того же сайта (`confidence = fallback`).
- **Проверка надёжности:** норма не строится (и старые строки ряда удаляются), если уровень соседних сезонов различается больше чем на `--max-trend` (по умолчанию 20%) или коридор шире `--max-band` (35%). На данных 2026-09 так отфильтровываются все ряды en (тренд −21…−38%) и Яндекс ru по GA4 (+24%): индекс там описывает спад/рост, а не сезон. Обойти: `--force-unreliable` (тогда в выводе остаётся предупреждение).
- Состав по сегментам (`reports.v_gsc_segment_share`) — только для объяснения, а не норма. **Разрыв ряда:** между декабрём 2025 и январём 2026 брендовые клики в GSC выросли с ~1–2 до ~41 в день (доля бренда 2% -> 34%), без аналога в GA4 и Метрике, причина не выяснена. Сравнивать сегменты можно только внутри 2026 года (январь–сентябрь): там бренд стабилен (45–53/день), информационные страницы упали с ~83 до ~25–30/день, продуктовые с ~11 до ~5–6/день. В GSC до 2025-08 неполные данные.

## 🖥 Отчёт «Норма трафика SEO» для DataLens
```bash
psql "$DATABASE_URL" -f services/reports/report_views.sql      # вью reports.v_seo_norm_report / v_seo_norm_latest
cd reports/seo-norm-datalens
psql "$DATABASE_URL" -At -f queries.sql -o data.json           # данные из БД
node build.js --data data.json                                 # -> dist/seo-norm-report.html
python ../gsc-datalens/tools/validate_page.py --strict dist/seo-norm-report.html
```
Без `--data` собирается из `data.snapshot.json` (срез 2026-09-30, `node make-snapshot.js`). Итоги работы, выводы, проблемы и открытые вопросы — в [services/reports/README.md](services/reports/README.md).

## 🔎 Органика по поисковым системам (Яндекс / Google)
```bash
# Органический трафик по дням и поисковикам, ru и en, GA4 и Метрика -> reports.traffic_organic_engine (upsert)
node scripts/traffic-organic-engines.js
node scripts/traffic-organic-engines.js --source ga4 --site ru --months 24

# Сезонные индексы по каждому поисковику (seo_traffic_ga4_yandex / _google, seo_traffic_metrika_yandex / _google)
node scripts/seasonality-index.js --series engines --dry-run
```
GA4: канал Organic Search + `hostName` == домен, группировка `sessionSource`. Метрика: `lastTrafficSource=='organic'` + `startURLDomain`, группировка `lastSearchEngineRoot`.
Сырые названия сводятся к `Yandex` / `Google` / `Other`; в конце запуска скрипт печатает, какие сырые источники во что свелись (проверить, что в `Other` нет Яндекса/Google).
Нужно ли это: чтобы понять, чьё падение органики (например, ru с апреля 2026) — Яндекса или Google.

Год к году по поисковику:
```sql
SELECT a.source, a.site, a.engine, to_char(a.month, 'YYYY-MM') AS month, a.sessions,
       b.sessions AS prev_year, ROUND((a.sessions::numeric / NULLIF(b.sessions, 0) - 1) * 100) AS yoy_pct
FROM reports.v_organic_engine_monthly a
LEFT JOIN reports.v_organic_engine_monthly b
  ON b.source = a.source AND b.site = a.site AND b.engine = a.engine AND b.month = a.month - INTERVAL '1 year'
WHERE a.site = 'ru' AND a.month >= '2025-10-01' AND a.engine IN ('Yandex', 'Google')
ORDER BY a.source, a.engine, a.month;
```

## 📊 Сезонные индексы органического трафика (основа «Нормы трафика SEO»)
```bash
# Считает индексы по reports.traffic_daily, пишет в reports.seasonality_monthly и reports.seasonality_index
node scripts/seasonality-index.js

# Только посмотреть результат, ничего не записывая
node scripts/seasonality-index.js --dry-run

# Один ряд / сайт
node scripts/seasonality-index.js --series seo_traffic_ga4 --site ru
```
Данные берутся **с 2024-09-16** (`--from`): с этой даты сайты ru и en разделены, более ранние данные несопоставимы.
Ряды: `seo_traffic_ga4` (основной, канал `Organic Search`) и `seo_traffic_metrika` (для сверки, «Переходы из поисковых систем»).

Метод:
- **Сезон** = 12 месяцев подряд от первого полного месяца после `--from` (сейчас окт 2024 – сен 2025, окт 2025 – сен 2026 ...).
- **База сезона** = среднее по «общим» месяцам — тем, что полные и не аномальные во всех учитываемых сезонах.
- **Индекс месяца** = значение месяца / база его сезона; одноимённые месяцы усредняются по сезонам (1.00 = средний уровень).
- Месяц, которого нет в каком-то сезоне (ещё не наступил или аномальный), получает индекс по меньшему числу сезонов; `seasons_used = 1` — разовое наблюдение, а не среднее.

**Что НЕ входит в расчёт (явное правило, не менять молча):**
- всё до 2024-09-16 (разделение сайтов);
- текущий неполный месяц, первый неполный месяц периода и месяцы с пропусками дней в `traffic_daily`;
- сезоны, где меньше `--min-months` (по умолчанию 10) пригодных месяцев — статус `incomplete_season`;
- аномальные месяцы: автоматически (отклонение от медианы 2+2 соседних месяцев больше max(30% в ln, 3.5 робастных сигмы по MAD)) и по ручному списку `reports.seasonality_events`.

**Ряды спроса** (`demand_L3-4`, `demand_L7`, `demand_VDS`, `demand_DS`, `demand_Хостинг`, `demand_Главная`): сумма частотности Wordstat по фразам продукта
(`reports.v_demand_product_monthly`; фразы собирает `scripts/wordstat-product-demand.js`, привязка к продуктам из групп Топвизора в `reports.demand_phrases`).
Только ru (Wordstat — российский Яндекс). Разделение сайтов на спрос не влияет, поэтому `--from` к нему не применяется: берутся все собранные месяцы (с 2024-09), а сезоны получаются полными (сен 2024 – авг 2025, сен 2025 – авг 2026).
```bash
node scripts/wordstat-product-demand.js --dry-run   # сначала собрать спрос (лимит 80 фраз/запуск, квота 100/час)
node scripts/wordstat-product-demand.js
node scripts/seasonality-index.js --series demand
```
Если не все фразы продукта собраны, скрипт предупредит: «не собраны N из M фраз — спрос неполный».

**Расширение пула фразами из GSC** (`scripts/demand-pool-from-gsc.js`): GSC даёт словарь фраз, спрос по ним берётся из Wordstat за весь диапазон.
Фразы размечаются правилами: `ok` — в пул продукта, `attack` — в отдельный ряд `demand_Заказ атаки` (в сумму продуктов не входит; если фраза уже
была в пуле продукта, она там отключается), `skip` — не по теме (пентест, техподдержка и т.п.). Пул фиксируется: состав меняется только повторным запуском.
```bash
node scripts/demand-pool-from-gsc.js              # только показать разметку, ничего не пишет — просмотрите список
node scripts/demand-pool-from-gsc.js --apply      # записать в reports.demand_phrases (source = 'gsc')
node scripts/wordstat-product-demand.js           # собрать Wordstat по новым фразам (80/запуск, повторять раз в час)
node scripts/seasonality-index.js --series demand --min-months 6   # только после полного сбора
node scripts/seo-traffic-norm.js
```
Ручные решения по отдельным фразам — константа `OVERRIDES` в начале скрипта. Тесты разметки: `npm run test:demand-pool`.

Ограничение: за два сезона в индекс частично попадает тренд роста/падения между сезонами. Индекс станет надёжнее по мере добавления сезонов (смотреть `seasons_used`).

Ручной список — обычная таблица, код менять не нужно:
```sql
-- исключить месяц (site NULL = оба сайта)
INSERT INTO reports.seasonality_events (site, month_from, month_to, applies_to, action, description)
VALUES (NULL, '2025-03-01', '2025-03-01', 'traffic', 'exclude', 'Апдейт Яндекса');
-- оставить месяц, который авто-проверка ошибочно пометила аномальным
INSERT INTO reports.seasonality_events (site, month_from, month_to, applies_to, action, description)
VALUES ('ru', '2024-12-01', '2024-12-01', 'traffic', 'keep', 'Это реальный сезонный пик');
```
`applies_to`: `traffic` (по умолчанию), `demand` или `all` — событие в выдаче (апдейт, сбой) влияет на трафик, но не на спрос Wordstat.
После правки списка перезапустить скрипт. 
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




