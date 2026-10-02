// scripts/purchases-kpi.js
// Покупки из organic по продуктовым группам: загрузка помесячной выгрузки и KPI-диапазоны.
//
// Данные: services/reports/data/organic_monthly_products.csv (по группам) и organic_monthly_overall.csv (итог).
// Это НОВЫЕ плательщики из organic и сумма их оплат первого дня. Правило organic задаёт выгрузка.
//
// KPI-диапазон на квартал считается без сезонных индексов: покупок слишком мало (2 года, в месяц 1–40),
// чтобы выделить сезонность. Середина = среднее за последние 4 квартала. Границы = 80% интервал:
//   плательщики — отрицательное биномиальное (дисперсия месяца = m + φ·m², φ из данных, не меньше 0);
//   выручка — разброс месячных сумм из данных (у DS/L3-4 она определяется 1–2 крупными чеками, диапазон широкий).
// Диапазон на квартал = среднее ± 1,28·σ квартала, σ² квартала = 3 × дисперсия месяца (месяцы независимы).
// Надёжность: ok | low_volume (среднее < 8 плательщиков в квартал) | regime (L3-4: триал и скидка 99% с 2025-09/2026-04).
// Проверка «в диапазоне ли квартал» идёт по диапазону, построенному на 12 месяцах ДО этого квартала.
// Сигнал: 2 квартала подряд ниже нижней границы.
//
// Запуск:
//   node scripts/purchases-kpi.js              # показать отчёт по CSV (БД не нужна)
//   node scripts/purchases-kpi.js --apply      # записать данные и KPI в reports.purchases_*
//   --products <csv> --overall <csv>           # пути к файлам, если они не в services/reports/data/ (CSV не хранятся в git)

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../services/reports/data');
const GROUPS = ['L7', 'L3-4', 'DS', 'VDS', 'Хостинг'];
const Z80 = 1.2816;
const LOW_VOLUME = 8;
const REGIME_GROUPS = new Set(['L3-4']);

const normGroup = g => {
    const t = g.trim();
    const hit = GROUPS.find(x => x.toLowerCase() === t.toLowerCase());
    if (!hit) throw new Error(`Неизвестная группа продуктов: «${g}»`);
    return hit;
};

/** «1234,56» -> 1234.56; пусто -> null */
function parseNum(s) {
    if (s === undefined || s === null) return null;
    const t = String(s).trim().replace(/\s/g, '').replace(',', '.');
    if (t === '') return null;
    const n = Number(t);
    if (!Number.isFinite(n)) throw new Error(`Не число: «${s}»`);
    return n;
}

/** Минимальный CSV-разбор с кавычками (разделитель запятая, десятичная запятая внутри кавычек). */
function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', q = false;
    const src = text.replace(/^﻿/, '');
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (q) {
            if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; }
            else cell += c;
        } else if (c === '"') q = true;
        else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && src[i + 1] === '\n') i++;
            row.push(cell); cell = '';
            if (row.some(x => x !== '')) rows.push(row);
            row = [];
        } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); if (row.some(x => x !== '')) rows.push(row); }
    return rows;
}

const monthKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;

/** -> [{ month:'2025-10', product, payers, revenue, invoices }] */
function parseProducts(text) {
    const [, ...rows] = parseCsv(text);
    return rows.map(r => ({
        month: monthKey(Number(r[0]), Number(r[1])),
        product: normGroup(r[2]),
        payers: parseNum(r[3]) ?? 0,
        revenue: parseNum(r[4]) ?? 0,
        invoices: parseNum(r[5]) ?? 0
    }));
}

/** -> [{ month, payersTotal, payersOrganic, revenue, invoices }] (пустые месяцы без данных пропускаются) */
function parseOverall(text) {
    const [, ...rows] = parseCsv(text);
    return rows.filter(r => parseNum(r[2]) !== null).map(r => ({
        month: r[0].trim(),
        invoices: parseNum(r[3]),
        payersTotal: parseNum(r[4]),
        payersOrganic: parseNum(r[5]),
        revenue: parseNum(r[2])
    }));
}

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const sampleVar = a => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); };

const addMonths = (key, n) => {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return monthKey(d.getUTCFullYear(), d.getUTCMonth() + 1);
};
const quarterOf = key => { const [y, m] = key.split('-').map(Number); return `${y}-Q${Math.floor((m - 1) / 3) + 1}`; };
const quarterStart = q => { const [y, n] = q.split('-Q').map(Number); return monthKey(y, (n - 1) * 3 + 1); };

/** Ряд помесячных значений группы на окно из 12 месяцев, заканчивающееся перед `before` (месяц не включается). */
function window12(series, before) {
    const out = [];
    for (let i = 12; i >= 1; i--) {
        const k = addMonths(before, -i);
        if (!(k in series)) return null;
        out.push(series[k]);
    }
    return out;
}

