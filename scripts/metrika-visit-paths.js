// scripts/metrika-visit-paths.js
// Путь посетителя к регистрации и оплате по ВИЗИТАМ (Яндекс Метрика, Logs API, 2026 год): с какой страницы человек впервые
// пришёл (блог/термины/главная/продукты…), сколько визитов прошло до регистрации и оплаты, какие входные страницы ведут
// к регистрации/оплате чаще. Метрика даёт ClientID (cookie браузера) — путь анонимный, с customer_id из админки не связывается.
// Цели: Y - registration (293671240), Ecommerce: purchase (326195013), begin_checkout (305346600), add_payment_info (305346627).
//
// Шаги:
//   --fetch   выгрузить визиты через Logs API в tmp/metrika-visits/YYYY-MM.tsv (месяц = один запрос; готовые месяцы пропускаются)
//   --analyze прочитать выгрузку и напечатать сводки (по умолчанию делает оба шага)
//   --refresh перезапросить выгрузку заново
//   --organic считать только визиты из органики (lastTrafficSource = organic) для первого визита
//
//   node scripts/metrika-visit-paths.js --from 2026-01
//   node scripts/metrika-visit-paths.js --analyze --organic
//
// ClientID не печатается и в БД не пишется. Выгрузка хранится локально в tmp/ (в .gitignore).

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { arg, withRetry } = require('./traffic-history-36m');

const BASE = 'https://api-metrica.yandex.net/management/v1/counter';
const DIR = path.join(__dirname, '..', 'tmp', 'metrika-visits');
const FIELDS = ['ym:s:visitID', 'ym:s:clientID', 'ym:s:dateTime', 'ym:s:startURL', 'ym:s:lastTrafficSource', 'ym:s:lastSearchEngineRoot',
    'ym:s:isNewUser', 'ym:s:pageViews', 'ym:s:goalsID'];
const GOAL = { registration: '293671240', purchase: '326195013', checkout: '305346600', payment: '305346627' };
const INFO_SECTIONS = new Set(['blog', 'terms', 'tutorials', 'technologies', 'case-studies', 'osi-model']);
const PRODUCT_SECTIONS = {
    'web-protection': 'L7', 'network-protection': 'L3-4', 'vds-vps': 'VDS', server: 'DS', hosting: 'Хостинг',
    waf: 'Прочие продукты', 'bot-mitigation': 'Прочие продукты', captcha: 'Прочие продукты', ori: 'Прочие продукты',
    'security-audit': 'Прочие продукты', dns: 'Прочие продукты', migration: 'Прочие продукты'
};
const DAY = 86400000;

/** Тип страницы входа: Информационные | Главная | L7 | L3-4 | VDS | DS | Хостинг | Прочие продукты | ЛК | Прочее */
function classifyUrl(url) {
    let u;
    try { u = new URL(url); } catch (e) { return 'Прочее'; }
    if (/^my\./.test(u.hostname)) return 'ЛК';
    const seg = u.pathname.toLowerCase().split('/').filter(Boolean)[0] || '';
    if (!seg) return 'Главная';
    if (INFO_SECTIONS.has(seg)) return 'Информационные';
    return PRODUCT_SECTIONS[seg] || 'Прочее';
}

/** Строка TSV Logs API -> визит. Целей нет — goals пустой Set. */
function parseVisit(cols, idx) {
    const goalsRaw = (cols[idx['ym:s:goalsID']] || '').replace(/[\[\]\s]/g, '');
    return {
        clientId: cols[idx['ym:s:clientID']],
        t: Date.parse(String(cols[idx['ym:s:dateTime']]).replace(' ', 'T') + '+03:00'),
        url: cols[idx['ym:s:startURL']] || '',
        source: cols[idx['ym:s:lastTrafficSource']] || '',
        isNew: cols[idx['ym:s:isNewUser']] === '1',
        goals: new Set(goalsRaw ? goalsRaw.split(',') : [])
    };
}

const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * visits: [{ clientId, t, url, source, isNew, goals:Set }]. Возвращает сводки.
 * cohort: новые посетители (первый визит в выгрузке с isNew) по типу входной страницы — доля зарегистрировавшихся / оплативших за 30 дней;
 * paths: для зарегистрировавшихся и оплативших — визитов до цели, тип первой страницы, был ли в истории визит на информационную.
 */
