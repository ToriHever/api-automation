// tests/test-google-auth.js
require('dotenv').config();
const GoogleAuthManager = require('../core/GoogleAuthManager');  // Исправлен путь
const axios = require('axios');

async function testGoogleAuth() {
    console.log('🧪 Тест Google OAuth авторизации\n');
    
    const authManager = new GoogleAuthManager();
    
    try {
        // 1. Проверяем наличие refresh token
        console.log('1️⃣ Проверка refresh token...');
        const hasToken = await authManager.hasRefreshToken();
        
        if (!hasToken) {
            console.log('❌ Refresh token не найден!');
            console.log('👉 Выполните: npm run auth:google');
            return;
        }
        console.log('✅ Refresh token найден\n');
        
        // 2. Пробуем обновить access token
        console.log('2️⃣ Обновление access token...');
        const accessToken = await authManager.refreshAccessToken();
        console.log('✅ Access token получен');
        console.log(`   Токен: ${accessToken.substring(0, 20)}...`);
        console.log('');
        
        // 3. Делаем тестовый запрос к GSC API
        console.log('3️⃣ Тестовый запрос к Search Console API...');
        const headers = await authManager.getAuthHeaders();
        
        const response = await axios.get(
            `https://www.googleapis.com/webmasters/v3/sites`,
            { headers }
        );
        
        console.log('✅ API запрос успешен!');
        console.log('📊 Ваши сайты в Search Console:');
        
        if (response.data.siteEntry) {
            response.data.siteEntry.forEach(site => {
                console.log(`   - ${site.siteUrl}`);
            });
        } else {
            console.log('   Сайты не найдены');
        }
        
        console.log('\n✅ Все тесты пройдены успешно!');
        
    } catch (error) {
        console.error('\n❌ Ошибка:', error.message);
        
        if (error.message.includes('Refresh token не найден')) {
            console.log('\n📝 Инструкция:');
            console.log('1. Запустите: npm run auth:google');
            console.log('2. Войдите в Google аккаунт');
            console.log('3. Разрешите доступ');
            console.log('4. Запустите этот тест снова');
        }
    }
}

// Запуск теста
testGoogleAuth();