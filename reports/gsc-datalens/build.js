#!/usr/bin/env node
// Собирает самодостаточный HTML для DataLens (HTML-страницы): инлайнит CSS-токены
// и данные в template.html.
//
//   node build.js --demo                 # сгенерированные демо-данные
//   node build.js --data data.json       # реальная выгрузка (см. queries.sql)
//   node build.js --data data.json --out dist/report.html
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const out = path.resolve(__dirname, opt('--out') || 'dist/gsc-report.html');

function demoData() {
  let seed = 42;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const iso = (d) => d.toISOString().slice(0, 10);
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const curTo = new Date(today); curTo.setUTCDate(curTo.getUTCDate() - 2);
  const at = (base, n) => { const d = new Date(base); d.setUTCDate(d.getUTCDate() + n); return d; };
  const curFrom = at(curTo, -29), prevTo = at(curTo, -30), prevFrom = at(curTo, -59);

  const clusters = ['Защита от DDoS', 'CDN', 'WAF', 'dCAPTCHA', 'Хостинг', 'VPN', null];
  const stems = ['защита от ddos', 'ddos атака', 'anti ddos', 'cdn сервис', 'что такое waf', 'web application firewall',
    'защита сайта', 'капча для сайта', 'ddos-guard', 'ddos guard цена', 'l7 ddos', 'защита api', 'cdn для сайта',
    'как защитить сайт от ddos', 'защита от ботов', 'bot protection', 'ddos protection', 'сетевая защита'];
  const mods = ['', ' цена', ' купить', ' отзывы', ' что это', ' бесплатно', ' 2026', ' для интернет-магазина', ' как работает', ' сравнение'];
  const reqs = [];
  const seen = new Set();
  for (const s of stems) for (const m of mods) {
    if (rnd() < 0.45) continue;
    const request = s + m;
    if (seen.has(request)) continue;
    seen.add(request);
    const site = /ddos protection|bot protection|anti ddos/.test(s) ? 'EN' : 'RU';
    const brand = /ddos-guard|ddos guard/.test(s);
    const pos = 1 + rnd() * rnd() * 30;
    const impr = Math.round(50 + Math.pow(rnd(), 3) * 30000 / (1 + pos / 6));
    const ctr = Math.max(0.004, 0.32 * Math.exp(-pos / 4.5) * (0.7 + rnd() * 0.6) * (brand ? 2 : 1));
    const clicks = Math.round(impr * Math.min(ctr, 0.6));
    const trend = 0.75 + rnd() * 0.6;
    reqs.push({
      request, site, brand, cluster: clusters[Math.floor(rnd() * clusters.length)],
      clicks, impressions: impr, position: +pos.toFixed(2),
      clicks_prev: Math.round(clicks / trend), position_prev: +(pos + (rnd() - 0.5) * 3).toFixed(2),
    });
  }
  reqs.sort((a, b) => b.clicks - a.clicks);

  // Ежедневный ряд = разбиение суммы запросов по дням с недельной сезонностью и шумом.
  const daily = [];
  for (const period of ['current', 'previous']) {
    const from = period === 'current' ? curFrom : prevFrom;
    for (const site of ['RU', 'EN']) for (const brand of [false, true]) {
      const grp = reqs.filter((r) => r.site === site && r.brand === brand);
      const sum = (k) => grp.reduce((a, r) => a + (period === 'current' ? r[k] : (k === 'clicks' ? r.clicks_prev : r.impressions / 1.05)), 0);
      const w = Array.from({ length: 30 }, (_, i) => { const dow = at(from, i).getUTCDay(); return (dow === 0 || dow === 6 ? 0.6 : 1.1) * (0.85 + rnd() * 0.3); });
      const ws = w.reduce((a, b) => a + b, 0);
      const posAvg = grp.length ? grp.reduce((a, r) => a + r.position * r.impressions, 0) / grp.reduce((a, r) => a + r.impressions, 0) : 0;
      w.forEach((wi, i) => daily.push({
        date: iso(at(from, i)), period, site, brand,
        clicks: Math.round(sum('clicks') * wi / ws), impressions: Math.round(sum('impressions') * wi / ws),
        position: +(posAvg + (period === 'previous' ? 0.3 : 0) + (rnd() - 0.5) * 0.4).toFixed(2),
      }));
    }
  }
  return {
    demo: true, generated: iso(today),
    period: { from: iso(curFrom), to: iso(curTo), prev_from: iso(prevFrom), prev_to: iso(prevTo) },
    daily, requests: reqs,
  };
}

let data;
if (opt('--data')) {
  data = JSON.parse(fs.readFileSync(opt('--data'), 'utf8').replace(/^﻿/, ''));
  for (const k of ['period', 'daily', 'requests']) if (!data[k]) throw new Error(`data.json: нет поля "${k}"`);
} else if (args.includes('--demo')) {
  data = demoData();
} else {
  console.error('Укажите --demo или --data <file.json>'); process.exit(1);
}

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
// "</" в данных нельзя оставлять внутри <script>
const json = JSON.stringify(data).replace(/</g, '\\u003c');
const html = read('template.html')
  .replace('/*__TOKENS_CSS__*/', () => read('assets/dl-theme-tokens.css'))
  .replace('/*__DASHBOARD_CSS__*/', () => read('assets/dl-dashboard.css'))
  .replace('/*__DATA__*/null', () => json);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html, 'utf8');
console.log(`OK ${path.relative(process.cwd(), out)} — ${(Buffer.byteLength(html) / 1024).toFixed(0)} КБ, ` +
  `${data.requests.length} запросов, ${data.daily.length} дневных строк${data.demo ? ' (demo)' : ''}`);
