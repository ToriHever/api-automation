// core/NotificationManager.js
const axios = require('axios');
const Logger = require('./Logger');

class NotificationManager {
    constructor() {
        this.logger = new Logger('notifications');
        this.botToken = process.env.TELEGRAM_BOT_TOKEN;
        this.chatId = process.env.TELEGRAM_CHAT_ID;
        this.enabled = !!(this.botToken && this.chatId);
        
        // Хранилище для сбора статусов всех сервисов
        this.dailyStats = new Map();
        
        if (!this.enabled) {
            this.logger.warn('Telegram notifications disabled - missing bot token or chat ID');
        }
    }

    /**
     * Отправка уведомления о старте сервиса
     */
    async sendStart(serviceName) {
        if (!this.enabled) return;

        const message = `🚀 <b>${serviceName.toUpperCase()}</b> запущен\n⏰ ${this.formatTime(new Date())}`;
        
        try {
            await this.sendMessage(message);
            this.logger.info(`Start notification sent for ${serviceName}`);
        } catch (error) {
            this.logger.error(`Failed to send start notification for ${serviceName}`, error);
        }
    }

    /**
     * Отправка уведомления об успешном завершении
     */
    async sendSuccess(serviceName, stats, executionTime) {
        if (!this.enabled) return;

        // Сохраняем статистику для итогового отчета
        this.dailyStats.set(serviceName, {
            status: 'success',
            stats,
            executionTime,
            timestamp: new Date()
        });

        const message = this.buildSuccessMessage(serviceName, stats, executionTime);
        
        try {
            await this.sendMessage(message);
            this.logger.info(`Success notification sent for ${serviceName}`);
        } catch (error) {
            this.logger.error(`Failed to send success notification for ${serviceName}`, error);
        }
    }

    /**
     * Отправка уведомления об ошибке
     */
    async sendError(serviceName, error, executionTime) {
        if (!this.enabled) return;

        // Сохраняем статистику для итогового отчета
        this.dailyStats.set(serviceName, {
            status: 'error',
            error: error.message,
            executionTime,
            timestamp: new Date()
        });

        const message = this.buildErrorMessage(serviceName, error, executionTime);
        
        try {
            await this.sendMessage(message);
            this.logger.info(`Error notification sent for ${serviceName}`);
        } catch (error) {
            this.logger.error(`Failed to send error notification for ${serviceName}`, error);
        }
    }

    /**
     * Отправка уведомления с предупреждениями
     */
    async sendWarning(serviceName, stats, warnings, executionTime) {
        if (!this.enabled) return;

        // Сохраняем статистику для итогового отчета
        this.dailyStats.set(serviceName, {
            status: 'warning',
            stats,
            warnings,
            executionTime,
            timestamp: new Date()
        });

        const message = this.buildWarningMessage(serviceName, stats, warnings, executionTime);
        
        try {
            await this.sendMessage(message);
            this.logger.info(`Warning notification sent for ${serviceName}`);
        } catch (error) {
            this.logger.error(`Failed to send warning notification for ${serviceName}`, error);
        }
    }

    /**
     * Отправка итогового дневного отчета
     */
    async sendDailyReport(date = new Date()) {
        if (!this.enabled || this.dailyStats.size === 0) return;

        const report = this.buildDailyReport(date);
        
        try {
            await this.sendMessage(report, { parse_mode: 'HTML' });
            this.logger.info('Daily report sent');
            
            // Очищаем статистику после отправки отчета
            this.dailyStats.clear();
        } catch (error) {
            this.logger.error('Failed to send daily report', error);
        }
    }

    /**
     * Построение сообщения об успехе
     */
    buildSuccessMessage(serviceName, stats, executionTime) {
        const emoji = '✅';
        let message = `${emoji} <b>${serviceName.toUpperCase()}</b> завершен\n`;
        
        if (stats.inserted > 0) {
            message += `📝 Записано: <b>${stats.inserted.toLocaleString()}</b>\n`;
        }
        
        if (stats.updated > 0) {
            message += `🔄 Обновлено: <b>${stats.updated.toLocaleString()}</b>\n`;
        }
        
        if (stats.processed > 0) {
            message += `📊 Обработано: <b>${stats.processed.toLocaleString()}</b>\n`;
        }
        
        if (stats.warnings && stats.warnings.length > 0) {
            message += `⚠️ Предупреждения: ${stats.warnings.length}\n`;
        }
        
        message += `⏱️ Время: ${this.formatDuration(executionTime)}`;
        
        return message;
    }

    /**
     * Построение сообщения об ошибке
     */
    buildErrorMessage(serviceName, error, executionTime) {
        let message = `❌ <b>${serviceName.toUpperCase()}</b> завершился с ошибкой\n`;
        message += `💥 Ошибка: <code>${error.message}</code>\n`;
        message += `⏱️ Время до ошибки: ${this.formatDuration(executionTime)}`;
        
        return message;
    }

