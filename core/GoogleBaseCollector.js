// core/GoogleBaseCollector.js
const BaseCollector = require('./BaseCollector');
const GoogleAuthManager = require('./GoogleAuthManager');

class GoogleBaseCollector extends BaseCollector {
    constructor(serviceName) {
        super(serviceName);
        this.authManager = new GoogleAuthManager();
        this.accessToken = null;
    }

    /**
     * Переопределяем run для обновления токена
     */
    async run(options = {}) {
        try {
            // Проверяем наличие refresh token
            if (!await this.authManager.hasRefreshToken()) {
                throw new Error(`Требуется авторизация Google. Запустите: npm run auth:google`);
            }

            // Обновляем access token перед запуском
            if (process.env.GOOGLE_TOKEN_REFRESH_ON_START === 'true') {
                this.logger.info('Обновление Google access token перед запуском...');
                this.accessToken = await this.authManager.refreshAccessToken();
            }

            // Запускаем стандартный процесс
            return await super.run(options);
            
        } catch (error) {
            if (error.message.includes('авторизация')) {
                this.logger.error('Необходима авторизация Google OAuth');
                this.logger.info('Выполните: npm run auth:google');
            }
            throw error;
        }
    }

    /**
     * Метод для выполнения API запросов с автоматической авторизацией
     */
    async makeAuthenticatedRequest(url, options = {}) {
        try {
            const headers = await this.authManager.getAuthHeaders();
            
            const response = await axios({
                url,
                ...options,
                headers: {
                    ...headers,
                    ...options.headers
                }
            });
            
            return response.data;
            
        } catch (error) {
            // Если 401, пробуем обновить токен и повторить
            if (error.response?.status === 401) {
                this.logger.warn('Токен истек, обновляем...');
                await this.authManager.refreshAccessToken();
                
                // Повторяем запрос с новым токеном
                const headers = await this.authManager.getAuthHeaders();
                const response = await axios({
                    url,
                    ...options,
                    headers: {
                        ...headers,
                        ...options.headers
                    }
                });
                
                return response.data;
            }
            
            throw error;
        }
    }
}

module.exports = GoogleBaseCollector;