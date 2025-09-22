#!/bin/bash

# ЕЖЕНЕДЕЛЬНОЕ ОБСЛУЖИВАНИЕ СИСТЕМЫ

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR" || exit 1

echo "🔧 Еженедельное обслуживание системы"
echo "📁 Папка проекта: $PROJECT_DIR" 
echo "🕐 Время запуска: $(date)"

# Ротация логов старше 30 дней
find logs/ -name "*.log" -type f -mtime +30 -delete

# Очистка старых данных в БД (если нужно)
# node scripts/cleanup-old-data.js

# Создание бэкапов конфигов
cp config/*.json backups/config_backup_$(date +%Y%m%d)/

echo "✅ Обслуживание завершено"