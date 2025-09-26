// core/BaseCollector.js
const Logger = require('./Logger');
const DatabaseManager = require('./DatabaseManager');
const NotificationManager = require('./NotificationManager');

class BaseCollector {
    constructor(serviceName) {
        this.serviceName = serviceName;
        this.logger = new Logger(serviceName);
        this.dbManager = new DatabaseManager(serviceName);
        this.notifications = new NotificationManager();
        this.startTime = null;
        this.stats = {
            processed: 0,
            inserted: 0,
            updated: 0,
            errors: 0,
            warnings: []
        };
    }

    /**
     * Основной метод запуска коллектора
     */
    async run(options = {}) {
        const { startDate, endDate, manualMode = false, forceOverride = false } = options;
        
        this.startTime = new Date();
        this.logger.info(`Starting ${this.serviceName} collector`, {
            startDate, endDate, manualMode, forceOverride
        });

        try {
            // Отправляем уведомление о старте
            await this.notifications.sendStart(this.serviceName);

            // Подключаемся к БД
            await this.dbManager.connect();
            
            // Создаем/обновляем схему БД после подключения
            await this.createSchema();

            // Проверяем API подключение
            await this.checkApiConnection();

            // Получаем данные
            const data = await this.fetchData(startDate, endDate);
            
            if (!data || data.length === 0) {
                this.logger.warn('No data received from API');
                this.stats.warnings.push('No data from API');
            } else {
                // Обрабатываем и сохраняем данные
                await this.processAndSaveData(data, forceOverride);
            }

            // Отправляем уведомление об успехе
            await this.notifications.sendSuccess(this.serviceName, this.stats, this.getExecutionTime());
            
            this.logger.info(`${this.serviceName} collector completed successfully`, this.stats);
            return this.stats;

        } catch (error) {
            this.logger.error(`${this.serviceName} collector failed`, error);
            this.stats.errors++;
            
            // Отправляем уведомление об ошибке
            await this.notifications.sendError(this.serviceName, error, this.getExecutionTime());
            
            throw error;
        } finally {
            await this.dbManager.disconnect();
        }
    }

    /**
     * Проверка подключения к API (должна быть реализована в дочерних классах)
     */
    async checkApiConnection() {
        throw new Error('checkApiConnection method must be implemented in child class');
    }

    /**
     * Получение данных из API (должна быть реализована в дочерних классах)
     */
    async fetchData(startDate, endDate) {
        throw new Error('fetchData method must be implemented in child class');
    }

    /**
     * Обработка и сохранение данных
     */
    async processAndSaveData(data, forceOverride = false) {
        this.logger.info(`Processing ${data.length} records`);
        
        for (const record of data) {
            try {
                // Валидируем данные
                const validatedRecord = await this.validateRecord(record);
                
                if (!validatedRecord) {
                    this.stats.errors++;
                    continue;
                }

                // Проверяем существование записи
                const exists = await this.recordExists(validatedRecord);
                
                if (exists && !forceOverride) {
                    this.logger.debug(`Record already exists, skipping`, { 
                        key: this.getRecordKey(validatedRecord) 
                    });
                    continue;
                }

                // Сохраняем или обновляем запись
                if (exists && forceOverride) {
                    await this.updateRecord(validatedRecord);
                    this.stats.updated++;
                } else {
                    await this.insertRecord(validatedRecord);
                    this.stats.inserted++;
                }

                this.stats.processed++;

                // Логируем прогресс каждые 1000 записей
                if (this.stats.processed % 1000 === 0) {
                    this.logger.info(`Processed ${this.stats.processed} records`);
                }

            } catch (error) {
                
                this.logger.error('Error processing record', { 
                    error: error.message,
                    stack: error.stack,
                    record: this.getRecordKey(record),
                    fullRecord: record  // Добавляем полную запись для отладки
                });
                this.stats.errors++;
            }
        }
    }

    /**
     * Валидация записи (может быть переопределена в дочерних классах)
     */
    async validateRecord(record) {
        if (!record || typeof record !== 'object') {
            return null;
        }
        return record;
    }

    /**
     * Проверка существования записи (должна быть реализована в дочерних классах)
     */
    async recordExists(record) {
        throw new Error('recordExists method must be implemented in child class');
    }

    /**
     * Получение ключа записи для логирования
     */
    getRecordKey(record) {
        return JSON.stringify(record).substring(0, 100);
    }

    /**
     * Вставка новой записи (должна быть реализована в дочерних классах)
     */
    async insertRecord(record) {
        throw new Error('insertRecord method must be implemented in child class');
    }

    /**
     * Обновление существующей записи (должна быть реализована в дочерних классах)
     */
    async updateRecord(record) {
        throw new Error('updateRecord method must be implemented in child class');
    }

    /**
     * Получение времени выполнения
     */
    getExecutionTime() {
        if (!this.startTime) return 0;
        return Math.round((new Date() - this.startTime) / 1000);
    }

    /**
     * Получение конфигурации сервиса
     */
    getConfig() {
        const fs = require('fs');
        const path = require('path');
        
        const configPath = path.join(__dirname, '..', 'services', this.serviceName, 'config.json');
        
        if (fs.existsSync(configPath)) {
            return JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
        
        return {};
    }

    /**
     * Создание схемы БД для сервиса
     */
    async createSchema() {
        const fs = require('fs');
        const path = require('path');
        
        const schemaPath = path.join(__dirname, '..', 'services', this.serviceName, 'schema.sql');
        
        if (fs.existsSync(schemaPath)) {
            const schema = fs.readFileSync(schemaPath, 'utf8');
            await this.dbManager.query(schema);
            this.logger.info('Database schema created/updated');
        }
    }

    /**
     * Получение статистики за период
     */
    async getStats(startDate, endDate) {
        // Базовая реализация - может быть переопределена
        return {
            service: this.serviceName,
            period: { startDate, endDate },
            totalRecords: 0
        };
    }
}

module.exports = BaseCollector;