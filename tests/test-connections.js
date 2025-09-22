import axios from "axios";
import pkg from "pg";
import dotenv from "dotenv";

dotenv.config();
const { Client } = pkg;

// Функция для получения даты в формате YYYY-MM-DD
function getFormattedDate(daysOffset = 0) {
    const date = new Date();
    date.setDate(date.getDate() + daysOffset);
    return date.toISOString().split('T')[0];
}

// Автоматическое определение дат
const START_DATE = process.env.START_DATE || getFormattedDate(-1); // Вчера
const END_DATE = process.env.END_DATE || getFormattedDate(-1);     // Вчера

// Для ручного режима можно задать период
const MANUAL_MODE = process.env.MANUAL_MODE === 'true';
const MANUAL_START = process.env.MANUAL_START_DATE;
const MANUAL_END = process.env.MANUAL_END_DATE;

// Финальные даты
const FINAL_START_DATE = MANUAL_MODE && MANUAL_START ? MANUAL_START : START_DATE;
const FINAL_END_DATE = MANUAL_MODE && MANUAL_END ? MANUAL_END : END_DATE;

// словарь поисковиков
const searchEngineMap = {
    "7": "Google",
    "5": "Yandex",
    "159": "Google",
    "701": "Bing"
};

// словарь проектов
const projectMap = {
    "11430357": "Термины",
    "7093082": "Блог",
    "7063718": "DDG-EN",
    "7063822": "DDG-RU"
};

// Конфигурация запросов
const apiRequests = [
    {
        name: "Позиции: Данные по RU сайту для Яндекс",
        body: {
            "project_id": "7063822",
            "regions_indexes": ["5"],
            "date1": FINAL_START_DATE,
            "date2": FINAL_END_DATE,
            "positions_fields": ["relevant_url", "position", "snippet"],
            "show_groups": true
        }
    },
    {
        name: "Позиции: Данные по RU сайту для Google",
        body: {
            "project_id": "7063822",
            "regions_indexes": ["7"],
            "date1": FINAL_START_DATE,
            "date2": FINAL_END_DATE,
            "positions_fields": ["relevant_url", "position", "snippet"],
            "show_groups": true
        }
    },
    {
        name: "Позиции: Данные по EN сайту для Google",
        body: {
            "project_id": "7063718",
            "regions_indexes": ["159"],
            "date1": FINAL_START_DATE,
            "date2": FINAL_END_DATE,
            "positions_fields": ["relevant_url", "position", "snippet"],
            "show_groups": true
        }
    },
    {
        name: "Позиции: Данные по EN сайту для Bing",
        body: {
            "project_id": "7063718",
            "regions_indexes": ["701"],
            "date1": FINAL_START_DATE,
            "date2": FINAL_END_DATE,
            "positions_fields": ["relevant_url", "position", "snippet"],
            "show_groups": true
        }
    },
    {
        name: "Позиции: Данные по Блог для Яндекс",
        body: {
            "project_id": "7093082",
            "regions_indexes": ["5"],
            "date1": FINAL_START_DATE,
            "date2": FINAL_END_DATE,
            "positions_fields": ["relevant_url", "position", "snippet"],
            "show_groups": true
        }
    },
    {
        name: "Позиции: Данные по Блог для Google",
        body: {
            "project_id": "7093082",
            "regions_indexes": ["7"],
            "date1": FINAL_START_DATE,
            "date2": FINAL_END_DATE,
            "positions_fields": ["relevant_url", "position", "snippet"],
            "show_groups": true
        }
    },
    {
        name: "Позиции: Данные по Термины для Яндекс",
        body: {
            "project_id": "11430357",
            "regions_indexes": ["5"],
            "date1": FINAL_START_DATE,
            "date2": FINAL_END_DATE,
            "positions_fields": ["relevant_url", "position", "snippet"],
            "show_groups": true
        }
    },
    {
        name: "Позиции: Данные по Термины для Google",
        body: {
            "project_id": "11430357",
            "regions_indexes": ["7"],
            "date1": FINAL_START_DATE,
            "date2": FINAL_END_DATE,
            "positions_fields": ["relevant_url", "position", "snippet"],
            "show_groups": true
        }
    }
];

// подключение к PostgreSQL
const client = new Client({
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    port: process.env.PGPORT,
});

