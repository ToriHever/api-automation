// scripts/run-sql-report.js
// Прогоняет SQL-файл с несколькими SELECT и сохраняет результат каждого запроса в CSV
// + общий all.md (markdown-таблицы) — чтобы не копировать вывод psql из терминала.
//
// Запуск:  node scripts/run-sql-report.js services/reports/analysis/gsc_drop_last_3m.sql
// Результат: scripts/output/sql-reports/<имя_файла>/Q0.csv, Q1.csv, ... и all.md
// (scripts/output/ в .gitignore). Креды берутся из .env через dotenv (PG*), как в остальных скриптах.
// Запросы нумеруются по заголовкам вида "-- Q2. ..." в файле; без заголовка — Q<порядковый номер>.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const DatabaseManager = require('../core/DatabaseManager');

function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(fields, rows) {
    const lines = [fields.map(csvCell).join(',')];
    for (const r of rows) lines.push(fields.map(f => csvCell(r[f])).join(','));
    return lines.join('\n') + '\n';
}

function toMarkdown(fields, rows) {
    const cell = v => csvCell(v).replace(/\|/g, '\\|');
    const out = ['| ' + fields.join(' | ') + ' |', '|' + fields.map(() => '---').join('|') + '|'];
    for (const r of rows) out.push('| ' + fields.map(f => cell(r[f])).join(' | ') + ' |');
    return out.join('\n');
}

async function main() {
    const file = process.argv[2];
    if (!file) {
        console.error('Использование: node scripts/run-sql-report.js <файл.sql>');
        process.exit(1);
    }
    const raw = fs.readFileSync(file, 'utf8');
    const labels = [...raw.matchAll(/^-- (Q\d+)\./gm)].map(m => m[1]);
    const statements = raw
        .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
        .split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean);

    const outDir = path.join(__dirname, 'output', 'sql-reports', path.basename(file, '.sql'));
    fs.mkdirSync(outDir, { recursive: true });

    const db = new DatabaseManager('run-sql-report');
    await db.connect();
    const md = [`# ${path.basename(file)} — ${new Date().toISOString()}`];
    try {
        for (let i = 0; i < statements.length; i++) {
            const label = labels.length === statements.length ? labels[i] : `Q${i}`;
            const res = await db.query(statements[i]);
            const fields = res.fields.map(f => f.name);
            fs.writeFileSync(path.join(outDir, `${label}.csv`), toCsv(fields, res.rows), 'utf8');
            md.push(`\n## ${label} (${res.rows.length} строк)\n`, toMarkdown(fields, res.rows));
            console.log(`${label}: ${res.rows.length} строк -> ${path.join(outDir, label + '.csv')}`);
        }
    } finally {
        await db.disconnect();
    }
    fs.writeFileSync(path.join(outDir, 'all.md'), md.join('\n') + '\n', 'utf8');
    console.log(`Сводка: ${path.join(outDir, 'all.md')}`);
}

main().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