function analyze(visits, { organicOnly = false, windowDays = 30, lastDate = null } = {}) {
    const byClient = new Map();
    for (const v of visits) {
        if (!byClient.has(v.clientId)) byClient.set(v.clientId, []);
        byClient.get(v.clientId).push(v);
    }
    const end = lastDate ?? visits.reduce((m, v) => Math.max(m, v.t), 0);
    const cohort = new Map();      // тип -> { n, reg, pay }
    const paths = { registration: [], purchase: [] };
    for (const list of byClient.values()) {
        list.sort((a, b) => a.t - b.t);
        const first = list[0];
        const firstType = classifyUrl(first.url);
        if (first.isNew && (!organicOnly || first.source === 'organic') && first.t + windowDays * DAY <= end) {
            const c = cohort.get(firstType) || { n: 0, reg: 0, pay: 0 };
            c.n++;
            if (list.some(v => v.goals.has(GOAL.registration) && v.t <= first.t + windowDays * DAY)) c.reg++;
            if (list.some(v => v.goals.has(GOAL.purchase) && v.t <= first.t + windowDays * DAY)) c.pay++;
            cohort.set(firstType, c);
        }
        if (organicOnly && first.source !== 'organic') continue;
        for (const [key, goal] of [['registration', GOAL.registration], ['purchase', GOAL.purchase]]) {
            const i = list.findIndex(v => v.goals.has(goal));
            if (i < 0) continue;
            const before = list.slice(0, i + 1);
            paths[key].push({
                visits: i + 1, firstType, hadInfo: before.some(v => classifyUrl(v.url) === 'Информационные'),
                types: new Set(before.map(v => classifyUrl(v.url))), firstUrl: first.url
            });
        }
    }
    const summarize = list => ({
        n: list.length,
        medianVisits: median(list.map(p => p.visits)),
        single: list.filter(p => p.visits === 1).length,
        firstInfo: list.filter(p => p.firstType === 'Информационные').length,
        hadInfo: list.filter(p => p.hadInfo).length,
        firstByType: [...list.reduce((m, p) => m.set(p.firstType, (m.get(p.firstType) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1])
    });
    return { cohort: [...cohort.entries()].sort((a, b) => b[1].n - a[1].n), registration: summarize(paths.registration), purchase: summarize(paths.purchase),
        topFirstUrls: key => [...paths[key].reduce((m, p) => { const k = (() => { try { return new URL(p.firstUrl).pathname.toLowerCase().replace(/\/$/, '') || '/'; } catch (e) { return p.firstUrl; } })(); return m.set(k, (m.get(k) || 0) + 1); }, new Map())].sort((a, b) => b[1] - a[1]).slice(0, 15) };
}

// ---- Logs API ----
async function fetchMonth(counterId, headers, mo) {
    const file = path.join(DIR, `${mo.key}.tsv`);
    if (fs.existsSync(file) && !process.argv.includes('--refresh')) { console.log(`${mo.key}: уже выгружен (${file})`); return; }
    const params = { date1: mo.start, date2: mo.end, fields: FIELDS.join(','), source: 'visits' };
    const ev = (await withRetry(async () => (await axios.get(`${BASE}/${counterId}/logrequests/evaluate`, { params, headers, timeout: 60000 })).data, 'logs evaluate')).log_request_evaluation;
    if (!ev.possible) throw new Error(`Logs API: запрос за ${mo.key} невозможен (${JSON.stringify(ev)})`);
    const created = (await withRetry(async () => (await axios.post(`${BASE}/${counterId}/logrequests`, null, { params, headers, timeout: 60000 })).data, 'logs create')).log_request;
    const id = created.request_id;
    let req = created;
    for (let i = 0; i < 360 && req.status !== 'processed'; i++) {
        await new Promise(r => setTimeout(r, 10000));
        req = (await withRetry(async () => (await axios.get(`${BASE}/${counterId}/logrequest/${id}`, { headers, timeout: 60000 })).data, 'logs status')).log_request;
        if (['processing_failed', 'canceled', 'cleaned_by_user', 'cleaned_automatically_as_too_old'].includes(req.status)) throw new Error(`Logs API: статус ${req.status} (${mo.key})`);
    }
    if (req.status !== 'processed') throw new Error(`Logs API: запрос ${mo.key} не обработан за 1 час`);
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${file}.part`;
    fs.writeFileSync(tmp, '');
    let header = null;
    for (const part of req.parts) {
        const text = (await withRetry(async () => (await axios.get(`${BASE}/${counterId}/logrequest/${id}/part/${part.part_number}/download`, { headers, timeout: 600000, responseType: 'text', transformResponse: x => x })).data, 'logs download'));
        const lines = text.split('\n');
        if (!header) { header = lines[0]; fs.appendFileSync(tmp, header + '\n'); }
        fs.appendFileSync(tmp, lines.slice(1).filter(Boolean).join('\n') + '\n');
    }
    fs.renameSync(tmp, file);
    await withRetry(async () => axios.post(`${BASE}/${counterId}/logrequest/${id}/clean`, null, { headers, timeout: 60000 }), 'logs clean').catch(() => {});
    console.log(`${mo.key}: выгружено, частей ${req.parts.length}`);
}

function loadVisits() {
    const visits = [];
    for (const f of fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(x => x.endsWith('.tsv')).sort() : []) {
        const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter(Boolean);
        const header = lines[0].split('\t'), idx = Object.fromEntries(header.map((h, i) => [h, i]));
        for (const l of lines.slice(1)) visits.push(parseVisit(l.split('\t'), idx));
    }
    return visits;
}

const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '—');

function print(res, organicOnly) {
    console.log(`\nКогорты новых посетителей (первый визит 2026 с окном 30 дней${organicOnly ? ', первый визит из органики' : ''}):`);
    console.log('  тип входной страницы        посетителей  зарегистрировались  оплатили');
    for (const [t, c] of res.cohort) console.log(`  ${t.padEnd(26)} ${String(c.n).padStart(9)}  ${String(c.reg).padStart(8)} (${pct(c.reg, c.n).padStart(5)})  ${String(c.pay).padStart(5)} (${pct(c.pay, c.n)})`);
    for (const [key, title] of [['registration', 'Регистрация'], ['purchase', 'Оплата']]) {
        const s = res[key];
        console.log(`\n${title}: ${s.n} посетителей достигли цели${organicOnly ? ' (первый визит из органики)' : ''}`);
        console.log(`  визитов до цели (медиана): ${s.medianVisits}; цель в первом визите: ${s.single} (${pct(s.single, s.n)})`);
        console.log(`  первый визит на информационной странице: ${s.firstInfo} (${pct(s.firstInfo, s.n)}); информационная была в истории до цели: ${s.hadInfo} (${pct(s.hadInfo, s.n)})`);
        console.log('  тип первой страницы: ' + s.firstByType.map(([t, n]) => `${t} ${n} (${pct(n, s.n)})`).join('; '));
        console.log('  топ первых страниц: ' + res.topFirstUrls(key).slice(0, 10).map(([u, n]) => `${u} ${n}`).join('; '));
    }
}

module.exports = { classifyUrl, parseVisit, analyze, GOAL };

async function main() {
    const only = process.argv.includes('--analyze'), organicOnly = process.argv.includes('--organic');
    if (!only) {
        const counterId = process.env.YANDEX_METRIKA_COUNTER_ID_RU || process.env.YANDEX_METRIKA_COUNTER_ID;
        const token = process.env.YANDEX_METRIKA_TOKEN;
        if (!counterId || !token) throw new Error('Не заданы YANDEX_METRIKA_COUNTER_ID(_RU) / YANDEX_METRIKA_TOKEN');
        const { monthsFrom } = require('./ga4-customer-journey.js');
        const headers = { Authorization: `OAuth ${token}` };
        for (const mo of monthsFrom(arg('from', '2026-01'))) await fetchMonth(counterId, headers, mo);
    }
    const visits = loadVisits();
    console.log(`\nВизитов в выгрузке: ${visits.length}, посетителей: ${new Set(visits.map(v => v.clientId)).size}`);
    print(analyze(visits, { organicOnly }), organicOnly);
}

if (require.main === module) main().catch(e => { console.error(e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
