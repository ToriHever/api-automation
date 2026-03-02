// scripts/run-service.js
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Функция для динамического импорта коллекторов
async function getCollector(serviceName) {
    const collectorsMap = {
        'topvisor': () => require('../services/topvisor/TopVisorCollector'),
        'wordstat': () => require('../services/wordstat/WordStatCollector'),
        'clarity': () => require('../services/clarity/ClarityCollector'),
        'ga4': () => require('../services/ga4/GA4Collector'),
        'gsc': () => require('../services/gsc/GSCCollector'),
        'yandex-metrika': () => require('../services/yandex-metrika/YandexMetrikaCollector')
    };

    if (!collectorsMap[serviceName]) {
        throw new Error(`Коллектор для сервиса "${serviceName}" не найден`);
    }

    try {
        const CollectorClass = collectorsMap[serviceName]();
        return new CollectorClass();
    } catch (error) {
        if (error.code === 'MODULE_NOT_FOUND') {
            console.error(`❌ Коллектор для сервиса "${serviceName}" не реализован`);
            console.log(`💡 Создайте файл: services/${serviceName}/${serviceName.charAt(0).toUpperCase() + serviceName.slice(1)}Collector.js`);
        }
        throw error;
    }
}

// Функция получения даты в формате YYYY-MM-DD
function getFormattedDate(daysOffset = 0) {
    const date = new Date();
    date.setDate(date.getDate() + daysOffset);
    return date.toISOString().split('T')[0];
}

