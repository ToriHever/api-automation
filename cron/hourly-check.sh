#!/bin/bash

# ПОЧАСОВЫЕ ПРОВЕРКИ СОСТОЯНИЯ СИСТЕМЫ

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR" || exit 1

# Тихая проверка здоровья системы
node scripts/health-check.js --silent >> logs/system/health_$(date +%Y%m%d).log 2>&1