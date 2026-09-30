// scripts/categorize-requests.js
// Прогоняет автокатегоризацию common.requests (cluster_id / topic_id / hub_id)
// по ключевым словам: выполняет services/common/data/2026-08_categorize_requests.sql.
//
// Запуск вручную: npm run categorize   (или node scripts/categorize-requests.js)
// Автозапуск: scripts/run-service.js вызывает runCategorization() после успешного
// сбора GSC.
//
// Идемпотентно: SQL трогает только строки с cluster_id/topic_id/hub_id IS NULL,
// уже проставленные категории не перезаписываются. Файл целиком в одной
// транзакции (BEGIN ... COMMIT внутри самого SQL).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const DatabaseManager = require('../core/DatabaseManager');
const Logger = require('../core/Logger');

const SQL_FILE = path.join(__dirname, '..', 'services', 'common', 'data', '2026-08_categorize_requests.sql');

const logger = new Logger('categorizer');

const COUNT_UNCATEGORIZED = `
    SELECT
        COUNT(*) FILTER (WHERE cluster_id IS NULL) AS no_cluster,
        COUNT(*) FILTER (WHERE topic_id IS NULL)   AS no_topic,
        COUNT(*) FILTER (WHERE hub_id IS NULL)     AS no_hub,
        COUNT(*)                                   AS total
    FROM common.requests
`;

async function runCategorization() {
    const db = new DatabaseManager('categorizer');
    await db.connect();

    try {
        const { rows: [before] } = await db.query(COUNT_UNCATEGORIZED);
        logger.info(`Без категории до: cluster=${before.no_cluster}, topic=${before.no_topic}, hub=${before.no_hub} (всего ${before.total})`);

        await db.query(fs.readFileSync(SQL_FILE, 'utf8'));

        const { rows: [after] } = await db.query(COUNT_UNCATEGORIZED);
        logger.info(`Без категории после: cluster=${after.no_cluster}, topic=${after.no_topic}, hub=${after.no_hub}`);

        return { before, after };
    } catch (err) {
        // SQL-файл сам открывает BEGIN — при ошибке внутри транзакции откатываем.
        await db.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        await db.disconnect();
    }
}

module.exports = { runCategorization };

if (require.main === module) {
    runCategorization().catch(err => {
        logger.error(`Ошибка категоризации: ${err.message}`);
        process.exit(1);
    });
}
