// test-telegram.js - Тестирование Telegram уведомлений
import dotenv from 'dotenv';
import { 
    sendTestNotification,
    sendStartNotification, 
    sendSuccessNotification, 
    sendErrorNotification,
    sendEmptyDataNotification 
} from './telegram-notifications.js';

dotenv.config();

console.log('🧪 ТЕСТИРОВАНИЕ TELEGRAM УВЕДОМЛЕНИЙ');
console.log('=====================================\n');

// Проверка переменных окружения
console.log('1️⃣ Проверка настроек:');
if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.log('❌ TELEGRAM_BOT_TOKEN не установлен в .env');
    process.exit(1);
}

if (!process.env.TELEGRAM_CHAT_ID) {
    console.log('❌ TELEGRAM_CHAT_ID не установлен в .env');
    process.exit(1);
}

console.log('✅ TELEGRAM_BOT_TOKEN: установлен');
console.log('✅ TELEGRAM_CHAT_ID: установлен');
console.log('📱 Отправка тестовых сообщений...\n');

// Функция задержки
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Запуск тестов
async function runTests() {
    try {
        // Тест 1: Базовое тестовое сообщение
        console.log('📤 Тест 1: Базовое сообщение');
        const test1 = await sendTestNotification();
        console.log(test1 ? '✅ Успех' : '❌ Ошибка');
        await delay(2000);

        // Тест 2: Уведомление о начале работы
        console.log('📤 Тест 2: Уведомление о старте');
        const test2 = await sendStartNotification('2025-09-19 - 2025-09-19');
        console.log(test2 ? '✅ Успех' : '❌ Ошибка');
        await delay(2000);

        // Тест 3: Успешное завершение
        console.log('📤 Тест 3: Успешное завершение');
        const test3 = await sendSuccessNotification({
            date: '2025-09-19',
            totalRecords: 1247,
            duration: 45,
            projectStats: [
                { name: 'RU сайт', records: 423 },
                { name: 'EN сайт', records: 298 },
                { name: 'Блог', records: 312 },
                { name: 'Термины', records: 214 }
            ]
        });
        console.log(test3 ? '✅ Успех' : '❌ Ошибка');
        await delay(2000);

        // Тест 4: Ошибка
        console.log('📤 Тест 4: Уведомление об ошибке');
        const testError = new Error('Тестовая ошибка подключения');
        const test4 = await sendErrorNotification(testError, {
            date: '2025-09-19',
            step: 'API запрос',
            duration: 15
        });
        console.log(test4 ? '✅ Успех' : '❌ Ошибка');
        await delay(2000);

        // Тест 5: Пустые данные
        console.log('📤 Тест 5: Нет данных');
        const test5 = await sendEmptyDataNotification('2025-09-19 - 2025-09-19');
        console.log(test5 ? '✅ Успех' : '❌ Ошибка');

        console.log('\n🎉 Все тесты завершены!');
        console.log('💬 Проверьте ваш Telegram чат - должно прийти 5 сообщений');
        
        // Подсчет успешных тестов
        const results = [test1, test2, test3, test4, test5];
        const successCount = results.filter(r => r).length;
        
        console.log(`📊 Результат: ${successCount}/5 тестов прошли успешно`);
        
        if (successCount === 5) {
            console.log('✅ Telegram уведомления настроены корректно!');
        } else {
            console.log('⚠️ Есть проблемы с некоторыми уведомлениями');
        }

    } catch (error) {
        console.error('❌ Критическая ошибка при тестировании:', error.message);
    }
}

runTests();