// Функция задержки
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Функция выполнения одного API запроса с повторными попытками
async function makeApiRequest(requestConfig, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`🔄 Выполняю запрос: ${requestConfig.name} (попытка ${attempt})`);
            
            const response = await axios.post(
                process.env.API_URL,
                requestConfig.body,
                {
                    headers: {
                        Authorization: `Bearer ${process.env.API_KEY}`,
                        "User-Id": process.env.USER_ID,
                        "Content-Type": "application/json"
                    },
                    timeout: 30000 // 30 секунд таймаут
                }
            );

            console.log(`✅ Запрос "${requestConfig.name}" выполнен успешно`);
            return response.data;

        } catch (error) {
            if (error.response?.status === 429) {
                console.log(`⚠️ Превышен лимит API для "${requestConfig.name}". Попытка ${attempt}/${retries}`);
                if (attempt < retries) {
                    // Увеличиваем задержку с каждой попыткой
                    const waitTime = attempt * 10000; // 10, 20, 30 секунд
                    console.log(`⏳ Ожидание ${waitTime/1000} секунд перед повторной попыткой...`);
                    await delay(waitTime);
                    continue;
                }
            }
            
            if (attempt === retries) {
                console.error(`❌ Ошибка в запросе "${requestConfig.name}" после ${retries} попыток:`, error.message);
                throw error;
            }
            
            console.log(`⚠️ Ошибка в запросе "${requestConfig.name}". Попытка ${attempt}/${retries}:`, error.message);
            await delay(5000); // 5 секунд задержка перед повтором
        }
    }
}

// Функция проверки существующих данных
async function checkExistingData(date) {
    try {
        const result = await client.query(
            'SELECT COUNT(*) FROM topvisor.positions WHERE event_date = $1',
            [date]
        );
        return parseInt(result.rows[0].count, 10);
    } catch (error) {
        console.log(`⚠️ Ошибка проверки существующих данных: ${error.message}`);
        return 0;
    }
}