/**
 * 80% диапазон квартала по 12 месячным значениям.
 * kind 'count' — NB по плательщикам, 'sum' — по разбросу месячных сумм. -> { low, mid, high }
 */
function quarterRange(months12, kind) {
    const mm = mean(months12);
    const mid = mm * 3;
    let varM;
    if (kind === 'count') {
        const v = sampleVar(months12);
        const phi = mm > 0 ? Math.max(0, (v - mm) / (mm * mm)) : 0;
        varM = mm + phi * mm * mm;
    } else {
        varM = sampleVar(months12);
    }
    const sd = Math.sqrt(3 * varM);
    return { low: Math.max(0, mid - Z80 * sd), mid, high: mid + Z80 * sd };
}

/**
 * rows: parseProducts. Возвращает по группам: помесячные ряды, квартальные факты и проверку по диапазону «до»,
 * KPI на следующий квартал.
 */
function analyze(rows, { lastMonth } = {}) {
    const last = lastMonth || rows.reduce((m, r) => (r.month > m ? r.month : m), '0000-00');
    const first = rows.reduce((m, r) => (r.month < m ? r.month : m), '9999-99');
    const result = {};
    for (const g of GROUPS) {
        const payers = {}, revenue = {};
        for (let k = first; k <= last; k = addMonths(k, 1)) { payers[k] = 0; revenue[k] = 0; }
        for (const r of rows.filter(x => x.product === g)) { payers[r.month] = r.payers; revenue[r.month] = r.revenue; }

        const quarters = {};
        for (const k of Object.keys(payers)) {
            const q = quarterOf(k);
            quarters[q] = quarters[q] || { months: 0, payers: 0, revenue: 0 };
            quarters[q].months++; quarters[q].payers += payers[k]; quarters[q].revenue += revenue[k];
        }
        const complete = Object.entries(quarters).filter(([, v]) => v.months === 3).map(([q, v]) => ({ quarter: q, payers: v.payers, revenue: v.revenue }));

        const checks = complete.map(c => {
            const ps = window12(payers, quarterStart(c.quarter)), rs = window12(revenue, quarterStart(c.quarter));
            if (!ps) return { ...c, range: null };
            const rp = quarterRange(ps, 'count'), rr = quarterRange(rs, 'sum');
            const st = (v, r) => (v < r.low ? 'below' : v > r.high ? 'above' : 'in');
            return { ...c, rangePayers: rp, rangeRevenue: rr, statusPayers: st(c.payers, rp), statusRevenue: st(c.revenue, rr) };
        });

        const nextQ = quarterOf(addMonths(last, 1));
        const ps = window12(payers, addMonths(last, 1)), rs = window12(revenue, addMonths(last, 1));
        const kpiPayers = ps ? quarterRange(ps, 'count') : null;
        const kpiRevenue = rs ? quarterRange(rs, 'sum') : null;
        const reliability = REGIME_GROUPS.has(g) ? 'regime' : (kpiPayers && kpiPayers.mid < LOW_VOLUME ? 'low_volume' : 'ok');

        // сигнал: 2 последних проверенных квартала подряд ниже нижней границы
        const tail = checks.filter(c => c.statusPayers).slice(-2);
        const signal = tail.length === 2 && tail.every(c => c.statusPayers === 'below' || c.statusRevenue === 'below')
            ? 'два квартала подряд ниже границы' : null;

        result[g] = { payers, revenue, complete, checks, next: { quarter: nextQ, payers: kpiPayers, revenue: kpiRevenue }, reliability, signal };
    }
    return { last, groups: result };
}

const fmt = n => Math.round(n).toLocaleString('ru-RU');
const fmtK = n => Math.round(n / 1000).toLocaleString('ru-RU');
const ST = { below: '↓ ниже', in: 'в диапазоне', above: '↑ выше' };

