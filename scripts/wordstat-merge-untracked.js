// scripts/wordstat-merge-untracked.js
// Разовый скрипт: берёт services/wordstat/keywords/dynamics_keywords.txt (текущий список)
// и файл кандидатов (обычно scripts/output/wordstat-untracked.txt), убирает дубли
// (по точному совпадению, без изменения текста фраз — они должны 1-в-1 совпадать
// со значениями common.requests.request, иначе WordStatCollector их молча пропустит),
// раскладывает новые фразы по темам/подтемам и делит результат на ДВА файла:
//   - dynamics_keywords_commercial.txt — коммерчески значимые темы (DDoS-защита,
//     хостинг/VDS/DS, CDN, WAF, бренды/конкуренты, анализ защищённости, ОРИ и т.п.)
//   - dynamics_keywords_content.txt — образовательный/общий контент (OSI, TCP/UDP,
//     DNS, 2FA, капча, SQL-инъекции, XSS, MITM, шифрование, ошибка 404 и т.п.)
// Плюс:
//   - scripts/output/wordstat-merge-review.txt — фразы, отправленные в "Мусор/на ревью"
//   - scripts/output/wordstat-merge-report.txt — сводка по темам
//
// Существующие 552 фразы из dynamics_keywords.txt (ручная курация) переносятся
// в commercial-файл как есть, под своими исходными заголовками групп.
//
// Ничего не перезаписывает продовый dynamics_keywords.txt автоматически — сначала
// нужно посмотреть получившиеся файлы руками.
//
// Запуск: node scripts/wordstat-merge-untracked.js <путь_к_untracked.txt> [путь_к_dynamics_keywords.txt]

const fs = require('fs');
const path = require('path');

const untrackedPath = process.argv[2];
const dynamicsPath = process.argv[3] || path.join(__dirname, '..', 'services', 'wordstat', 'keywords', 'dynamics_keywords.txt');

if (!untrackedPath) {
    console.error('Использование: node scripts/wordstat-merge-untracked.js <untracked.txt> [dynamics_keywords.txt]');
    process.exit(1);
}

function readLines(filePath) {
    return fs.readFileSync(filePath, 'utf-8').split('\n').map(l => l.replace(/\r$/, ''));
}

// ---- 1. Читаем текущий dynamics_keywords.txt, сохраняем существующий текст целиком
const dynamicsRaw = readLines(dynamicsPath);
const existingSet = new Set(
    dynamicsRaw
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('#'))
        .map(l => l.toLowerCase())
);

// ---- 2. Читаем кандидатов
const candidateLines = readLines(untrackedPath)
    .map(l => l.trim())
    .filter(l => l.length > 0);

// ---- 3. Дедуп по точному (без учёта регистра) совпадению с уже имеющимися фразами
const seen = new Set();
const deduped = [];
for (const phrase of candidateLines) {
    const key = phrase.toLowerCase();
    if (existingSet.has(key)) continue;      // уже есть в dynamics_keywords.txt
    if (seen.has(key)) continue;             // дубль внутри самого untracked-файла
    seen.add(key);
    deduped.push(phrase);
}