    /**
     * Построение сообщения с предупреждениями
     */
    buildWarningMessage(serviceName, stats, warnings, executionTime) {
        let message = `⚠️ <b>${serviceName.toUpperCase()}</b> завершен с предупреждениями\n`;
        
        if (stats.inserted > 0) {
            message += `📝 Записано: <b>${stats.inserted.toLocaleString()}</b>\n`;
        }
        
        message += `🟡 Предупреждения:\n`;
        warnings.forEach(warning => {
            message += `  • ${warning}\n`;
        });
        
        message += `⏱️ Время: ${this.formatDuration(executionTime)}`;
        
        return message;
    }

    /**
     * Построение дневного отчета
     */
    buildDailyReport(date) {
        const dateStr = date.toLocaleDateString('ru-RU');
        let report = `📊 <b>ОТЧЕТ ЗА ${dateStr}</b>\n\n`;

        const successful = [];
        const warnings = [];
        const errors = [];
        let totalRecords = 0;
        let totalTime = 0;

        // Группируем результаты по статусам
        for (const [serviceName, data] of this.dailyStats) {
            totalTime += data.executionTime || 0;

            switch (data.status) {
                case 'success':
                    const records = (data.stats.inserted || 0) + (data.stats.updated || 0);
                    totalRecords += records;
                    successful.push(`• <b>${serviceName}</b>: ${records.toLocaleString()} записей`);
                    break;
                    
                case 'warning':
                    const warnRecords = (data.stats.inserted || 0) + (data.stats.updated || 0);
                    totalRecords += warnRecords;
                    const warnText = data.warnings ? ` (${data.warnings.join(', ')})` : '';
                    warnings.push(`• <b>${serviceName}</b>: ${warnRecords.toLocaleString()} записей${warnText}`);
                    break;
                    
                case 'error':
                    errors.push(`• <b>${serviceName}</b>: ${data.error}`);
                    break;
            }
        }

        // Формируем отчет
        if (successful.length > 0) {
            report += `🟢 <b>УСПЕШНО:</b>\n${successful.join('\n')}\n\n`;
        }

        if (warnings.length > 0) {
            report += `🟡 <b>С ПРЕДУПРЕЖДЕНИЯМИ:</b>\n${warnings.join('\n')}\n\n`;
        }

        if (errors.length > 0) {
            report += `🔴 <b>ОШИБКИ:</b>\n${errors.join('\n')}\n\n`;
        }

        // Итоговая статистика
        report += `📈 <b>ИТОГО:</b>\n`;
        report += `📝 Всего записей: <b>${totalRecords.toLocaleString()}</b>\n`;
        report += `⏱️ Общее время: <b>${this.formatDuration(totalTime)}</b>\n`;
        report += `🔧 Сервисов запущено: <b>${this.dailyStats.size}</b>\n\n`;

        // Информация о следующем запуске
        const tomorrow = new Date(date);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(8, 0, 0, 0);
        report += `⏰ Следующий запуск: <b>${tomorrow.toLocaleString('ru-RU')}</b>`;

        return report;
    }

    /**
     * Отправка сообщения в Telegram
     */
    async sendMessage(text, options = {}) {
        if (!this.enabled) return;

        const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
        
        const payload = {
            chat_id: this.chatId,
            text: text,
            parse_mode: options.parse_mode || 'HTML',
            disable_notification: options.silent || false
        };

        const response = await axios.post(url, payload);
        return response.data;
    }

    /**
     * Форматирование времени
     */
    formatTime(date) {
        return date.toLocaleTimeString('ru-RU', { 
            hour: '2-digit', 
            minute: '2-digit',
            second: '2-digit'
        });
    }

    /**
     * Форматирование продолжительности
     */
    formatDuration(seconds) {
        if (seconds < 60) {
            return `${seconds}с`;
        }
        
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        
        if (minutes < 60) {
            return remainingSeconds > 0 
                ? `${minutes}м ${remainingSeconds}с`
                : `${minutes}м`;
        }
        
        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;
        
        return remainingMinutes > 0
            ? `${hours}ч ${remainingMinutes}м`
            : `${hours}ч`;
    }

    /**
     * Отправка тестового сообщения
     */
    async sendTest() {
        if (!this.enabled) {
            throw new Error('Telegram notifications not configured');
        }

        const message = `🧪 <b>ТЕСТОВОЕ СООБЩЕНИЕ</b>\n⏰ ${this.formatTime(new Date())}\n✅ Уведомления работают корректно!`;
        
        try {
            await this.sendMessage(message);
            this.logger.info('Test notification sent successfully');
            return true;
        } catch (error) {
            this.logger.error('Failed to send test notification', error);
            throw error;
        }
    }
}

module.exports = NotificationManager;