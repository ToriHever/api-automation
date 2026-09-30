// scripts/wordstat-product-demand.js
// Сбор месячной динамики Wordstat по фразам продуктов (для сезонных индексов спроса).
//
// 1. Заполняет reports.demand_phrases из групп проекта ddos-guard.ru в Топвизоре:
//    L3-4, L7, VDS/VPS (-> VDS), DS, Хостинг, Главная. Исключены DDG VM, Cloudflare,
//    dCAPTCHA, Аудит ИБ, ОРИ (в список групп не входят). В «Главную» — только type_request_id = 1
//    (коммерческие). Фразы с кластером «Заказ атаки?» включены сознательно.
// 2. Для фраз, у которых динамика за диапазон ещё не собрана, делает ОДИН запрос на фразу
//    за весь диапазон (PERIOD_MONTHLY) и пишет в wordstat.dynamics_range (upsert).
//
// Диапазон: с 2024-09-01 (после разделения сайтов ru/en) по конец прошлого месяца.
// Переопределение: DEMAND_RANGE_START / DEMAND_RANGE_END в .env.
// Квота Wordstat (100 запросов/час) общая с остальными сборами: за запуск берётся не больше
// WORDSTAT_MAX_PER_RUN (по умолчанию 80). Перезапуск безопасен — собранные фразы пропускаются.
//
// Запуск:
//   node scripts/wordstat-product-demand.js --dry-run   # только список фраз, без запросов к API
//   node scripts/wordstat-product-demand.js

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const DatabaseManager = require('../core/DatabaseManager');

const API_BASE_URL = 'https://searchapi.api.cloud.yandex.net/v2/wordstat';
const MAX_PER_RUN = parseInt(process.env.WORDSTAT_MAX_PER_RUN || '80', 10);
const SCHEMA_FILES = ['services/wordstat/dynamics_range_schema.sql', 'services/reports/demand_schema.sql']
    .map(f => path.join(__dirname, '..', f));

const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const RANGE_START = process.env.DEMAND_RANGE_START || '2024-09-01';
const RANGE_END = process.env.DEMAND_RANGE_END || (() => {
    const now = new Date();
    return fmt(new Date(now.getFullYear(), now.getMonth(), 0));   // последний день прошлого месяца
})();

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const SYNC_PHRASES_SQL = `
    INSERT INTO reports.demand_phrases (request_id, product, topvisor_group, source)
    SELECT DISTINCT r.request_id,
           CASE g.name WHEN 'VDS/VPS' THEN 'VDS' ELSE g.name END,
           g.name,
           'topvisor'
    FROM topvisor.dim_keywords k
    JOIN topvisor.dim_groups g ON g.id = k.group_id
    JOIN topvisor.dim_projects p ON p.id = k.project_id
    JOIN common.requests r ON r.request = k.name
    WHERE p.name = 'ddos-guard.ru'
      AND g.name IN ('L3-4', 'L7', 'VDS/VPS', 'DS', 'Хостинг', 'Главная')
      -- на «Главную» относим только коммерческие запросы (common.type_request: 1 = Коммерческий)
      AND (g.name <> 'Главная' OR r.type_request_id = 1)
    ON CONFLICT (request_id, product) DO NOTHING
`;

// Фразы, по которым диапазон ещё не собран (одна фраза может входить в несколько продуктов)
const PENDING_SQL = `
    SELECT r.request_id, r.request
    FROM (SELECT DISTINCT request_id FROM reports.demand_phrases WHERE is_active
          AND (fetched_from IS DISTINCT FROM $1::date OR fetched_to IS DISTINCT FROM $2::date)) dp
    JOIN common.requests r ON r.request_id = dp.request_id
    ORDER BY r.request_id
`;

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
    for (const item of response.data?.results || []) {
        const count = (item.count === undefined || item.count === null) ? 0 : Number(item.count);
        if (!Number.isNaN(count)) monthlyData[item.date.substring(0, 10)] = count;
    }
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
    await db.query(
        `UPDATE reports.demand_phrases SET fetched_from = $2, fetched_to = $3, fetched_at = CURRENT_TIMESTAMP
         WHERE request_id = $1`,
        [requestId, RANGE_START, RANGE_END]
    );
    return months.length;
}

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    if (!dryRun && (!process.env.WORDSTAT_API_KEY || !process.env.WORDSTAT_FOLDER_ID)) {
        throw new Error('WORDSTAT_API_KEY и WORDSTAT_FOLDER_ID обязательны');
    }

    const db = new DatabaseManager('wordstat-product-demand');
    await db.connect();

    try {
        for (const f of SCHEMA_FILES) await db.query(fs.readFileSync(f, 'utf8'));
        const sync = await db.query(SYNC_PHRASES_SQL);
        console.log(`Диапазон: ${RANGE_START} .. ${RANGE_END}. Новых привязок фраза→продукт: ${sync.rowCount}`);

        const summary = await db.query(
            `SELECT product, COUNT(*)::int AS phrases FROM reports.demand_phrases WHERE is_active GROUP BY 1 ORDER BY 1`
        );
        console.log('Фраз по продуктам: ' + summary.rows.map(r => `${r.product}=${r.phrases}`).join(', '));

        const pending = (await db.query(PENDING_SQL, [RANGE_START, RANGE_END])).rows;
        const batch = pending.slice(0, MAX_PER_RUN);
        console.log(`Нужно собрать фраз: ${pending.length}, беру в этот запуск: ${batch.length}`);

        if (dryRun) {
            batch.forEach(r => console.log(`  ${r.request_id}\t${r.request}`));
            console.log('(dry-run: запросы к API не выполнялись)');
            return;
        }

        let done = 0;
        for (let i = 0; i < batch.length; i++) {
            const { request_id: requestId, request: phrase } = batch[i];
            process.stdout.write(`[${i + 1}/${batch.length}] "${phrase}" ... `);
            try {
                const monthlyData = await fetchDynamicsRange(phrase);
                const written = await saveMonthlyData(db, requestId, monthlyData);
                done++;
                console.log(`${written} мес. (request_id=${requestId})`);
            } catch (error) {
                const status = error.response?.status;
                const message = error.response?.data?.message || error.message;
                console.log(`ОШИБКА ${status || ''}: ${message}`);
                if (status === 429) {
                    console.log('Квота исчерпана — остановка. Запустите скрипт снова через час, собранные фразы будут пропущены.');
                    break;
                }
            }
            await delay(300);
        }
        console.log(`\nСобрано за запуск: ${done}. Осталось: ${pending.length - done}`);
    } finally {
        await db.disconnect();
    }
}

main().catch(error => {
    console.error('Ошибка сбора спроса по продуктам:', error.message);
    process.exit(1);
});
