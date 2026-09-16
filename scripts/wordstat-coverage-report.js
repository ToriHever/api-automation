// scripts/wordstat-coverage-report.js
// Сверка: ядро запросов (common.requests) vs TopVisor (topvisor.positions) vs
// список ежемесячного сбора частоты Wordstat (services/wordstat/keywords/dynamics_keywords.txt).
//
// Показывает:
//   1) сколько всего запросов в ядре;
//   2) сколько из них реально отслеживается TopVisor (по позициям за последние N дней);
//   3) сколько сейчас идёт в ежемесячный сбор частоты Wordstat (dynamics_keywords.txt);
//   4) КАНДИДАТЫ — запросы, которые TopVisor отслеживает, но которых нет в списке Wordstat
//      (их имеет смысл добавить для расширения покрытия по частоте);
//   5) запросы в ядре, которые вообще нигде не отслеживаются (для информации).
//
// Кандидаты сохраняются в scripts/output/wordstat-candidates.txt — по одной фразе на
// строку, готово для вставки в dynamics_keywords.txt.
//
// Запуск: node scripts/wordstat-coverage-report.js [--days 90]

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const DatabaseManager = require('../core/DatabaseManager');

const daysArgIdx = process.argv.indexOf('--days');
const TRACKED_WINDOW_DAYS = daysArgIdx !== -1 ? parseInt(process.argv[daysArgIdx + 1], 10) : 90;

function loadKeywordFile(filename) {
    const filePath = path.join(__dirname, '..', 'services', 'wordstat', 'keywords', filename);
    if (!fs.existsSync(filePath)) return new Set();
    const content = fs.readFileSync(filePath, 'utf-8');
    return new Set(
        content
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && !line.startsWith('#'))
    );
}

async function main() {
    const db = new DatabaseManager('wordstat-coverage-report');
    await db.connect();

    try {
        const dynamicsList = loadKeywordFile('dynamics_keywords.txt');
        const topList = loadKeywordFile('top_keywords.txt');

        const coreTotal = await db.query(`SELECT COUNT(*)::int AS cnt FROM common.requests`);

        const topvisorTracked = await db.query(
            `SELECT DISTINCT request FROM topvisor.positions
             WHERE event_date >= CURRENT_DATE - INTERVAL '${TRACKED_WINDOW_DAYS} days'`
        );
        const topvisorSet = new Set(topvisorTracked.rows.map(r => r.request));

        const coreRows = await db.query(`SELECT request FROM common.requests`);
        const coreSet = new Set(coreRows.rows.map(r => r.request));

        // Кандидаты: TopVisor отслеживает, а в ежемесячный сбор частоты (dynamics) не добавлено
        const candidates = [...topvisorSet].filter(r => !dynamicsList.has(r)).sort();

        // Запросы в ядре, которые нигде не отслеживаются (ни TopVisor, ни dynamics, ни top)
        const untracked = [...coreSet].filter(
            r => !topvisorSet.has(r) && !dynamicsList.has(r) && !topList.has(r)
        ).sort();

        console.log('='.repeat(60));
        console.log('📊 ПОКРЫТИЕ ЗАПРОСОВ');
        console.log('='.repeat(60));
        console.log(`Ядро (common.requests):                    ${coreTotal.rows[0].cnt}`);
        console.log(`Отслеживается TopVisor (за ${TRACKED_WINDOW_DAYS} дн.):        ${topvisorSet.size}`);
        console.log(`В ежемесячном сборе Wordstat (dynamics):    ${dynamicsList.size}`);
        console.log(`В разовом сборе Wordstat (top):             ${topList.size}`);
        console.log('-'.repeat(60));
        console.log(`Кандидаты на добавление в dynamics:         ${candidates.length}`);
        console.log(`  (отслеживаются TopVisor, но не в Wordstat dynamics)`);
        console.log(`Не отслеживаются нигде:                     ${untracked.length}`);
        console.log('='.repeat(60));

        const outDir = path.join(__dirname, 'output');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

        const candidatesPath = path.join(outDir, 'wordstat-candidates.txt');
        fs.writeFileSync(candidatesPath, candidates.join('\n') + '\n', 'utf-8');
        console.log(`\n✅ Кандидаты сохранены: ${candidatesPath}`);

        const untrackedPath = path.join(outDir, 'wordstat-untracked.txt');
        fs.writeFileSync(untrackedPath, untracked.join('\n') + '\n', 'utf-8');
        console.log(`ℹ️  Совсем не отслеживаемые сохранены: ${untrackedPath}`);

        if (candidates.length > 0) {
            const newTotal = dynamicsList.size + candidates.length;
            const quotaPerHour = parseInt(process.env.WORDSTAT_MAX_PER_RUN || '80', 10);
            const hoursNeeded = Math.ceil(newTotal / Math.min(quotaPerHour, 95));
            console.log(`\n📈 Если добавить всех кандидатов: ${dynamicsList.size} → ${newTotal} фраз.`);
            console.log(`   Часовых запусков на полный месячный сбор: ~${hoursNeeded} (при квоте ~95 факт. запросов/час).`);
        }
    } finally {
        await db.disconnect();
    }
}

main().catch(err => {
    console.error('Ошибка:', err);
    process.exit(1);
});
