#!/bin/bash

# УНИВЕРСАЛЬНЫЙ СКРИПТ ДЛЯ АВТОЗАПУСКА API КОЛЛЕКТОРОВ
# Автоматически определяет папку, откуда запускается

# Определение папки проекта (там, где находится этот скрипт)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "🚀 Запуск системы сбора данных API"
echo "👤 Пользователь: $(whoami)"
echo "📁 Папка проекта: $PROJECT_DIR"
echo "🕐 Время запуска: $(date)"

# Переход в папку проекта
cd "$PROJECT_DIR" || {
    echo "❌ ОШИБКА: Не удалось перейти в папку проекта"
    exit 1
}

# Настройка окружения
export NODE_ENV=production
export PATH="/usr/bin:/bin:/usr/local/bin:$PATH"

# Создание структуры папок логов если не существует
mkdir -p logs/services/{topvisor,wordstat,clarity,ga4,gsc,yandex-metrika,yandex-serp}
mkdir -p logs/system
mkdir -p logs/errors

# Проверка прав на запись в папку logs
if [ ! -w logs ]; then
    echo "❌ ОШИБКА: Нет прав на запись в папку logs"
    exit 1
fi

# Функция логирования
log_message() {
    echo "$(date '+%Y-%m-%d %H:%M:%S'): $1" >> logs/system/cron.log
}

# Проверка существования главного скрипта
if [ ! -f "scripts/run-service.js" ]; then
    echo "❌ ОШИБКА: Файл scripts/run-service.js не найден в $PROJECT_DIR"
    log_message "ERROR: scripts/run-service.js not found"
    exit 1
fi

# Проверка Node.js
if ! command -v node &> /dev/null; then
    echo "❌ ОШИБКА: Node.js не установлен или не найден в PATH"
    log_message "ERROR: Node.js not found"
    exit 1
fi

# Проверка зависимостей
if [ ! -d "node_modules" ]; then
    echo "❌ ОШИБКА: Папка node_modules не найдена. Запустите npm install"
    log_message "ERROR: node_modules not found"
    exit 1
fi

# Проверка .env файла
if [ ! -f ".env" ]; then
    echo "❌ ОШИБКА: Файл .env не найден"
    log_message "ERROR: .env file not found"
    exit 1
fi

# Определение сервиса для запуска (по умолчанию все активные)
SERVICE="${1:-}"
DATE_TODAY=$(date +%Y%m%d)
LOG_FILE="logs/system/daily_${DATE_TODAY}.log"

# Функция запуска с логированием
run_service() {
    local service="$1"
    local service_log="logs/services/$service/daily_${DATE_TODAY}.log"
    
    log_message "Starting $service collector from $PROJECT_DIR"
    
    if [ -n "$service" ]; then
        echo "🎯 Запуск сервиса: $service"
        node scripts/run-service.js "$service" >> "$service_log" 2>&1
    else
        echo "🎯 Запуск всех активных сервисов"
        node scripts/run-service.js >> "$LOG_FILE" 2>&1
    fi
    
    local exit_code=$?
    
    if [ $exit_code -eq 0 ]; then
        echo "✅ Сбор данных завершен успешно"
        log_message "Finished successfully${service:+ for $service}"
        return 0
    else
        echo "❌ Сбор данных завершен с ошибками (код: $exit_code)"
        log_message "Finished with errors${service:+ for $service} (exit code: $exit_code)"
        
        # Копируем ошибки в отдельный лог
        if [ -n "$service" ] && [ -f "$service_log" ]; then
            tail -n 50 "$service_log" >> "logs/errors/error_${DATE_TODAY}.log"
        elif [ -f "$LOG_FILE" ]; then
            tail -n 50 "$LOG_FILE" >> "logs/errors/error_${DATE_TODAY}.log"
        fi
        
        return $exit_code
    fi
}

# Запуск с обработкой ошибок
if run_service "$SERVICE"; then
    echo "🎉 Процесс завершен успешно"
    exit 0
else
    echo "💥 Процесс завершен с ошибками"
    exit 1
fi
