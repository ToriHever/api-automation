// scripts/gsc-top-queries-by-url.js
// ТОП-20 запросов по показам (impressions) для списка URL за заданные периоды.
// Использует существующую OAuth-авторизацию (core/GoogleAuthManager.js), не трогает
// services/gsc/GSCCollector.js и его ежедневный сбор — отдельная таблица, отдельный процесс.
//
// Запуск: node scripts/gsc-top-queries-by-url.js

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const GoogleAuthManager = require('../core/GoogleAuthManager');
const DatabaseManager = require('../core/DatabaseManager');

const SITE_URL = 'sc-domain:ddos-guard.ru';
const API_ENDPOINT = 'https://www.googleapis.com/webmasters/v3';
const TOP_N = 20;

const PERIODS = [
    { label: '2025-H1', startDate: '2025-01-01', endDate: '2025-06-30' },
    { label: '2026-H1', startDate: '2026-01-01', endDate: '2026-06-30' }
];

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function loadUrls() {
    const filePath = path.join(__dirname, '..', 'services', 'gsc', 'urls', 'top_queries_target_urls.txt');
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

async function upsertTopQueries(db, url, period, rows) {
    const top = rows
        .slice()
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, TOP_N);

    for (let i = 0; i < top.length; i++) {
        const row = top[i];
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

    return top.length;
}

async function main() {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        throw new Error('GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET обязательны');
    }

    const urls = loadUrls();
    console.log(`URL для обработки: ${urls.length}`);
    console.log(`Периодов: ${PERIODS.length} (${PERIODS.map(p => p.label).join(', ')})`);

    const authManager = new GoogleAuthManager();
    const db = new DatabaseManager('gsc-top-queries');
    await db.connect();

    try {
        const schemaPath = path.join(__dirname, '..', 'services', 'gsc', 'top_queries_schema.sql');
        await db.query(fs.readFileSync(schemaPath, 'utf8'));

        let done = 0;
        const total = urls.length * PERIODS.length;

        for (const url of urls) {
            for (const period of PERIODS) {
                done++;
                process.stdout.write(`[${done}/${total}] ${period.label} ${url} ... `);

                try {
                    const rows = await fetchQueriesForPage(authManager, url, period);
                    const written = await upsertTopQueries(db, url, period, rows);
                    console.log(`${written} записано (из ${rows.length} запросов всего)`);
                } catch (error) {
                    console.log(`ОШИБКА: ${error.response?.data?.error?.message || error.message}`);
                }

                await delay(300);
            }
        }

        console.log('\nГотово.');
    } finally {
        await db.disconnect();
    }
}

main().catch(error => {
    console.error('Ошибка сбора GSC top-queries:', error.message);
    process.exit(1);
});
