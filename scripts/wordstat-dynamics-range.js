// scripts/wordstat-dynamics-range.js
// Сбор динамики частотности ОДНИМ запросом на фразу за весь диапазон RANGE_START..RANGE_END
// (PERIOD_MONTHLY отдаёт сразу несколько месяцев в одном ответе) — вместо помесячных запросов.
// Не трогает services/wordstat/WordStatCollector.js и продовые dynamics_keywords.txt/collection_queue.
//
// Список фраз: services/wordstat/keywords/dynamics_range_keywords.txt (по одной на строку)
// Квота (100 запросов/час) общая с обычным сбором wordstat — гоняй раз в час, пока очередь не опустеет.
//
// Запуск: node scripts/wordstat-dynamics-range.js

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const DatabaseManager = require('../core/DatabaseManager');

const API_BASE_URL = 'https://searchapi.api.cloud.yandex.net/v2/wordstat';
const RANGE_START = '2025-01-01';
const RANGE_END = '2026-06-30';
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

async function ensureQueue(db, keywords) {
    for (const phrase of keywords) {
        await db.query(
            `INSERT INTO wordstat.dynamics_range_queue (phrase) VALUES ($1) ON CONFLICT (phrase) DO NOTHING`,
            [phrase]
        );
    }
}

async function getNextBatch(db, limit) {
    const result = await db.query(
        `SELECT id, phrase FROM wordstat.dynamics_range_queue
         WHERE status IN ('pending', 'error') AND attempts < 5
         ORDER BY attempts ASC, id ASC
         LIMIT $1`,
        [limit]
    );
    return result.rows;
}

async function getRemainingCount(db) {
    const result = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM wordstat.dynamics_range_queue
         WHERE status IN ('pending', 'error') AND attempts < 5`
    );
    return result.rows[0].cnt;
}

async function markResult(db, id, success, errorMessage = null) {
    if (success) {
        await db.query(
            `UPDATE wordstat.dynamics_range_queue
             SET status = 'done', processed_at = CURRENT_TIMESTAMP, attempts = attempts + 1
             WHERE id = $1`,
            [id]
        );
    } else {
        await db.query(
            `UPDATE wordstat.dynamics_range_queue
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

async function fetchDynamicsRange(phrase) {
    const response = await axios.post(`${API_BASE_URL}/dynamics`, {
        phrase,
        period: 'PERIOD_MONTHLY',
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

    const monthlyData = {};
    const results = response.data?.results || [];

    results.forEach(item => {
        const monthKey = item.date.substring(0, 10);
        const count = (item.count === undefined || item.count === null) ? 0 : Number(item.count);
        if (!Number.isNaN(count)) {
            monthlyData[monthKey] = count;
        }
    });

    return monthlyData;
}

async function saveMonthlyData(db, requestId, monthlyData) {
    const months = Object.keys(monthlyData);
    for (const month of months) {
        await db.query(
            `INSERT INTO wordstat.dynamics_range (request_id, month, frequency)
             VALUES ($1, $2, $3)
             ON CONFLICT (request_id, month) DO UPDATE SET frequency = EXCLUDED.frequency, updated_at = CURRENT_TIMESTAMP`,
            [requestId, month, monthlyData[month]]
        );
    }
    return months.length;
}

async function main() {
    if (!process.env.WORDSTAT_API_KEY || !process.env.WORDSTAT_FOLDER_ID) {
        throw new Error('WORDSTAT_API_KEY и WORDSTAT_FOLDER_ID обязательны');
    }

    const db = new DatabaseManager('wordstat-dynamics-range');
    await db.connect();

    try {
        const schemaPath = path.join(__dirname, '..', 'services', 'wordstat', 'dynamics_range_schema.sql');
        await db.query(fs.readFileSync(schemaPath, 'utf8'));

        const keywords = loadKeywords();
        console.log(`Фраз в файле: ${keywords.length}`);
        await ensureQueue(db, keywords);

        const batch = await getNextBatch(db, MAX_PER_RUN);
        const remaining = await getRemainingCount(db);
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
                const monthlyData = await fetchDynamicsRange(phrase);
                const written = await saveMonthlyData(db, requestId, monthlyData);
                await markResult(db, id, true);
                console.log(`${written} месяцев записано (request_id=${requestId})`);
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
    console.error('Ошибка сбора wordstat dynamics range:', error.message);
    process.exit(1);
});
