// utils/debug-universal.js - Универсальная диагностика всех сервисов
require('dotenv').config();

function getFormattedDate(daysOffset = 0) {
    const date = new Date();
    date.setDate(date.getDate() + daysOffset);
    return date.toISOString().split('T')[0];
}

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
        }
        throw error;
    }
}

async function debugService(serviceName, testDate) {
    console.log(`🔬 ДИАГНОСТИКА СЕРВИСА: ${serviceName.toUpperCase()}\n`);
    
    try {
        const collector = await getCollector(serviceName);
        
        console.log("🔍 Проверка подключения к API...");
        await collector.checkApiConnection();
        console.log("✅ API подключение успешно\n");

        console.log("🔍 Проверка подключения к БД...");
        await collector.dbManager.connect();
        console.log("✅ БД подключение успешно\n");

        console.log("📊 Получение данных из API...");
        const data = await collector.fetchData(testDate, testDate);
        
        console.log(`📈 Результат: получено ${data.length} записей\n`);

        if (data.length > 0) {
            console.log("🔍 Примеры полученных данных:");
            data.slice(0, 3).forEach((record, index) => {
                console.log(`   ${index + 1}. ${JSON.stringify(record).substring(0, 100)}...`);
            });
        }

        await collector.dbManager.disconnect();
        return { success: true, records: data.length };

    } catch (error) {
        console.error("❌ ОШИБКА:", error.message);
        return { success: false, error: error.message };
    }
}

async function main() {
    console.log("🚀 УНИВЕРСАЛЬНАЯ ДИАГНОСТИКА СЕРВИСОВ\n");

    const serviceName = process.argv[2];
    const testDate = process.argv[3] || getFormattedDate(-1);

    if (!serviceName) {
        console.log("Использование:");
        console.log("  node utils/debug-universal.js <сервис> [дата]");
        console.log("\nДоступные сервисы:");
        console.log("  topvisor, wordstat, clarity, ga4, gsc, yandex-metrika");
        console.log("\nПримеры:");
        console.log("  node utils/debug-universal.js topvisor");
        console.log("  node utils/debug-universal.js topvisor 2025-09-15");
        process.exit(1);
    }

    console.log(`🎯 Сервис: ${serviceName}`);
    console.log(`📅 Дата: ${testDate}\n`);

    await debugService(serviceName, testDate);
}

if (require.main === module) {
    main().catch(console.error);
}