#!/bin/bash

# ЕЖЕНЕДЕЛЬНЫЙ БЭКАП VDS: БД PostgreSQL + .env/config + проект целиком.
# Локальные копии старше BACKUP_RETENTION_DAYS (по умолчанию 56 = 8 недель) удаляются.
# Если задан BACKUP_RCLONE_REMOTE — копия выгружается наружу (S3 / Яндекс Object Storage /
# любой remote rclone), там тоже чистятся файлы старше срока хранения.
#
# Cron (воскресенье 03:00):
#   0 3 * * 0 /opt/api-automation/cron/weekly-backup.sh >> /opt/api-automation/logs/system/backup.log 2>&1

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR" || exit 1

# .env НЕ source-им: в нём есть значения с | ; <> — shell их сломает. Берём только нужные ключи.
env_get() { grep -E "^$1=" "$PROJECT_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/[[:space:]]*#.*$//' -e 's/^["'\'']//' -e 's/["'\'']$//'; }
for k in PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID \
         BACKUP_DIR BACKUP_RETENTION_DAYS BACKUP_RCLONE_REMOTE; do
  [ -z "${!k:-}" ] && v="$(env_get "$k")" && [ -n "$v" ] && export "$k=$v"
done

# Папка бэкапов — ВНЕ проекта, иначе архив проекта тащил бы за собой прошлые бэкапы
BACKUP_DIR="${BACKUP_DIR:-/var/backups/api-automation}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-56}"
STAMP="$(date +%Y%m%d_%H%M)"

echo "🗄️  Бэкап VDS: $(date)"
echo "📁 Проект: $PROJECT_DIR → $BACKUP_DIR (хранение ${RETENTION_DAYS} дн.)"

notify() {
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] || return 0
  curl -s -m 15 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" --data-urlencode "text=$1" >/dev/null || true
}
FAILED=0
fail() { echo "❌ $1"; FAILED=1; }

umask 077
mkdir -p "$BACKUP_DIR" || { echo "❌ Не создать $BACKUP_DIR"; exit 1; }

# Пишем во временный файл и переименовываем только после успеха — оборванный бэкап
# не должен выглядеть как готовый (и не должен вытеснить старые при чистке).
finish() { # $1 tmp, $2 final
  if [ -s "$1" ]; then mv "$1" "$2" && echo "✅ $(basename "$2") ($(du -h "$2" | cut -f1))"
  else rm -f "$1"; return 1; fi
}

# 1) БД: custom-формат уже сжат, восстановление — pg_restore (можно частично, по схемам)
DB_FILE="$BACKUP_DIR/db_${STAMP}.dump"
if command -v pg_dump >/dev/null; then
  pg_dump -Fc -f "$DB_FILE.tmp" || rm -f "$DB_FILE.tmp"
  finish "$DB_FILE.tmp" "$DB_FILE" || fail "pg_dump не удался"
else
  fail "pg_dump не найден (apt install postgresql-client)"
fi

# 2) Секреты и настройки (права 600 из umask)
CFG_FILE="$BACKUP_DIR/config_${STAMP}.tar.gz"
CFG_ITEMS=()
for f in .env config tokens keys; do [ -e "$f" ] && CFG_ITEMS+=("$f"); done
tar -czf "$CFG_FILE.tmp" "${CFG_ITEMS[@]}" || rm -f "$CFG_FILE.tmp"
finish "$CFG_FILE.tmp" "$CFG_FILE" || fail "архив .env/config не создан"

# 3) Проект целиком (без node_modules, логов и самих бэкапов)
PRJ_FILE="$BACKUP_DIR/project_${STAMP}.tar.gz"
tar -czf "$PRJ_FILE.tmp" --exclude=node_modules --exclude=logs --exclude=backups \
    -C "$(dirname "$PROJECT_DIR")" "$(basename "$PROJECT_DIR")" || rm -f "$PRJ_FILE.tmp"
finish "$PRJ_FILE.tmp" "$PRJ_FILE" || fail "архив проекта не создан"

# 4) Ротация: чистим только наши файлы по маске, и только если этот запуск успешен —
# иначе при серии сбоев можно остаться вообще без копий.
if [ "$FAILED" -eq 0 ]; then
  find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'db_*.dump' -o -name 'config_*.tar.gz' -o -name 'project_*.tar.gz' -o -name '*.tmp' \) \
    -mtime +"$RETENTION_DAYS" -print -delete | sed 's/^/🧹 удалён /'
else
  echo "⚠️ Ротация пропущена: бэкап завершился с ошибками"
fi

# 5) Выгрузка наружу (локальная копия без внешней не спасёт при потере VDS)
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  if command -v rclone >/dev/null; then
    rclone copy "$BACKUP_DIR" "$BACKUP_RCLONE_REMOTE" --include "*_${STAMP}.*" \
      && echo "☁️  Выгружено в $BACKUP_RCLONE_REMOTE" || fail "rclone copy не удался"
    [ "$FAILED" -eq 0 ] && rclone delete "$BACKUP_RCLONE_REMOTE" --min-age "${RETENTION_DAYS}d" \
      --include "db_*.dump" --include "config_*.tar.gz" --include "project_*.tar.gz" || true
  else
    fail "BACKUP_RCLONE_REMOTE задан, но rclone не установлен"
  fi
else
  echo "ℹ️  BACKUP_RCLONE_REMOTE не задан — внешняя копия не делается"
fi

if [ "$FAILED" -ne 0 ]; then
  notify "❌ Бэкап VDS завершился с ошибками ($(hostname), $(date +%F)). См. logs/system/backup.log"
  exit 1
fi
echo "✅ Бэкап завершён: $(date)"
