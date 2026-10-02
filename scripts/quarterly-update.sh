#!/usr/bin/env bash
# Квартальное обновление данных и HTML-отчёта «Норма трафика SEO» (трафик, спрос, покупки).
#   bash scripts/quarterly-update.sh data      # шаги 1–4: сбор и пересчёт (кроме Wordstat, он идёт отдельно)
#   bash scripts/quarterly-update.sh wordstat  # шаг 2 отдельно: спрос (повторять раз в час, пока не скажет «собирать нечего»)
#   bash scripts/quarterly-update.sh report    # шаги 5–6: вью и сборка HTML
# Подробности и что делать руками: services/reports/README.md, раздел «Ежеквартальное обновление».
set -eo pipefail
cd "$(dirname "$0")/.."
unset YANDEX_METRIKA_COUNTER_ID          # иначе берётся счётчик по умолчанию, а не RU (см. README, «Проблемы» п. 8)

# psql берёт подключение из тех же PG* переменных, что и Node-скрипты (.env: PGHOST, PGUSER, PGPASSWORD, PGDATABASE, PGPORT)
load_pg() {
  [ -f .env ] || return 0
  local k v
  while IFS='=' read -r k v; do
    case "$k" in PGHOST|PGUSER|PGPASSWORD|PGDATABASE|PGPORT)
      v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
      export "$k=$v" ;;
    esac
  done < <(grep -E '^PG(HOST|USER|PASSWORD|DATABASE|PORT)=' .env)
}
load_pg
step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

case "${1:-}" in
  data)
    step "1. Трафик GA4 + Метрика (36 мес.) и органика по поисковикам"
    node scripts/traffic-history-36m.js --site ru      # только ru: норма по en не строится, а Метрика en отдаёт ошибку 400 на старых месяцах
    node scripts/traffic-organic-engines.js --site ru
    step "1b. Трафик по страницам входа (GA4; по желанию Метрика: убрать --source ga4)"
    node scripts/traffic-organic-landing.js --source ga4 --from 2025-07
    step "1c. Клиентский путь из GA4 по customer_id (регистрация, оплата, канал первого визита)"
    node scripts/ga4-customer-journey.js --from 2026-01
    step "1d. Состав Google-трафика по сегментам GSC"
    node scripts/gsc-segments-monthly.js
    step "3. Сезонные индексы: трафик, поисковики, спрос"
    node scripts/seasonality-index.js --series seo_traffic_ga4 --min-months 6
    node scripts/seasonality-index.js --series seo_traffic_metrika --min-months 6
    node scripts/seasonality-index.js --series engines --min-months 6
    node scripts/seasonality-index.js --series demand --min-months 6
    step "3b. Норма трафика и спроса"
    node scripts/seo-traffic-norm.js
    step "4. Покупки и KPI-диапазоны (CSV в services/reports/data/ должны быть обновлены!)"
    node scripts/purchases-kpi.js --apply
    ;;
  wordstat)
    step "2. Wordstat: частотность фраз спроса (лимит ~80 фраз за запуск, 100 запросов в час)"
    node scripts/wordstat-product-demand.js
    ;;
  report)
    step "5. Вью"
    psql -v ON_ERROR_STOP=1 -f services/reports/report_views.sql
    step "6. HTML-отчёт"
    cd reports/seo-norm-datalens
    psql -v ON_ERROR_STOP=1 -At -f queries.sql -o data.json
    node build.js --data data.json
    python3 ../gsc-datalens/tools/validate_page.py --strict dist/seo-norm-report.html
    echo "Готово: reports/seo-norm-datalens/dist/seo-norm-report.html"
    ;;
  *)
    echo "Использование: bash scripts/quarterly-update.sh data | wordstat | report" >&2
    exit 2
    ;;
esac
