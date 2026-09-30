// scripts/migrate-wordstat-checklist.js
// Разовая миграция: переносит services/wordstat/keywords/dynamics_keywords_commercial.txt,
// dynamics_keywords_content.txt и top_keywords.txt в таблицу wordstat.check_list
// (common.requests + булевый флаг вместо .txt-файлов на сервере, см. 2026-09-30).
//
// Применить СНАЧАЛА schema.sql (создаёт wordstat.check_list), потом этот скрипт:
//   psql "$DATABASE_URL" -f services/wordstat/schema.sql
//   node scripts/migrate-wordstat-checklist.js
//
// Идемпотентно: ON CONFLICT (request_id, method) DO UPDATE — можно гонять повторно.
// Фразы, которых ещё нет в common.requests, создаются автоматически.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const DatabaseManager = require('../core/DatabaseManager');
const Logger = require('../core/Logger');

const logger = new Logger('wordstat-checklist-migration');
const KEYWORDS_DIR = path.join(__dirname, '..', 'services', 'wordstat', 'keywords');

function readKeywordFile(filename) {
    const filePath = path.join(KEYWORDS_DIR, filename);
    const content = fs.readFileSync(filePath, 'utf-8');
    return content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'));
}

async function upsertRequestId(db, phrase) {
    const result = await db.query(
        `INSERT INTO common.requests (request) VALUES ($1)
         ON CONFLICT (request) DO UPDATE SET request = EXCLUDED.request
         RETURNING request_id`,
        [phrase]
    );
    return result.rows[0].request_id;
}

async function upsertCheckListEntry(db, requestId, method, category) {
    await db.query(
        `INSERT INTO wordstat.check_list (request_id, method, category, is_active)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (request_id, method) DO UPDATE SET
             category = EXCLUDED.category,
             is_active = true,
             updated_at = CURRENT_TIMESTAMP`,
        [requestId, method, category]
    );
}

async function migrateFile(db, filename, method, category) {
    const phrases = readKeywordFile(filename);
    logger.info(`${filename}: ${phrases.length} фраз`);

    for (const phrase of phrases) {
        const requestId = await upsertRequestId(db, phrase);
        await upsertCheckListEntry(db, requestId, method, category);
    }
    return phrases.length;
}

async function main() {
    const db = new DatabaseManager('wordstat-checklist-migration');
    await db.connect();

    try {
        const commercial = await migrateFile(db, 'dynamics_keywords_commercial.txt', 'dynamics', 'commercial');
        const content = await migrateFile(db, 'dynamics_keywords_content.txt', 'dynamics', 'content');
        const top = await migrateFile(db, 'top_keywords.txt', 'top', null);

        logger.info(`Готово: dynamics/commercial=${commercial}, dynamics/content=${content}, top=${top}`);
    } finally {
        await db.disconnect();
    }
}

main().catch(err => {
    logger.error(`Ошибка миграции: ${err.message}`);
    process.exit(1);
});