// ---- 4. Правила классификации: [regex, "Тема — Подтема", категория], проверяются
// по порядку, первое совпадение побеждает. Категория: 'commercial' | 'content' | 'junk'.
// Составлено по фактическому содержимому untracked-файла.
const RULES = [
    // --- Мусор / данные для ручного ревью, не идёт в прод-файлы ---
    [/^".*"$/, 'МУСОР — фраза в кавычках (похоже на артефакт импорта)', 'junk'],
    [/^\d{1,3}[.,]?\d*$/, 'МУСОР — фраза-число без текста', 'junk'],
    [/личный кабинет|скзи тахограф|диски work|арион куртаж|гранд сервис экспресс|zahvat ru|servek ru|astrobl ru|mon95 ru|ddg server\b/i, 'МУСОР — не по теме (сторонние сервисы/личные кабинеты)', 'junk'],
    [/тест тьюринга|тьюринг/i, 'МУСОР — не по теме (тест Тьюринга/ИИ)', 'junk'],
    [/^(raid|raid \d|raid массив)/i, 'МУСОР — не по теме (RAID-массивы)', 'junk'],
    [/hh ru|hh специалист|вакансия|зарплата/i, 'МУСОР — вакансии/зарплаты (не коммерческая тематика)', 'junk'],
    [/kaspersky/i, 'МУСОР — чужой бренд (Kaspersky)', 'junk'],
    [/минecraft|майнкрафт|роблокс|roblox|samp|cs go|кс го|counter strike|steam|discord/i, 'МУСОР — игровой геймерский ддос (не B2B-тематика)', 'junk'],

    // --- DDoS: сленг / общие формы написания (коммерческое ядро бизнеса) ---
    [/^(д{1,2}[ое]{1,2}[дт]{1,2}[оеу]?с|дудос|додос|дедос|дидос|дтос|длос|доос|досс|двтос|дэдос|дудокс)/i, 'DDoS — сленг и варианты написания', 'commercial'],
    [/^(ddos|dddos|dds атака|d dos|d o s|do dos|doss)/i, 'DDoS — общее / варианты написания', 'commercial'],

    // --- DDoS: заказ/покупка (угрозный интент, но частотность полезна для мониторинга) ---
    [/заказать (ddos|ддос|дудос)|купить (ddos|ддос)|buy ddos|ddos на заказ|ddos атаку ez|ddos атака (заказать|купить)/i, 'DDoS — заказ/покупка атаки (мониторинг угроз)', 'commercial'],

    // --- DDoS: техники атаки ---
    [/syn.?flood|udp.?flood|icmp.?flood|http.?flood|ack.?flood|ping.?of.?death|slowloris|land attack|amplification|ботнет|botnet|pulse wave|dns amplification/i, 'DDoS — техники и типы атак', 'commercial'],

    // --- DDoS: инструменты/софт для атаки ---
    [/loic|hoic|stresser|booster ddos|ddos (tool|tools|script|скрипт|софт|программ|скачать|panel|panel купить)|ip stresser/i, 'DDoS — инструменты и софт для атак', 'commercial'],

    // --- DDoS: по цели (телефон/номер/банк/сайт и т.п. — сленговый спрос) ---
    [/ddos (на|по) (номер|телефон)|ддос (на|по) (номер|телефон)|дудос (на|по) (номер|телефон)|ddos банк|ddos втб|ddos ростелеком|ddos роскомнадзор/i, 'DDoS — атака "на заказ" по цели (номер/банк/сайт)', 'commercial'],

    // --- DDoS: общие вопросы "что такое / как защититься" (образовательный, но покупательский спрос) ---
    [/что такое ddos|что такое ддос|ddos атака что|ддос атака что|как защититься от ddos|как защититься от ддос|как проверить.*ddos|как определить.*ddos|расшифровка ddos|ddos расшифровка|ddos как читается|виды ddos|виды ддос|классификация ddos/i, 'DDoS — образовательные запросы (что это/виды/как защититься)', 'commercial'],

    // --- Anti-DDoS сервисы (англоязычные commercial-запросы) ---
    [/anti.?ddos|antiddos|ddos.?guard|ddosguard/i, 'DDoS — анти-DDoS сервисы и бренды', 'commercial'],

    // --- DDoS у хостинг/облачных провайдеров (конкурентная разведка) ---
    [/(yandex|selectel|timeweb|beget|reg ru|mikrotik|pfsense|nginx|cloudflare|keenetic|checkpoint|csf|usergate|qrator|bunny) (ddos|защит)/i, 'DDoS — защита у провайдеров/вендоров (конкуренты)', 'commercial'],

    // --- L3/L4/L7 термины (расширение существующих групп) ---
    [/\bl[34]\b|\bl7\b|layer 3|layer 4|l3\/l4|l3\/4/i, 'DDoS — L3/L4/L7 термины', 'commercial'],

    // --- CDN / WAF — смежные продукты ---
    [/\bcdn\b/i, 'Инфраструктура — CDN', 'commercial'],
    [/\bwaf\b/i, 'Инфраструктура — WAF', 'commercial'],

    // --- VPS/VDS/выделенный сервер (хостинг — продукт) ---
    [/выделенн\w+ сервер|dedicated server/i, 'Хостинг — выделенный сервер (общее)', 'commercial'],
    [/\bvps\b|\bvds\b/i, 'Хостинг — VPS/VDS (общее)', 'commercial'],
    [/kvm сервер|kvm консоль/i, 'Хостинг — VPS/VDS (общее)', 'commercial'],

    // --- Капча / антибот — образовательно-техническая тема, не отдельный продукт компании ---
    [/капч|captcha|recaptcse|recaptcha|антибот/i, 'Боты и капча — антибот/капча', 'content'],

    // --- 2FA — общая тема, не продукт ---
    [/2fa|двухфактор/i, 'Аутентификация — 2FA', 'content'],

    // --- Брутфорс/SQL/XSS/MITM — общее образование по векторам атак ---
    [/брутфорс|brute.?force/i, 'Атаки — брутфорс', 'content'],
    [/sql.?(инъекц|injection)/i, 'Атаки — SQL-инъекции', 'content'],
    [/\bxss\b|межсайтов\w+ скриптинг|cross site scripting/i, 'Атаки — XSS', 'content'],
    [/mitm|man in the middle|человек посередин|атака посредник/i, 'Атаки — MITM (человек посередине)', 'content'],

    // --- Вирусы-шифровальщики / вымогатели ---
    [/шифровальщик|вымогател|ransomware/i, 'Атаки — вирусы-шифровальщики/вымогатели', 'content'],

    // --- DNS / TCP/UDP/OSI — общесетевое образование, не продукт ---
    [/\bdns\b/i, 'Сеть и протоколы — DNS', 'content'],
    [/\bosi\b|модель osi|уровень модели|уровен\w+ osi/i, 'Сеть и протоколы — модель OSI', 'content'],
    [/\btcp\b|\budp\b|\bicmp\b|\barp\b|\bbgp\b/i, 'Сеть и протоколы — TCP/UDP/ARP/BGP', 'content'],
    [/сетевой трафик|сетевого трафика|балансировк\w+ (нагрузк|трафик)|маршрутизаци/i, 'Сеть и протоколы — трафик и маршрутизация', 'content'],

    // --- Ошибка 404 — контент ---
    [/404/i, 'Прочий контент — ошибка 404', 'content'],

    // --- Шифрование данных общее — образовательное (не путать с "Обработка ключей шифрования" — тот продукт остаётся в исходном файле) ---
    [/шифрован\w+ данн|криптограф\w+ средств/i, 'Шифрование — шифрование данных (общее)', 'content'],

    // --- Аудит/пентест/уязвимости — это существующие продукты компании (Анализ защищенности / Управление уязвимостями) ---
    [/пентест|тестирование на проникновение|аудит (безопасност|информационн|ит безопасност)|уязвимост/i, 'Безопасность — аудит и управление уязвимостями', 'commercial'],

    // --- Инциденты / соцынженерия / общая ИБ — образовательное ---
    [/инцидент/i, 'Безопасность — управление инцидентами', 'content'],
    [/социальн\w+ инженери/i, 'Безопасность — социальная инженерия', 'content'],
    [/информационн\w+ безопасност|кибербезопасност|киберугроз|кибератак/i, 'Безопасность — информационная безопасность (общее)', 'content'],

    // --- Организатор распространения информации — существующий продукт ---
    [/организатор распространения информации/i, 'Организатор распространения информации', 'commercial'],

    // --- Широкие "добор" правила (без строгого порядка слов) — идут ПОСЛЕ точных выше ---
    [/ддос/i, 'DDoS — общее / варианты написания', 'commercial'],
    [/(скзи|криптограф|шифрован)/i, 'Шифрование — шифрование данных (общее)', 'content'],
    [/(выделенн\w+ сервер|облачн\w+ сервер|арендовать сервер|аренда сервера)/i, 'Хостинг — выделенный/облачный сервер (общее)', 'commercial'],
    [/безопасност/i, 'Безопасность — информационная безопасность (общее)', 'content'],
    [/сетев\w+ (трафик|безопасност|инфраструктур|устройств|подключен|операционн)/i, 'Сеть и протоколы — трафик и маршрутизация', 'content'],
    [/(антивирус|вирус)/i, 'Атаки — вирусы-шифровальщики/вымогатели', 'content'],
    [/(скрипт(инг)?|уязвимост|взлом)/i, 'Безопасность — аудит и управление уязвимостями', 'commercial'],
];