// Загрузка конфигурации сервисов
function loadServicesConfig() {
    const configPath = path.join(__dirname, '../config/services.json');
    
    if (fs.existsSync(configPath)) {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    
    return {
        topvisor: { enabled: true, priority: 1 },
        wordstat: { enabled: false, priority: 2 },
        clarity: { enabled: false, priority: 3 },
        ga4: { enabled: false, priority: 4 },
        gsc: { enabled: false, priority: 5 },
        'yandex-metrika': { enabled: false, priority: 6 }
    };
}

// Парсинг аргументов командной строки
function parseArguments() {
    const args = process.argv.slice(2);
    const options = {
        service: null,
        startDate: null,
        endDate: null,
        manualMode: false,
        forceOverride: false,
        help: false,
        method: null
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        
        switch (arg) {
            case '--service':
            case '-s':
                options.service = args[++i];
                break;
            case '--start-date':
                options.startDate = args[++i];
                options.manualMode = true;
                break;
            case '--end-date':
                options.endDate = args[++i];
                options.manualMode = true;
                break;
            case '--force':
            case '-f':
                options.forceOverride = true;
                break;
            case '--manual':
            case '-m':
                options.manualMode = true;
                break;
            case '--help':
            case '-h':
                options.help = true;
                break;
            case '--method':
            case '-mt':
                options.method = args[++i];
                break;
            default:
                if (!options.service && !arg.startsWith('-')) {
                    options.service = arg;
                }
                break;
        }
    }

    // Обработка переменных окружения (для обратной совместимости)
    if (process.env.MANUAL_MODE === 'true') {
        options.manualMode = true;
    }
    if (process.env.MANUAL_START_DATE) {
        options.startDate = process.env.MANUAL_START_DATE;
        options.manualMode = true;
    }
    if (process.env.MANUAL_END_DATE) {
        options.endDate = process.env.MANUAL_END_DATE;
        options.manualMode = true;
    }
    if (process.env.FORCE_OVERRIDE === 'true') {
        options.forceOverride = true;
    }

    return options;
}

// Показать справку
function showHelp() {
    console.log(`
🚀 ЗАПУСК КОЛЛЕКТОРОВ API ДАННЫХ

ИСПОЛЬЗОВАНИЕ:
  node scripts/run-service.js [ОПЦИИ] [СЕРВИС]

СЕРВИСЫ:
  topvisor         TopVisor позиции
  wordstat         Яндекс.Wordstat
  clarity          Microsoft Clarity
  ga4              Google Analytics 4
  gsc              Google Search Console
  yandex-metrika   Яндекс.Метрика

ОПЦИИ:
  -s, --service <name>     Запустить конкретный сервис
  --start-date <date>      Начальная дата (YYYY-MM-DD)
  --end-date <date>        Конечная дата (YYYY-MM-DD)
  -m, --manual             Ручной режим
  -f, --force              Принудительная перезапись
  --method <name>          Метод сбора (top, dynamics, all)
  -h, --help               Показать эту справку

ПРИМЕРЫ:
  node scripts/run-service.js topvisor
  node scripts/run-service.js wordstat --method top
  node scripts/run-service.js wordstat --method dynamics
  node scripts/run-service.js topvisor --start-date 2025-09-15 --end-date 2025-09-15
  node scripts/run-service.js topvisor --force

ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ:
  MANUAL_MODE=true         Ручной режим
  MANUAL_START_DATE=date   Начальная дата
  MANUAL_END_DATE=date     Конечная дата  
  FORCE_OVERRIDE=true      Принудительная перезапись
    `);
}

// Главная функция
async function main() {
    console.log('🚀 Система сбора данных из API сервисов');
    console.log(`🕐 Запуск: ${new Date().toLocaleString('ru-RU')}\n`);

    const options = parseArguments();

    if (options.help) {
        showHelp();
        process.exit(0);
    }

    // Загружаем конфигурацию сервисов
    const servicesConfig = loadServicesConfig();

    // Определяем какие сервисы запускать
    let servicesToRun = [];
    
    if (options.service) {
        if (!servicesConfig[options.service]) {
            console.error(`❌ Сервис "${options.service}" не найден в конфигурации`);
            console.log('\n💡 Доступные сервисы:');
            Object.keys(servicesConfig).forEach(name => {
                console.log(`   - ${name}`);
            });
            process.exit(1);
        }
        servicesToRun = [{ name: options.service, config: servicesConfig[options.service] }];
    } else {
        servicesToRun = Object.entries(servicesConfig)
            .filter(([name, config]) => config.enabled)
            .map(([name, config]) => ({ name, config }))
            .sort((a, b) => (a.config.priority || 999) - (b.config.priority || 999));
    }

    if (servicesToRun.length === 0) {
        console.log('⚠️ Нет активных сервисов для запуска');
        console.log('💡 Включите сервисы в config/services.json или запустите конкретный сервис');
        process.exit(0);
    }

    console.log(`🎯 К запуску: ${servicesToRun.map(s => s.name).join(', ')}\n`);

    // Передаём метод через env до создания коллектора
    process.env.WORDSTAT_METHOD = options.method || 'all';

    // Запускаем сервисы
    const results = new Map();
    
    for (const serviceInfo of servicesToRun) {
        const { name: serviceName, config: serviceConfig } = serviceInfo;
        
        try {
            console.log(`\n🚀 Запуск сервиса: ${serviceName.toUpperCase()}`);
            console.log(`⚙️ Приоритет: ${serviceConfig.priority || 'не задан'}`);
            
            let startDate = options.startDate;
            let endDate = options.endDate;

            if (!options.manualMode) {
                const dateOffset = serviceConfig.dateOffset !== undefined 
                    ? serviceConfig.dateOffset 
                    : -1;
                
                startDate = getFormattedDate(dateOffset);
                endDate = getFormattedDate(dateOffset);
                
                console.log(`📅 Даты (смещение ${dateOffset} дней): ${startDate} - ${endDate}`);
            } else {
                console.log(`📅 Даты (ручной режим): ${startDate} - ${endDate}`);
            }

            if (!startDate || !endDate) {
                console.error(`❌ Ошибка: Не указаны даты для сервиса ${serviceName}`);
                console.log('💡 Используйте --start-date и --end-date или автоматический режим');
                throw new Error('Даты не определены');
            }
            
            if (options.forceOverride) {
                console.log('⚠️ Режим принудительной перезаписи активирован');
            }

            if (options.method) {
                console.log(`🔧 Метод: ${options.method}`);
            }
            
            const collector = await getCollector(serviceName);
            
            const stats = await collector.run({
                startDate,
                endDate,
                manualMode: options.manualMode,
                forceOverride: options.forceOverride
            });
            
            results.set(serviceName, { success: true, stats });
            console.log(`✅ ${serviceName.toUpperCase()} завершен успешно`);
            
        } catch (error) {
            console.error(`❌ Ошибка в сервисе ${serviceName.toUpperCase()}:`, error.message);
            results.set(serviceName, { success: false, error });
        }
        
        if (serviceInfo !== servicesToRun[servicesToRun.length - 1]) {
            console.log('⏳ Пауза 2 секунды между сервисами...');
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    // Итоговый отчет
    console.log('\n' + '='.repeat(50));
    console.log('📊 ИТОГОВЫЙ ОТЧЕТ');
    console.log('='.repeat(50));
    
    const successful = [];
    const failed = [];
    let totalRecords = 0;
    
    for (const [serviceName, result] of results) {
        if (result.success) {
            const records = (result.stats.inserted || 0) + (result.stats.updated || 0);
            totalRecords += records;
            successful.push({ name: serviceName, records, stats: result.stats });
        } else {
            failed.push({ name: serviceName, error: result.error });
        }
    }
    
    if (successful.length > 0) {
        console.log('\n✅ УСПЕШНО ЗАВЕРШЕНЫ:');
        successful.forEach(s => {
            console.log(`   • ${s.name}: ${s.records.toLocaleString()} записей`);
        });
    }
    
    if (failed.length > 0) {
        console.log('\n❌ ЗАВЕРШИЛИСЬ С ОШИБКОЙ:');
        failed.forEach(f => {
            console.log(`   • ${f.name}: ${f.error.message}`);
        });
    }
    
    console.log(`\n📈 ИТОГО: ${totalRecords.toLocaleString()} записей обработано`);
    console.log(`🕐 Завершено: ${new Date().toLocaleString('ru-RU')}`);
    
    process.exit(failed.length > 0 ? 1 : 0);
}

// Обработка ошибок
process.on('uncaughtException', (error) => {
    console.error('💥 Критическая ошибка:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Необработанная ошибка Promise:', reason);
    process.exit(1);
});

if (require.main === module) {
    main().catch((error) => {
        console.error('💥 Ошибка запуска:', error);
        process.exit(1);
    });
}