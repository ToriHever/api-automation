// scripts/sync-gsc-requests.js
// Вставляет в common.requests тексты запросов, которые уже есть в
// gsc.search_console, но никогда не попадали в common.requests. Без этого
// шага categorize-requests.js категоризирует только то, что уже есть в
// common.requests — новые запросы из GSC молча оставались без hub/cluster/
// topic/type_request навсегда (см. историю 2026-09-30: найдено, что этого
// шага в пайплайне никогда не было).
//
// Идемпотентно (ON CONFLICT DO NOTHING по UNIQUE(request)).
//
// Разовый бэкфилл: node scripts/sync-gsc-requests.js
// Встроено в пайплайн: scripts/run-service.js вызывает syncMissingRequests()
// сразу после сбора GSC, перед categorize-requests.

require('dotenv').config();
const DatabaseManager = require('../core/DatabaseManager');
const Logger = require('../core/Logger');

const logger = new Logger('gsc-requests-sync');

const INSERT_MISSING = `
    INSERT INTO common.requests (request)
    SELECT DISTINCT sc.request
    FROM gsc.search_console sc
    LEFT JOIN common.requests cr ON cr.request = sc.request
    WHERE cr.request_id IS NULL
    ON CONFLICT (request) DO NOTHING
`;

async function syncMissingRequests() {
    const db = new DatabaseManager('gsc-requests-sync');
    await db.connect();

    try {
        const result = await db.query(INSERT_MISSING);
        logger.info(`Добавлено новых запросов в common.requests: ${result.rowCount}`);
        return result.rowCount;
    } finally {
        await db.disconnect();
    }
}

module.exports = { syncMissingRequests };

if (require.main === module) {
    syncMissingRequests().catch(err => {
        logger.error(`Ошибка синка common.requests: ${err.message}`);
        process.exit(1);
    });
}