// Функция обработки и записи данных в БД
async function processAndSaveData(data, requestName) {
    if (!data.result || !data.result.keywords) {
        console.log(`⚠️ API вернул пустой результат для "${requestName}"`);
        return 0;
    }

    let recordsInserted = 0;
    console.log(`📝 Обработка ${data.result.keywords.length} ключевых слов для "${requestName}"`);

    for (const keyword of data.result.keywords) {
        const request = keyword.name;

        if (!keyword.positionsData || Object.keys(keyword.positionsData).length === 0) {
            console.log(`   🔑 "${request}" - нет данных позиций`);
            continue;
        }

        let keywordRecords = 0;
        for (const key in keyword.positionsData) {
            const [event_date, project_id, region_index] = key.split(":");
            const positionData = keyword.positionsData[key];
            
            let position = positionData.position;
            let relevant_url = positionData.relevant_url || '';
            let snippet = positionData.snippet || '';

            // обработка позиции
            if (position === "--") {
                position = null;
            } else {
                position = parseInt(position, 10);
            }

            // интерпретация значений
            const project_name = projectMap[project_id] || project_id;
            const search_engine = searchEngineMap[region_index] || region_index;

            try {
                // запись в таблицу
                await client.query(
                    `INSERT INTO topvisor.positions (request, event_date, project_name, search_engine, position, relevant_url, snippet)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [request, event_date, project_name, search_engine, position, relevant_url, snippet]
                );
                
                recordsInserted++;
                keywordRecords++;
            } catch (dbError) {
                console.error(`   ❌ Ошибка записи для "${request}": ${dbError.message}`);
            }
        }
        
        if (keywordRecords > 0) {
            console.log(`   🔑 "${request}" - записано ${keywordRecords} позиций`);
        }
    }

    console.log(`📊 Итого записано ${recordsInserted} записей для "${requestName}"`);
    return recordsInserted;
}

// Функция разделения массива на батчи
function chunkArray(array, chunkSize) {
    const chunks = [];
    for (let i = 0; i < array.length; i += chunkSize) {
        chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
}

// Главная функция
async function fetchAndSaveAll() {
    const startTime = new Date();
    
    try {
        // Подключение к БД
        await client.connect();
        console.log("🔗 Подключение к PostgreSQL установлено");

        // Создание таблицы, если её нет
        await client.query(`
            CREATE TABLE IF NOT EXISTS topvisor.positions (
                id SERIAL PRIMARY KEY,
                request TEXT NOT NULL,
                event_date DATE NOT NULL,
                project_name TEXT NOT NULL,
                search_engine TEXT NOT NULL,
                position INT,
                relevant_url TEXT NOT NULL,
                snippet TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log("📋 Таблица проверена/создана");

        // Проверка существующих данных
        const existingRecords = await checkExistingData(FINAL_START_DATE);
        if (existingRecords > 0 && !process.env.FORCE_OVERRIDE) {
            console.log(`⚠️ Обнаружено ${existingRecords} записей за ${FINAL_START_DATE}`);
            console.log("💡 Для перезаписи данных используйте: FORCE_OVERRIDE=true");
            console.log("❌ Выполнение остановлено для избежания дублирования");
            return;
        }

        if (existingRecords > 0 && process.env.FORCE_OVERRIDE === 'true') {
            console.log(`🔄 Принудительная перезапись: удаляю ${existingRecords} записей за ${FINAL_START_DATE}`);
            await client.query('DELETE FROM topvisor.positions WHERE event_date = $1', [FINAL_START_DATE]);
        }

        // Разделяем запросы на батчи по 4 (чтобы не превысить лимит 5)
        const requestBatches = chunkArray(apiRequests, 4);
        let totalRecords = 0;

        for (let batchIndex = 0; batchIndex < requestBatches.length; batchIndex++) {
            const batch = requestBatches[batchIndex];
            console.log(`\n🔄 Обработка батча ${batchIndex + 1}/${requestBatches.length} (${batch.length} запросов)`);

            // Выполняем запросы в батче параллельно
            const promises = batch.map(requestConfig => 
                makeApiRequest(requestConfig)
                    .then(data => ({ success: true, data, requestConfig }))
                    .catch(error => ({ success: false, error, requestConfig }))
            );

            const results = await Promise.all(promises);

            // Обрабатываем результаты
            for (const result of results) {
                if (result.success) {
                    const recordCount = await processAndSaveData(result.data, result.requestConfig.name);
                    totalRecords += recordCount;
                } else {
                    console.error(`❌ Не удалось обработать "${result.requestConfig.name}":`, result.error.message);
                }
            }

            // Задержка между батчами (кроме последнего)
            if (batchIndex < requestBatches.length - 1) {
                console.log("⏳ Пауза 5 секунд между батчами...");
                await delay(5000);
            }
        }

        const endTime = new Date();
        const duration = Math.round((endTime - startTime) / 1000);
        
        console.log(`\n✅ Все запросы завершены! Всего записано ${totalRecords} записей в PostgreSQL`);
        console.log(`⏱️ Время выполнения: ${duration} секунд`);

    } catch (err) {
        console.error("❌ Критическая ошибка:", err.message);
        throw err;
    } finally {
        await client.end();
        console.log("🔌 Соединение с PostgreSQL закрыто");
    }
}

// Запуск скрипта
console.log("🚀 Запуск скрипта обработки API запросов...");
console.log(`📅 Период данных: ${FINAL_START_DATE} - ${FINAL_END_DATE}`);
console.log(`🤖 Режим: ${MANUAL_MODE ? 'Ручной' : 'Автоматический (предыдущий день)'}`);
console.log(`🕐 Текущее время: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`);
console.log(`📊 Сегодня: ${getFormattedDate(0)}`);
console.log(`📊 Вчера: ${getFormattedDate(-1)}`);

if (process.env.FORCE_OVERRIDE === 'true') {
    console.log("⚠️ Режим принудительной перезаписи активирован");
}

// Проверяем, что даты корректные
const today = new Date();
const requestDate = new Date(FINAL_START_DATE);
const daysDifference = Math.floor((today - requestDate) / (1000 * 60 * 60 * 24));

console.log(`🔍 Анализ запрашиваемой даты:`);
console.log(`   - Запрашиваем данные за: ${FINAL_START_DATE}`);
console.log(`   - Разница с сегодня: ${daysDifference} дней`);

if (daysDifference < 1) {
    console.log(`⚠️ ВНИМАНИЕ: Запрашиваются данные за сегодня или будущую дату!`);
    console.log(`   Данные за текущий день могут быть неполными или отсутствовать.`);
    console.log(`   Рекомендуется запрашивать данные минимум за вчерашний день.`);
} else if (daysDifference > 90) {
    console.log(`⚠️ ВНИМАНИЕ: Запрашиваются данные за ${daysDifference} дней назад.`);
    console.log(`   Убедитесь, что это корректная дата.`);
}

console.log("");

fetchAndSaveAll()
    .then(() => {
        console.log("\n🎉 Скрипт завершен успешно!");
        process.exit(0);
    })
    .catch((error) => {
        console.error("\n💥 Скрипт завершился с ошибкой:", error.message);
        process.exit(1);
    });