// scripts/gsc-queries-by-url-blog.js
// Все запросы (без ограничения топ-20) для списка статей блога ddos-guard.ru/blog
// за последние 3 месяца. Использует существующую OAuth-авторизацию
// (core/GoogleAuthManager.js) и ту же таблицу, что и gsc-top-queries-by-url.js
// (gsc.top_queries_by_page) — те же колонки подходят, просто без среза по топ-20.
// Не трогает services/gsc/GSCCollector.js и его ежедневный сбор — отдельный процесс.
//
// Запуск: node scripts/gsc-queries-by-url-blog.js

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const GoogleAuthManager = require('../core/GoogleAuthManager');
const DatabaseManager = require('../core/DatabaseManager');

const SITE_URL = 'sc-domain:ddos-guard.ru';
const API_ENDPOINT = 'https://www.googleapis.com/webmasters/v3';
const PERIOD_LABEL = 'blog-last-90d';

function formatDate(date) {
    return date.toISOString().slice(0, 10);
}

// GSC отдаёт данные с задержкой 2-3 дня — берём с запасом.
function getPeriod() {
    const end = new Date();
    end.setDate(end.getDate() - 3);
    const start = new Date(end);
    start.setDate(start.getDate() - 90);
    return { label: PERIOD_LABEL, startDate: formatDate(start), endDate: formatDate(end) };
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function loadUrls() {
    const filePath = path.join(__dirname, '..', 'services', 'gsc', 'urls', 'blog_target_urls.txt');
    const content = fs.readFileSync(filePath, 'utf-8');
    return content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'));
}

async function fetchQueriesForPage(authManager, url, period, retries = 3) {
    const endpoint = `${API_ENDPOINT}/sites/${encodeURIComponent(SITE_URL)}/searchAnalytics/query`;
    const body = {
        startDate: period.startDate,
        endDate: period.endDate,
        type: 'web',
        dataState: 'final',
        dimensions: ['query'],
        dimensionFilterGroups: [{
            filters: [{ dimension: 'page', operator: 'equals', expression: url }]
        }],
        rowLimit: 25000
    };

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const headers = await authManager.getAuthHeaders();
            const response = await axios.post(endpoint, body, { headers, timeout: 30000 });
            return response.data.rows || [];
        } catch (error) {
            if (attempt === retries) throw error;
            await delay(attempt * 3000);
        }
    }
}

async function upsertQueries(db, url, period, rows) {
    const sorted = rows.slice().sort((a, b) => b.impressions - a.impressions);

    for (let i = 0; i < sorted.length; i++) {
        const row = sorted[i];
        await db.query(
            `INSERT INTO gsc.top_queries_by_page
                (url, period_label, period_start, period_end, rank, query, clicks, impressions, ctr, position)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (url, period_label, query) DO UPDATE SET
                rank = EXCLUDED.rank, clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions,
                ctr = EXCLUDED.ctr, position = EXCLUDED.position, updated_at = CURRENT_TIMESTAMP`,
            [
                url, period.label, period.startDate, period.endDate,
                i + 1, row.keys[0], row.clicks, row.impressions, row.ctr, row.position
            ]
        );
    }

    return sorted.length;
}

async function main() {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        throw new Error('GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET обязательны');
    }

    const urls = loadUrls();
    const period = getPeriod();
    console.log(`URL для обработки: ${urls.length}`);
    console.log(`Период: ${period.label} (${period.startDate} - ${period.endDate})`);

    const authManager = new GoogleAuthManager();
    const db = new DatabaseManager('gsc-queries-by-url-blog');
    await db.connect();

    try {
        const schemaPath = path.join(__dirname, '..', 'services', 'gsc', 'top_queries_schema.sql');
        await db.query(fs.readFileSync(schemaPath, 'utf8'));

        let done = 0;

        for (const url of urls) {
            done++;
            process.stdout.write(`[${done}/${urls.length}] ${url} ... `);

            try {
                const rows = await fetchQueriesForPage(authManager, url, period);
                const written = await upsertQueries(db, url, period, rows);
                console.log(`${written} запросов записано`);
            } catch (error) {
                console.log(`ОШИБКА: ${error.response?.data?.error?.message || error.message}`);
            }

            await delay(300);
        }

        console.log('\nГотово.');
    } finally {
        await db.disconnect();
    }
}

main().catch(error => {
    console.error('Ошибка сбора GSC queries по blog URL:', error.message);
    process.exit(1);
});
