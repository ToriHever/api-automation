// scripts/auth-google.js
require('dotenv').config();
const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const GoogleAuthManager = require('../core/GoogleAuthManager');
const Logger = require('../core/Logger');
const open = require('open');

const logger = new Logger('google-auth-setup');

async function setupGoogleAuth() {
    const client = new OAuth2Client(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
    );

    const app = express();
    const authManager = new GoogleAuthManager();
    
    // Проверяем существующий refresh token
    if (await authManager.hasRefreshToken()) {
        logger.warn('Refresh token уже существует!');
        const answer = await prompt('Перезаписать существующий токен? (y/n): ');
        if (answer !== 'y') {
            process.exit(0);
        }
    }
    
       console.log('Redirect URI:', process.env.GOOGLE_REDIRECT_URI);

    // Генерируем URL авторизации
    const scopes = [
        process.env.GA4_SCOPES,
        process.env.GSC_SCOPES
    ].filter(Boolean).join(' ').split(' ');

    const authorizeUrl = client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
        prompt: 'consent' // Важно для получения refresh token
    });

    // Обработчик callback
    app.get('/auth/callback', async (req, res) => {
        const { code } = req.query;
        
        if (!code) {
            res.send('❌ Ошибка: код авторизации не получен');
            return;
        }

        try {
            // Обмениваем код на токены
            const { tokens } = await client.getToken(code);
            
            // Сохраняем refresh token
            await authManager.saveRefreshToken(tokens.refresh_token);
            
            res.send(`
                <html>
                    <body style="font-family: Arial; padding: 50px; text-align: center;">
                        <h1>✅ Авторизация успешна!</h1>
                        <p>Refresh token сохранен.</p>
                        <p>Теперь можете закрыть это окно и вернуться в терминал.</p>
                    </body>
                </html>
            `);
            
            logger.info('Авторизация завершена успешно');
            setTimeout(() => process.exit(0), 2000);
            
        } catch (error) {
            logger.error('Ошибка обмена кода на токен:', error);
            res.send('❌ Ошибка авторизации. Проверьте логи.');
        }
    });

    // Запускаем сервер
    const port = process.env.GOOGLE_AUTH_PORT || 3000;
    app.listen(port, () => {
        logger.info(`Сервер авторизации запущен на порту ${port}`);
        logger.info(`Открываю браузер для авторизации...`);
        open(authorizeUrl);
    });
}

setupGoogleAuth().catch(console.error);