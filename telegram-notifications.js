// telegram-notifications.js - Модуль для отправки уведомлений в Telegram
import axios from 'axios';

/**
 * Отправка сообщения в Telegram
 * @param {string} message - Текст сообщения
 * @param {boolean} silent - Тихая отправка (без звука)
 */
export async function sendTelegramNotification(message, silent = false) {
    // Проверяем наличие необходимых переменных окружения
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
        console.log('⚠️ Telegram уведомления отключены (нет токена или chat_id)');
        return false;
    }

    try {
        const telegramApiUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
        
        const payload = {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML', // Поддержка HTML разметки
            disable_notification: silent
        };

        const response = await axios.post(telegramApiUrl, payload, {
            timeout: 10000 // 10 секунд таймаут
        });

        if (response.data.ok) {
            console.log('📱 Telegram уведомление отправлено');
            return true;
        } else {
            console.error('❌ Ошибка Telegram API:', response.data.description);
            return false;
        }

    } catch (error) {
        if (error.response) {
            console.error(`❌ Telegram API ошибка: ${error.response.status} - ${error.response.data?.description || error.response.statusText}`);
        } else {
            console.error(`❌ Ошибка отправки в Telegram: ${error.message}`);
        }
        return false;
    }
}

/**
 * Отправка уведомления о начале работы
 */
export async function sendStartNotification(dateRange) {
    const message = `
🚀 <b>Запуск сбора данных</b>
📅 Период: ${dateRange}
🕐 Время: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}
⏳ Выполняется...
    `.trim();

    return await sendTelegramNotification(message, true); // Тихо
}

/**
 * Отправка уведомления об успешном завершении
 */
export async function sendSuccessNotification(stats) {
    let projectStatsText = '';
    if (stats.projectStats && stats.projectStats.length > 0) {
        projectStatsText = '\n\n📈 По проектам:\n' + 
            stats.projectStats.map(p => `• ${p.name}: ${p.records} записей`).join('\n');
    }

    const message = `
✅ <b>Сбор данных завершен</b>
📅 Дата: ${stats.date}
📊 Записей добавлено: <code>${stats.totalRecords}</code>
⏱️ Время выполнения: ${stats.duration} сек.${projectStatsText}
    `.trim();

    return await sendTelegramNotification(message);
}

/**
 * Отправка уведомления об ошибке
 */
export async function sendErrorNotification(error, context) {
    const message = `
❌ <b>Ошибка сбора данных</b>
📅 Дата: ${context.date}
🕐 Время: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}

🔍 Ошибка: <code>${error.message}</code>
📍 Контекст: ${context.step || 'Неизвестно'}

⚠️ Требуется проверка логов
    `.trim();

    return await sendTelegramNotification(message);
}

/**
 * Отправка уведомления о пустых данных
 */
export async function sendEmptyDataNotification(dateRange) {
    const message = `
⚠️ <b>Нет данных для записи</b>
📅 Период: ${dateRange}
🕐 Время: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}

🔍 Возможные причины:
• API не возвращает данные за эту дату
• Нет ключевых слов для отслеживания
• Данные еще не обработаны в TopVisor

💡 Проверьте логи или попробуйте другую дату
    `.trim();

    return await sendTelegramNotification(message);
}

/**
 * Тестовая отправка для проверки настроек
 */
export async function sendTestNotification() {
    const message = `
🧪 <b>Тест Telegram уведомлений</b>
🕐 ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}

✅ Telegram бот настроен правильно!
📱 Уведомления будут приходить в этот чат.
    `.trim();

    return await sendTelegramNotification(message);
}