const commercialBuckets = new Map(); // theme -> phrases[]
const contentBuckets = new Map();
const junk = [];

for (const phrase of deduped) {
    let matched = null;
    let category = null;
    for (const [re, label, cat] of RULES) {
        if (re.test(phrase)) { matched = label; category = cat; break; }
    }
    if (!matched) { matched = 'Прочее — не распознано автоматически (нужен ручной просмотр)'; category = 'content'; }

    if (category === 'junk') {
        junk.push(`${phrase}\t[${matched}]`);
        continue;
    }
    const buckets = category === 'commercial' ? commercialBuckets : contentBuckets;
    if (!buckets.has(matched)) buckets.set(matched, []);
    buckets.get(matched).push(phrase);
}

// ---- 5. Пишем результат
const outDir = path.join(__dirname, 'output');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

function writeGroupedFile(filePath, header, buckets) {
    let content = header;
    const sortedThemes = [...buckets.keys()].sort();
    let total = 0;
    for (const theme of sortedThemes) {
        const phrases = buckets.get(theme).sort((a, b) => a.localeCompare(b, 'ru'));
        content += `\n# Группа: ${theme}\n`;
        for (const p of phrases) content += `${p}\n`;
        total += phrases.length;
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    return total;
}

// commercial-файл: существующий dynamics_keywords.txt (ручная курация, как есть) +
// новые фразы, размеченные как коммерческие
let commercialHeader = dynamicsRaw.join('\n');
if (!commercialHeader.endsWith('\n')) commercialHeader += '\n';
commercialHeader += '\n# ============================================================\n';
commercialHeader += '# НИЖЕ — АВТОДОБАВЛЕНО из wordstat-untracked.txt (см. wordstat-merge-report.txt)\n';
commercialHeader += '# ============================================================\n';

const commercialPath = path.join(__dirname, '..', 'services', 'wordstat', 'keywords', 'dynamics_keywords_commercial.txt');
const contentPath = path.join(__dirname, '..', 'services', 'wordstat', 'keywords', 'dynamics_keywords_content.txt');

const commercialAdded = writeGroupedFile(commercialPath, commercialHeader, commercialBuckets);
const contentAdded = writeGroupedFile(
    contentPath,
    '# Контентные/образовательные запросы для WordStat (dynamics)\n' +
    '# Не привязаны к конкретному продукту — используются для контент-планирования.\n' +
    '# Формат идентичен dynamics_keywords_commercial.txt.\n',
    contentBuckets
);

const reviewPath = path.join(outDir, 'wordstat-merge-review.txt');
fs.writeFileSync(reviewPath, junk.join('\n') + '\n', 'utf-8');

let report = '';
report += '='.repeat(60) + '\n';
report += 'ОТЧЁТ ПО СЛИЯНИЮ dynamics_keywords.txt + untracked (2 файла)\n';
report += '='.repeat(60) + '\n';
report += `Кандидатов в untracked-файле:        ${candidateLines.length}\n`;
report += `Уже были в dynamics_keywords.txt:    ${candidateLines.length - deduped.length}\n`;
report += `Новых уникальных фраз (после дедупа): ${deduped.length}\n`;
report += `  -> commercial (новые):              ${commercialAdded}\n`;
report += `  -> content (новые):                 ${contentAdded}\n`;
report += `  -> отправлено в ревью (мусор):       ${junk.length}\n`;
report += '-'.repeat(60) + '\n';
report += 'Commercial — по темам:\n';
for (const theme of [...commercialBuckets.keys()].sort()) {
    report += `  ${String(commercialBuckets.get(theme).length).padStart(5)}  ${theme}\n`;
}
report += '-'.repeat(60) + '\n';
report += 'Content — по темам:\n';
for (const theme of [...contentBuckets.keys()].sort()) {
    report += `  ${String(contentBuckets.get(theme).length).padStart(5)}  ${theme}\n`;
}
report += '-'.repeat(60) + '\n';
const commercialTotal = existingSet.size + commercialAdded;
const contentTotal = contentAdded;
const quotaPerHour = 95;
report += `Commercial итого: ${existingSet.size} (было) + ${commercialAdded} (новых) = ${commercialTotal} фраз (~${Math.ceil(commercialTotal / quotaPerHour)} часовых прогонов)\n`;
report += `Content итого:    ${contentTotal} фраз (~${Math.ceil(contentTotal / quotaPerHour)} часовых прогонов)\n`;
report += `Всего: ${commercialTotal + contentTotal} фраз (~${Math.ceil((commercialTotal + contentTotal) / quotaPerHour)} часовых прогонов на оба списка)\n`;

const reportPath = path.join(outDir, 'wordstat-merge-report.txt');
fs.writeFileSync(reportPath, report, 'utf-8');

console.log(report);
console.log(`\n✅ Коммерческий список: ${commercialPath}`);
console.log(`✅ Контентный список:   ${contentPath}`);
console.log(`ℹ️  На ручное ревью (мусор):  ${reviewPath}`);
console.log(`📄 Полный отчёт:              ${reportPath}`);
console.log(`\nПродовый dynamics_keywords.txt НЕ изменён и НЕ используется по умолчанию —`);
console.log(`не забудь переключить коллектор на новые файлы (WORDSTAT_KEYWORDS_FILE).`);
