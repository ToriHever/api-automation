#!/bin/bash

# ВЕЧЕРНИЙ ЗАПУСК КОЛЛЕКТОРОВ
# Может запускать другие сервисы или проверки

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "🌙 Вечерний запуск системы сбора данных API"
echo "📁 Папка проекта: $PROJECT_DIR"
echo "🕐 Время запуска: $(date)"

cd "$PROJECT_DIR" || exit 1

# Запуск определенных сервисов вечером (например, менее критичных)
# node scripts/run-service.js clarity
# node scripts/run-service.js yandex-metrika

# Или отправка дневного отчета
node scripts/send-daily-report.js >> logs/system/evening_$(date +%Y%m%d).log 2>&1