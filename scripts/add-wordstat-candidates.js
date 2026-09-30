// scripts/add-wordstat-candidates.js
// Добавляет кандидатов на проверку Wordstat, но НЕ активирует их (is_active = false) —
// сначала копится список, потом отдельным решением включается отслеживание.
//
// Порядок:
//   1. Фразы из .txt-файла вставляются в common.requests (если их там ещё нет).
//   2. Проверяется, что ВСЕ они уже лемматизированы (есть group_id) — если нет,
//      скрипт останавливается и просит сначала прогнать scripts/lemmatize-requests.js
//      (требует запущенный python services/lemmatizer/app.py).
//   3. Из групп лемм этих фраз берётся ТОЛЬКО canonical_request (самый короткий
//      вариант в группе) — то есть разные словоформы одного смысла схлопываются
//      в одну фразу, не раздувая список и будущий счёт за API Wordstat.
//   4. Канонические фразы вставляются в wordstat.check_list с is_active = false.
//
// Запуск:
//   node scripts/add-wordstat-candidates.js <путь_к_файлу.txt> <method> [category]
//   method:   dynamics | top
//   category: commercial | content (только для method=dynamics)
//
// Пример:
//   node scripts/add-wordstat-candidates.js services/wordstat/keywords/candidates/2026-09-30_ddos-hosting-protection.txt dynamics commercial

require('dotenv').config();
const fs = require('fs');
const DatabaseManager = require('../core/DatabaseManager');
const Logger = require('../core/Logger');

const logger = new Logger('wordstat-candidates');

function readPhrases(filePath) {
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

async function main() {
    const [, , filePath, method, category] = process.argv;

    if (!filePath || !method) {
        console.error('Использование: node scripts/add-wordstat-candidates.js <файл.txt> <dynamics|top> [commercial|content]');
        process.exit(1);
    }
    if (!['dynamics', 'top'].includes(method)) {
        console.error(`Неверный method: "${method}" (нужно dynamics или top)`);
        process.exit(1);
    }
    if (method === 'dynamics' && !['commercial', 'content'].includes(category)) {
        console.error('Для method=dynamics обязателен category: commercial или content');
        process.exit(1);
    }

    const phrases = readPhrases(filePath);
    logger.info(`Фраз в файле: ${phrases.length}`);

    const db = new DatabaseManager('wordstat-candidates');
    await db.connect();

    try {
        // 1. Вставляем фразы в common.requests
        const requestIds = [];
        for (const phrase of phrases) {
            const requestId = await upsertRequestId(db, phrase);
            requestIds.push(requestId);
        }
        logger.info(`В common.requests: ${requestIds.length} request_id (новых и уже существовавших)`);

        // 2. Проверяем лемматизацию
        const { rows: notLemmatized } = await db.query(
            `SELECT request_id, request FROM common.requests
             WHERE request_id = ANY($1) AND group_id IS NULL`,
            [requestIds]
        );

        if (notLemmatized.length > 0) {
            console.error(`\n⚠️  ${notLemmatized.length} фраз ещё не лемматизированы (нет group_id):`);
            notLemmatized.slice(0, 10).forEach(r => console.error(`   - ${r.request}`));
            if (notLemmatized.length > 10) console.error(`   ...и ещё ${notLemmatized.length - 10}`);
            console.error('\nСначала прогоните:');
            console.error('  python services/lemmatizer/app.py   (в отдельном терминале)');
            console.error('  node scripts/lemmatize-requests.js');
            console.error('Потом запустите этот скрипт заново — он идемпотентен.');
            process.exit(1);
        }

        // 3. Канонические фразы (по одной на группу лемм) среди наших requestIds
        const { rows: canonical } = await db.query(
            `SELECT DISTINCT g.canonical_request, cr.request_id AS canonical_request_id
             FROM common.requests r
             JOIN common.request_groups g ON g.group_id = r.group_id
             JOIN common.requests cr ON cr.request = g.canonical_request
             WHERE r.request_id = ANY($1)`,
            [requestIds]
        );

        logger.info(`Уникальных групп лемм (канонических фраз): ${canonical.length} из ${phrases.length} исходных`);

        // 4. Вставляем канонические фразы в wordstat.check_list, is_active = false
        let inserted = 0;
        for (const row of canonical) {
            await db.query(
                `INSERT INTO wordstat.check_list (request_id, method, category, is_active)
                 VALUES ($1, $2, $3, false)
                 ON CONFLICT (request_id, method) DO NOTHING`,
                [row.canonical_request_id, method, category || null]
            );
            inserted++;
        }

        logger.info(`Готово. В wordstat.check_list добавлено ${inserted} канонических фраз (is_active = false).`);
        logger.info('Для активации: UPDATE wordstat.check_list SET is_active = true WHERE ...');
    } finally {
        await db.disconnect();
    }
}

main().catch(err => {
    logger.error(`Ошибка: ${err.message}`);
    process.exit(1);
});
