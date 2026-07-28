// scripts/wordstat-dynamics-range-daily.js
// То же самое, что scripts/wordstat-dynamics-range.js, но period: PERIOD_DAILY —
// частотность по ДНЯМ за диапазон RANGE_START..RANGE_END одним запросом на фразу.
// Пишет в ОТДЕЛЬНУЮ таблицу wordstat.dynamics_range_daily (не смешивается с
// помесячными данными в wordstat.dynamics_range).
//
// PERIOD_DAILY у Wordstat хранит только 60 дней — поэтому очередь циклическая
// (cycle_start = 1-е число месяца): каждый новый месяц все фразы из файла
// ставятся в очередь заново, а не находятся уже 'done' от прошлого раза.
// Без этого дневные данные, не собранные за очередной месяц, терялись бы
// безвозвратно, как только выкатятся за пределы 60-дневного окна.
//
// Список фраз тот же: services/wordstat/keywords/dynamics_range_keywords.txt
// Квота (100 запросов/час) общая с обычным сбором wordstat — top (1-2 число)
// и dynamics (3-5 число) уже заняты по расписанию, поэтому этот скрипт стоит
// вешать на дни, когда квота простаивает, например:
//
//   # WordStat dynamics-range-daily — 6-10 число, каждый час с 8:00 до 20:00
//   0 8-20 6-10 * * cd /opt/api-automation && node scripts/wordstat-dynamics-range-daily.js >> logs/services/wordstat/daily_$(date +\%Y\%m\%d).log 2>&1
//
// Запуск вручную (если нужно срочно): node scripts/wordstat-dynamics-range-daily.js

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const DatabaseManager = require('../core/DatabaseManager');

const API_BASE_URL = 'https://searchapi.api.cloud.yandex.net/v2/wordstat';

// PERIOD_DAILY у Wordstat API отдаёт данные не старше 60 дней от сегодня
// ("The from field value is older than 60 days") — поэтому диапазон считаем
// динамически на момент запуска, а не хардкодим даты.
function formatDate(date) {
    return date.toISOString().substring(0, 10);
}

const today = new Date();
const RANGE_END = formatDate(today);

const rangeStartDate = new Date(today);
rangeStartDate.setDate(rangeStartDate.getDate() - 59);
const RANGE_START = formatDate(rangeStartDate);

// Ключ цикла — 1-е число текущего месяца. Новый месяц => новый цикл => все
// фразы из файла ставятся в очередь заново, даже если в прошлом цикле уже
// дошли до 'done' (см. UNIQUE(phrase, cycle_start) в схеме).
const CYCLE_START = formatDate(new Date(today.getFullYear(), today.getMonth(), 1));

const MAX_PER_RUN = parseInt(process.env.WORDSTAT_MAX_PER_RUN || '80', 10);
const KEYWORDS_FILE = process.env.WORDSTAT_RANGE_KEYWORDS_FILE || 'dynamics_range_keywords.txt';

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function loadKeywords() {
    const filePath = path.join(__dirname, '..', 'services', 'wordstat', 'keywords', KEYWORDS_FILE);
    const content = fs.readFileSync(filePath, 'utf-8');
    return content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'));
}

async function ensureQueue(db, keywords, cycleStart) {
    for (const phrase of keywords) {
        await db.query(
            `INSERT INTO wordstat.dynamics_range_daily_queue (phrase, cycle_start)
             VALUES ($1, $2) ON CONFLICT (phrase, cycle_start) DO NOTHING`,
            [phrase, cycleStart]
        );
    }
}

async function getNextBatch(db, limit, cycleStart) {
    const result = await db.query(
        `SELECT id, phrase FROM wordstat.dynamics_range_daily_queue
         WHERE cycle_start = $2 AND status IN ('pending', 'error') AND attempts < 5
         ORDER BY attempts ASC, id ASC
         LIMIT $1`,
        [limit, cycleStart]
    );
    return result.rows;
}

async function getRemainingCount(db, cycleStart) {
    const result = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM wordstat.dynamics_range_daily_queue
         WHERE cycle_start = $1 AND status IN ('pending', 'error') AND attempts < 5`,
        [cycleStart]
    );
    return result.rows[0].cnt;
}

async function markResult(db, id, success, errorMessage = null) {
    if (success) {
        await db.query(
            `UPDATE wordstat.dynamics_range_daily_queue
             SET status = 'done', processed_at = CURRENT_TIMESTAMP, attempts = attempts + 1
             WHERE id = $1`,
            [id]
        );
    } else {
        await db.query(
            `UPDATE wordstat.dynamics_range_daily_queue
             SET status = 'error', last_error = $2, attempts = attempts + 1, processed_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [id, errorMessage]
        );
    }
}