function printReport(an) {
    console.log(`Покупки из organic: данные по ${an.last} включительно\n`);
    for (const g of GROUPS) {
        const r = an.groups[g];
        console.log(`=== ${g} ===`);
        console.log('  Проверка кварталов по диапазону, построенному на 12 месяцах ДО квартала:');
        for (const c of r.checks.slice(-5)) {
            if (!c.rangePayers) continue;
            console.log(`    ${c.quarter}: плательщиков ${String(c.payers).padStart(3)} [${fmt(c.rangePayers.low)}–${fmt(c.rangePayers.high)}] ${ST[c.statusPayers]}; ` +
                `сумма ${fmtK(c.revenue)} тыс [${fmtK(c.rangeRevenue.low)}–${fmtK(c.rangeRevenue.high)}] ${ST[c.statusRevenue]}`);
        }
        const n = r.next;
        console.log(`  KPI ${n.quarter}: плательщиков ${fmt(n.payers.low)}–${fmt(n.payers.high)} (середина ${fmt(n.payers.mid)}); ` +
            `сумма ${fmtK(n.revenue.low)}–${fmtK(n.revenue.high)} тыс ₽ (середина ${fmtK(n.revenue.mid)})`);
        const note = { ok: 'надёжность: можно ставить KPI', low_volume: `надёжность: мало покупок (<${LOW_VOLUME} в квартал), ориентир`, regime: 'надёжность: режимная группа (триал, скидка 99%) — диапазон ориентировочный' }[r.reliability];
        console.log(`  ${note}${r.signal ? `; СИГНАЛ: ${r.signal}` : ''}\n`);
    }
}

async function apply(rows, overall, an) {
    require('dotenv').config();
    const DatabaseManager = require('../core/DatabaseManager');
    const db = new DatabaseManager('purchases-kpi');
    await db.connect();
    try {
        await db.query(fs.readFileSync(path.join(__dirname, '../services/reports/purchases_schema.sql'), 'utf8'));
        await db.query('BEGIN');
        try {
            for (const r of rows) {
                await db.query(
                    `INSERT INTO reports.purchases_monthly (month, product, new_payers, revenue_rub, invoices)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (month, product) DO UPDATE SET new_payers = EXCLUDED.new_payers,
                         revenue_rub = EXCLUDED.revenue_rub, invoices = EXCLUDED.invoices, updated_at = CURRENT_TIMESTAMP`,
                    [`${r.month}-01`, r.product, r.payers, r.revenue, r.invoices]);
            }
            for (const o of overall) {
                await db.query(
                    `INSERT INTO reports.purchases_overall_monthly (month, new_payers_total, new_payers_organic, revenue_organic_rub, invoices_organic)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (month) DO UPDATE SET new_payers_total = EXCLUDED.new_payers_total,
                         new_payers_organic = EXCLUDED.new_payers_organic, revenue_organic_rub = EXCLUDED.revenue_organic_rub,
                         invoices_organic = EXCLUDED.invoices_organic, updated_at = CURRENT_TIMESTAMP`,
                    [`${o.month}-01`, o.payersTotal, o.payersOrganic, o.revenue, o.invoices]);
            }
            for (const g of GROUPS) {
                const r = an.groups[g];
                for (const [metric, rg] of [['new_payers', r.next.payers], ['revenue_rub', r.next.revenue]]) {
                    await db.query(
                        `INSERT INTO reports.purchases_kpi (product, metric, quarter_start, low, mid, high, reliability, basis)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                         ON CONFLICT (product, metric, quarter_start) DO UPDATE SET low = EXCLUDED.low, mid = EXCLUDED.mid,
                             high = EXCLUDED.high, reliability = EXCLUDED.reliability, basis = EXCLUDED.basis, created_at = CURRENT_TIMESTAMP`,
                        [g, metric, `${quarterStart(r.next.quarter)}-01`, rg.low.toFixed(2), rg.mid.toFixed(2), rg.high.toFixed(2), r.reliability,
                            `12 мес. до ${an.last}, 80% интервал, без сезонности`]);
                }
            }
            await db.query('COMMIT');
        } catch (e) {
            await db.query('ROLLBACK');
            throw e;
        }
        console.log(`Записано: reports.purchases_monthly ${rows.length} строк, purchases_overall_monthly ${overall.length}, purchases_kpi ${GROUPS.length * 2}`);
    } finally {
        await db.disconnect();
    }
}

module.exports = { parseCsv, parseNum, parseProducts, parseOverall, quarterRange, analyze, quarterOf, addMonths };

if (require.main === module) {
    (async () => {
        const argOf = (n, def) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : def; };
        const read = (file, what) => {
            if (!fs.existsSync(file)) {
                throw new Error(`Нет файла ${file} (${what}). CSV не хранятся в git (*.csv в .gitignore): положите файл на сервер ` +
                    `или укажите путь: --products <файл> --overall <файл>`);
            }
            return fs.readFileSync(file, 'utf8');
        };
        const rows = parseProducts(read(argOf('products', path.join(DATA_DIR, 'organic_monthly_products.csv')), 'по продуктовым группам'));
        const overall = parseOverall(read(argOf('overall', path.join(DATA_DIR, 'organic_monthly_overall.csv')), 'итог по сайту'));
        const an = analyze(rows);
        printReport(an);
        if (process.argv.includes('--apply')) await apply(rows, overall, an);
        else console.log('(без --apply: в БД ничего не записано)');
    })().catch(e => { console.error(e.message); process.exit(1); });
}
