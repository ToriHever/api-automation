// core/Logger.js
const winston = require('winston');
const path = require('path');

class Logger {
    constructor(serviceName = 'system') {
        this.serviceName = serviceName;
        
        // Создаем папку для логов если не существует
        const fs = require('fs');
        const logDir = path.join(process.cwd(), 'logs', 'services', serviceName);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }

        this.logger = winston.createLogger({
            level: process.env.LOG_LEVEL || 'info',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.errors({ stack: true }),
                winston.format.json()
            ),
            transports: [
                new winston.transports.Console({
                    format: winston.format.combine(
                        winston.format.colorize(),
                        winston.format.simple()
                    )
                }),
                new winston.transports.File({
                    filename: path.join(logDir, 'debug.log'),
                    level: 'debug'
                })
            ]
        });
    }

    info(message, meta = {}) {
        this.logger.info(`[${this.serviceName}] ${message}`, meta);
    }

    warn(message, meta = {}) {
        this.logger.warn(`[${this.serviceName}] ${message}`, meta);
    }

    error(message, error = null, meta = {}) {
        if (error) {
            this.logger.error(`[${this.serviceName}] ${message}`, { 
                error: error.message, 
                stack: error.stack, 
                ...meta 
            });
        } else {
            this.logger.error(`[${this.serviceName}] ${message}`, meta);
        }
    }

    debug(message, meta = {}) {
        this.logger.debug(`[${this.serviceName}] ${message}`, meta);
    }
}

module.exports = Logger;