async function resolveRequestId(db, phrase) {
    const result = await db.query(
        `SELECT request_id FROM common.requests WHERE request = $1 LIMIT 1`,
        [phrase]
    );
    return result.rows.length > 0 ? result.rows[0].request_id : null;
}

async function fetchDynamicsRangeDaily(phrase) {
    const response = await axios.post(`${API_BASE_URL}/dynamics`, {
        phrase,
        period: 'PERIOD_DAILY',
        fromDate: `${RANGE_START}T00:00:00Z`,
        toDate: `${RANGE_END}T00:00:00Z`,
        regions: ['225'],
        devices: ['DEVICE_ALL'],
        folderId: process.env.WORDSTAT_FOLDER_ID
    }, {
        headers: {
            'Content-Type': 'application/json;charset=utf-8',
            'Authorization': `Api-Key ${process.env.WORDSTAT_API_KEY}`
        },
        timeout: 30000
    });

    const dailyData = {};
    const results = response.data?.results || [];

    results.forEach(item => {
        const dayKey = item.date.substring(0, 10);
        const count = (item.count === undefined || item.count === null) ? 0 : Number(item.count);
        if (!Number.isNaN(count)) {
            dailyData[dayKey] = count;
        }
    });

    return dailyData;
}

async function saveDailyData(db, requestId, dailyData) {
    const days = Object.keys(dailyData);
    for (const day of days) {
        await db.query(
            `INSERT INTO wordstat.dynamics_range_daily (request_id, day, frequency)
             VALUES ($1, $2, $3)
             ON CONFLICT (request_id, day) DO UPDATE SET frequency = EXCLUDED.frequency, updated_at = CURRENT_TIMESTAMP`,
            [requestId, day, dailyData[day]]
        );
    }
    return days.length;
}

async function main() {
    if (!process.env.WORDSTAT_API_KEY || !process.env.WORDSTAT_FOLDER_ID) {
        throw new Error('WORDSTAT_API_KEY и WORDSTAT_FOLDER_ID обязательны');
    }

    console.log(`Диапазон дат: ${RANGE_START} - ${RANGE_END} (последние 60 дней от сегодня)`);
    console.log(`Цикл: ${CYCLE_START} (месяц)`);

    const db = new DatabaseManager('wordstat-dynamics-range-daily');
    await db.connect();

    try {
        const schemaPath = path.join(__dirname, '..', 'services', 'wordstat', 'dynamics_range_schema.sql');
        await db.query(fs.readFileSync(schemaPath, 'utf8'));

        const keywords = loadKeywords();
        console.log(`Фраз в файле: ${keywords.length}`);
        await ensureQueue(db, keywords, CYCLE_START);

        const batch = await getNextBatch(db, MAX_PER_RUN, CYCLE_START);
        const remaining = await getRemainingCount(db, CYCLE_START);
        console.log(`Осталось в очереди: ${remaining}, беру в этот запуск: ${batch.length}`);

        if (batch.length === 0) {
            console.log('Очередь пуста для этого запуска.');
            return;
        }

        for (let i = 0; i < batch.length; i++) {
            const { id, phrase } = batch[i];
            process.stdout.write(`[${i + 1}/${batch.length}] "${phrase}" ... `);

            const requestId = await resolveRequestId(db, phrase);
            if (requestId === null) {
                await markResult(db, id, false, 'не найден в common.requests');
                console.log('ПРОПУСК: не найден в common.requests (API не вызывался)');
                continue;
            }

            try {
                const dailyData = await fetchDynamicsRangeDaily(phrase);
                const written = await saveDailyData(db, requestId, dailyData);
                await markResult(db, id, true);
                console.log(`${written} дней записано (request_id=${requestId})`);
            } catch (error) {
                const message = error.response?.data?.message || error.message;
                await markResult(db, id, false, message);
                console.log(`ОШИБКА: ${message}`);
            }

            await delay(300);
        }

        console.log('\nГотово на этот запуск.');
    } finally {
        await db.disconnect();
    }
}

main().catch(error => {
    console.error('Ошибка сбора wordstat dynamics range daily:', error.message);
    process.exit(1);
});
