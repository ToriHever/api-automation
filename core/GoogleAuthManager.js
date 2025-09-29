// core/GoogleAuthManager.js
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const Logger = require('./Logger');

class GoogleAuthManager {
    constructor() {
        this.logger = new Logger('google-auth');
        this.refreshTokenPath = path.resolve(process.env.GOOGLE_REFRESH_TOKEN_PATH || './tokens/google-refresh.json');
        this.accessToken = null;
        this.tokenExpiryDate = null;
    }
    /**
     * Получить актуальный access token
     */
    async getAccessToken() {  // ← ДОБАВЬТЕ ЭТУ СТРОКУ
        // Всегда обновляем токен перед использованием
        if (process.env.GOOGLE_TOKEN_FORCE_REFRESH === 'true' || !this.accessToken || this.isTokenExpired()) {
            await this.refreshAccessToken();
        }
        return this.accessToken;
    }

    /**
     * Обновить access token через refresh token
     */
            async refreshAccessToken() {
            try {
                this.logger.info('Обновление Google access token...');
                
                const refreshData = await this.readRefreshToken();
                if (!refreshData || !refreshData.refresh_token) {
                    throw new Error('Refresh token не найден. Необходима первичная авторизация.');
                }
        
                const params = new URLSearchParams();
                console.log('================================');

                
                params.append('client_id', process.env.GOOGLE_CLIENT_ID);
                params.append('client_secret', process.env.GOOGLE_CLIENT_SECRET);
                params.append('refresh_token', refreshData.refresh_token);
                params.append('grant_type', 'refresh_token');
        
                const response = await axios.post('https://oauth2.googleapis.com/token', params, {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                });
        
                this.accessToken = response.data.access_token;
                this.tokenExpiryDate = Date.now() + (response.data.expires_in * 1000);
        
                this.logger.info('Access token успешно обновлен');
                
                if (process.env.GOOGLE_TOKEN_LOG_REFRESH === 'true') {
                    this.logger.debug(`Token expires at: ${new Date(this.tokenExpiryDate).toISOString()}`);
                }
        
                return this.accessToken;
        
            } catch (error) {
                // ДОБАВЛЯЕМ ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ
                if (error.response) {
                    this.logger.error('Детали ошибки от Google:', {
                        status: error.response.status,
                        statusText: error.response.statusText,
                        data: error.response.data
                    });
                    
                        console.log('=== ПОЛНАЯ ОШИБКА ОТ GOOGLE ===');
                         console.log(JSON.stringify(error.response.data, null, 2));
                        console.log('================================');
                    
                    // Специфические ошибки Google OAuth
                    if (error.response.data) {
                        const errorData = error.response.data;
                        if (errorData.error === 'invalid_client') {
                            throw new Error('Неверные Client ID или Client Secret в .env');
                        } else if (errorData.error === 'invalid_grant') {
                            throw new Error('Refresh token невалидный или отозван. Нужна повторная авторизация.');
                        }
                    }
                }
                
                this.logger.error('Ошибка обновления access token:', error);
                throw new Error(`Не удалось обновить Google access token: ${error.message}`);
            }
        }

    /**
     * Проверить истек ли токен
     */
    isTokenExpired() {
        if (!this.tokenExpiryDate) return true;
        const bufferTime = 60000; // 1 минута запас
        return Date.now() >= (this.tokenExpiryDate - bufferTime);
    }

    /**
     * Прочитать refresh token из файла
     */
    async readRefreshToken() {
        try {
            const data = await fs.readFile(this.refreshTokenPath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            this.logger.error('Ошибка чтения refresh token:', error);
            return null;
        }
    }

    /**
     * Сохранить refresh token (используется при первичной авторизации)
     */
    async saveRefreshToken(refreshToken) {
        try {
            const dir = path.dirname(this.refreshTokenPath);
            await fs.mkdir(dir, { recursive: true });
            
            await fs.writeFile(
                this.refreshTokenPath, 
                JSON.stringify({ 
                    refresh_token: refreshToken,
                    created_at: new Date().toISOString()
                }, null, 2)
            );
            
            this.logger.info('Refresh token сохранен');
        } catch (error) {
            this.logger.error('Ошибка сохранения refresh token:', error);
            throw error;
        }
    }

    /**
     * Проверить наличие refresh token
     */
    async hasRefreshToken() {
        try {
            await fs.access(this.refreshTokenPath);
            const data = await this.readRefreshToken();
            return !!(data && data.refresh_token);
        } catch {
            return false;
        }
    }

    /**
     * Получить заголовки для API запросов
     */
    async getAuthHeaders() {
        const token = await this.getAccessToken();
        return {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        };
    }
}

module.exports = GoogleAuthManager;