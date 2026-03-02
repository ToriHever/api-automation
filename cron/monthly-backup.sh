#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR" || exit 1

echo "💾 Запуск бэкапа БД - $(date)"

# Читаем только нужные переменные из .env
PGUSER=$(grep '^PGUSER=' .env | cut -d= -f2 | tr -d '\r')
PGDATABASE=$(grep '^PGDATABASE=' .env | cut -d= -f2 | tr -d '\r')
PGPORT=$(grep '^PGPORT=' .env | cut -d= -f2 | tr -d '\r')

BACKUP_DIR="$PROJECT_DIR/backups"
BACKUP_FILE="$BACKUP_DIR/backup_$(date +%Y%m%d).sql"

mkdir -p "$BACKUP_DIR"

echo "🔌 Подключение к БД: localhost:$PGPORT/$PGDATABASE"

pg_dump \
    -h localhost \
    -p $PGPORT \
    -U $PGUSER \
    -d $PGDATABASE \
    > "$BACKUP_FILE"

if [ $? -eq 0 ]; then
    gzip "$BACKUP_FILE"
    SIZE=$(du -sh "${BACKUP_FILE}.gz" | cut -f1)
    echo "✅ Бэкап сохранён: ${BACKUP_FILE}.gz (${SIZE})"

    # Удаляем бэкапы старше 3 месяцев
    find "$BACKUP_DIR" -name "backup_*.sql.gz" -mtime +90 -delete
    echo "🧹 Старые бэкапы очищены"
else
    rm -f "$BACKUP_FILE"
    echo "❌ Ошибка создания бэкапа"
    exit 1
fi