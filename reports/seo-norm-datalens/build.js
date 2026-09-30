#!/usr/bin/env node
// Собирает самодостаточный HTML для DataLens (HTML-страницы): инлайнит CSS-токены и данные
// в template.html. Формат и ограничения те же, что у reports/gsc-datalens (песочница без сети,
// проверка: python ../gsc-datalens/tools/validate_page.py dist/seo-norm-report.html).
//
//   node build.js                          # из data.snapshot.json (срез на 2026-09-30, см. make-snapshot.js)
//   node build.js --data data.json         # из реальной выгрузки БД (queries.sql)
//   node build.js --data data.json --out dist/report.html
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const out = path.resolve(__dirname, opt('--out') || 'dist/seo-norm-report.html');
const dataFile = path.resolve(__dirname, opt('--data') || 'data.snapshot.json');

const data = JSON.parse(fs.readFileSync(dataFile, 'utf8').replace(/^﻿/, ''));
for (const k of ['series', 'engines', 'segments', 'generated']) if (!data[k]) throw new Error(`data: нет поля "${k}"`);

// Токены и общий CSS переиспользуем из соседнего отчёта, чтобы не дублировать 60 КБ
const assets = path.join(__dirname, '..', 'gsc-datalens', 'assets');
const read = (f) => fs.readFileSync(f, 'utf8');
// "</" в данных нельзя оставлять внутри <script>
const json = JSON.stringify(data).replace(/</g, '\\u003c');
const html = read(path.join(__dirname, 'template.html'))
  .replace('/*__TOKENS_CSS__*/', () => read(path.join(assets, 'dl-theme-tokens.css')))
  .replace('/*__DASHBOARD_CSS__*/', () => read(path.join(assets, 'dl-dashboard.css')))
  .replace('/*__DATA__*/null', () => json);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html, 'utf8');
console.log(`OK ${path.relative(process.cwd(), out)} — ${(Buffer.byteLength(html) / 1024).toFixed(0)} КБ, `
  + `${data.series.length} рядов, источник данных: ${data.source || 'не указан'}`);
