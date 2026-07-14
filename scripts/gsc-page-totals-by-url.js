// scripts/gsc-page-totals-by-url.js
// Реальные суммарные показы/клики/CTR/позиция по URL за период — dimensions: ['page'],
// БЕЗ 'query', поэтому не искажены обрезкой топ-20 (см. gsc-top-queries-by-url.js / п.4 анализа).
// Тот же список URL и те же периоды, что и в топ-20 скрипте. Не трогает GSCCollector.js.
//
// Запуск: node scripts/gsc-page-totals-by-url.js

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const GoogleAuthManager = require('../core/GoogleAuthManager');
const DatabaseManager = require('../core/DatabaseManager');

const SITE_URL = 'sc-domain:ddos-guard.ru';
const API_ENDPOINT = 'https://www.googleapis.com/webmasters/v3';

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

async function fetchPageTotals(authManager, url, period, retries = 3) {
    const endpoint = `${API_ENDPOINT}/sites/${encodeURIComponent(SITE_URL)}/searchAnalytics/query`;
    const body = {
        startDate: period.startDate,
        endDate: period.endDate,
        type: 'web',
        dataState: 'final',
        dimensions: ['page'],
        dimensionFilterGroups: [{
            filters: [{ dimension: 'page', operator: 'equals', expression: url }]
        }],
        rowLimit: 1
    };

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const headers = await authManager.getAuthHeaders();
            const response = await axios.post(endpoint, body, { headers, timeout: 30000 });
            return (response.data.rows || [])[0] || null;
        } catch (error) {
            if (attempt === retries) throw error;
            await delay(attempt * 3000);
        }
    }
}

async function upsertPageTotals(db, url, period, row) {
    const clicks = row ? row.clicks : 0;
    const impressions = row ? row.impressions : 0;
    const ctr = row ? row.ctr : null;
    const position = row ? row.position : null;

    await db.query(
        `INSERT INTO gsc.page_totals_by_period
            (url, period_label, period_start, period_end, clicks, impressions, ctr, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (url, period_label) DO UPDATE SET
            clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions,
            ctr = EXCLUDED.ctr, position = EXCLUDED.position, updated_at = CURRENT_TIMESTAMP`,
        [url, period.label, period.startDate, period.endDate, clicks, impressions, ctr, position]
    );
}

async function main() {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        throw new Error('GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET обязательны');
    }

    const urls = loadUrls();
    console.log(`URL для обработки: ${urls.length}`);
    console.log(`Периодов: ${PERIODS.length} (${PERIODS.map(p => p.label).join(', ')})`);

    const authManager = new GoogleAuthManager();
    const db = new DatabaseManager('gsc-page-totals');
    await db.connect();

    try {
        const schemaPath = path.join(__dirname, '..', 'services', 'gsc', 'page_totals_schema.sql');
        await db.query(fs.readFileSync(schemaPath, 'utf8'));

        let done = 0;
        const total = urls.length * PERIODS.length;

        for (const url of urls) {
            for (const period of PERIODS) {
                done++;
                process.stdout.write(`[${done}/${total}] ${period.label} ${url} ... `);

                try {
                    const row = await fetchPageTotals(authManager, url, period);
                    await upsertPageTotals(db, url, period, row);
                    console.log(row
                        ? `${row.impressions} показов, ${row.clicks} кликов`
                        : `нет данных (0)`);
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
    console.error('Ошибка сбора GSC page-totals:', error.message);
    process.exit(1);
});
