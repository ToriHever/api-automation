#!/usr/bin/env node
// Строит data.snapshot.json — срез данных на 2026-09-30 для HTML-отчёта, БЕЗ доступа к БД.
// Месячные значения — из результатов запросов к reports.traffic_organic_engine / gsc_segment_monthly,
// присланных из прод-БД 2026-09-30 (органика ru, GA4 и Метрика, по поисковикам; сегменты GSC).
// Индексы и норма пересчитываются ТЕМИ ЖЕ функциями, что работают на сервере
// (scripts/seasonality-index.js: computeSeasonality, scripts/seo-traffic-norm.js: computeNorm),
// и совпадают с выводом `node scripts/seo-traffic-norm.js --dry-run` на сервере.
// Для актуального отчёта из БД: queries.sql -> data.json -> node build.js --data data.json.
//
//   node make-snapshot.js
const fs = require('fs');
const path = require('path');
const { computeSeasonality } = require('../../scripts/seasonality-index.js');
const { computeNorm } = require('../../scripts/seo-traffic-norm.js');

// Органика ru по месяцам, 2024-10 .. 2026-09 (24 значения)
const RAW = {
  seo_traffic_ga4:            [11646,12924,11994,10938,11301,12422,12987,11459,12560,10639,4654,11783,13342,12388,13513,11712,12699,14117,11517,9853,9048,8145,8334,8418],
  seo_traffic_metrika:        [9066,10039,9181,8252,8269,9130,9085,7815,7955,7366,6630,8122,9083,7883,8182,7335,8293,9204,7313,6043,5422,4652,4864,5026],
  seo_traffic_ga4_google:     [9856,10674,9638,8807,9033,9757,10233,8143,8656,7585,3329,9189,10010,9166,9728,8333,9871,11240,9172,8013,7029,6428,6254,6241],
  seo_traffic_ga4_yandex:     [1701,2129,2183,1986,2025,2431,2541,2438,2736,1948,866,2195,2925,2657,2774,2281,2325,2506,1915,1377,1635,1287,1585,1834],
  seo_traffic_metrika_google: [7515,7879,7106,6580,6537,7017,7042,5863,5762,5673,5092,6339,6727,5831,6177,5532,6342,7272,5741,4908,4033,3468,3406,3452],
  seo_traffic_metrika_yandex: [1504,2111,1995,1608,1607,2017,1976,1866,2101,1603,1466,1699,2244,1942,1903,1688,1846,1827,1436,1031,1333,1136,1407,1521],
};
const LABELS = {
  seo_traffic_ga4: ['Органика, все поисковики — GA4 (основной)', 1],
  seo_traffic_metrika: ['Органика, все поисковики — Метрика (сверка)', 2],
  seo_traffic_ga4_google: ['Органика Google — GA4', 3],
  seo_traffic_metrika_google: ['Органика Google — Метрика', 4],
  seo_traffic_ga4_yandex: ['Органика Яндекс — GA4', 5],
  seo_traffic_metrika_yandex: ['Органика Яндекс — Метрика', 6],
};
// Метрика — запасной источник формы сезонности для рядов GA4 (см. seo-traffic-norm.js)
const FALLBACK = {
  seo_traffic_ga4: 'seo_traffic_metrika',
  seo_traffic_ga4_google: 'seo_traffic_metrika_google',
  seo_traffic_ga4_yandex: 'seo_traffic_metrika_yandex',
};
const GA4_GAP = new Set(['2025-07', '2025-08']);   // сбой сбора GA4 30.07–17.08.2025 — месяцы неполные
const PARTIAL = new Set(['2026-09']);              // текущий месяц: данные за 29 из 30 дней
const EVENTS = [{ month_from: '2026-04-01', month_to: '2026-09-01', action: 'exclude', description: 'падение органики ru с апреля 2026' }];

const pad = (m) => String(m).padStart(2, '0');
const daysIn = (y, m) => new Date(y, m, 0).getDate();
const monthOf = (i) => { const idx = 2024 * 12 + 9 + i; return { y: Math.floor(idx / 12), m: (idx % 12) + 1 }; };

function rowsFor(key) {
  return RAW[key].map((value, i) => {
    const { y, m } = monthOf(i);
    const ym = `${y}-${pad(m)}`;
    const complete = !(PARTIAL.has(ym) || (key.startsWith('seo_traffic_ga4') && GA4_GAP.has(ym)));
    return { month: `${ym}-01`, value, complete, days: daysIn(y, m), daysTotal: daysIn(y, m), perDay: value / daysIn(y, m) };
  });
}

const seasonal = {};
for (const key of Object.keys(RAW)) seasonal[key] = computeSeasonality(rowsFor(key), EVENTS, { minMonths: 6 });

const series = [];
const skipped = [];
for (const key of Object.keys(RAW)) {
  const s = seasonal[key];
  // seasonality_monthly в БД хранит value_per_day; computeSeasonality уже отдаёт его
  const fb = FALLBACK[key] ? seasonal[FALLBACK[key]].index : [];
  const norm = computeNorm(s.monthly, s.index, { levelMonths: 12, horizon: 12, fallbackIndex: fb });
  if (!norm.reliability.ok) { skipped.push({ key, label: LABELS[key][0], reason: norm.reliability.reason }); continue; }
  series.push({
    key, label: LABELS[key][0], sort: LABELS[key][1], kind: 'traffic',
    level: +norm.level.toFixed(1), band: +(norm.band * 100).toFixed(1), basis: norm.basis,
    rows: norm.rows.map((r) => ({
      m: r.month.slice(0, 7), actual: r.actual_total, expected: r.expected_total, low: r.expected_low, high: r.expected_high,
      dev: r.deviation_pct === null ? null : +r.deviation_pct.toFixed(1), status: r.status, conf: r.confidence,
      forecast: r.is_forecast, ins: r.in_sample, si: r.seasonal_index === null ? null : +r.seasonal_index.toFixed(3), seasons: r.seasons_used,
    })),
  });
}
series.sort((a, b) => a.sort - b.sort);
skipped.push({ key: 'en (все ряды)', label: 'Сайт en (ddos-guard.net), GA4 и Метрика',
  reason: 'устойчивый тренд вниз: уровень сезонов различается на 21–38%, коридор ±28…±59% — индекс описывает спад, а не сезонность' });

// Органика по поисковикам, GA4 — без месяцев сбоя (они неполные)
const engines = RAW.seo_traffic_ga4.map((_, i) => {
  const { y, m } = monthOf(i);
  const ym = `${y}-${pad(m)}`;
  const gap = GA4_GAP.has(ym);
  return {
    m: ym,
    ga4_google: gap ? null : RAW.seo_traffic_ga4_google[i], ga4_yandex: gap ? null : RAW.seo_traffic_ga4_yandex[i],
    metrika_google: RAW.seo_traffic_metrika_google[i], metrika_yandex: RAW.seo_traffic_metrika_yandex[i],
  };
});

// Сегменты GSC (клики в день), reports.v_gsc_segment_share
const SEG = [
  ['2025-09', 1.1, 45.5, 1.3, 7.5, 28, 30], ['2025-10', 1.2, 49.5, 0.9, 8.1, 31, 31], ['2025-11', 1.3, 41.9, 0.9, 3.7, 20, 30],
  ['2025-12', 1.8, 55.0, 1.3, 4.1, 23, 31], ['2026-01', 41.4, 65.5, 7.7, 5.7, 24, 31], ['2026-02', 49.0, 81.1, 8.1, 6.2, 28, 28],
  ['2026-03', 50.3, 83.0, 11.2, 4.5, 31, 31], ['2026-04', 53.2, 78.6, 10.3, 2.7, 30, 30], ['2026-05', 46.5, 51.1, 12.2, 3.0, 31, 31],
  ['2026-06', 51.7, 35.1, 6.5, 4.9, 30, 30], ['2026-07', 44.9, 30.0, 6.5, 2.0, 31, 31], ['2026-08', 53.5, 25.5, 6.5, 4.0, 31, 31],
  ['2026-09', 47.0, 29.0, 4.7, 4.2, 25, 30],
].map(([m, brand, informational, product, other, days, days_in_month]) => ({ m, brand, informational, product, other, days, days_in_month }));

const data = {
  generated: '2026-09-30', source: 'snapshot', site: 'ru',
  note: 'Срез на 2026-09-30: месячные значения из результатов запросов к прод-БД, норма пересчитана алгоритмом scripts/seo-traffic-norm.js.',
  partial: { '2026-09': 'данные за 29 из 30 дней' },   // неполные месяцы: отклонение по ним занижено на долю недостающих дней
  anomaly: { from: '2026-04', to: '2026-09', text: 'Апрель–сентябрь 2026 исключены из расчёта нормы как устойчивое падение органики' },
  series, skipped, engines, segments: SEG,
};
const file = path.join(__dirname, 'data.snapshot.json');
fs.writeFileSync(file, JSON.stringify(data, null, 1), 'utf8');
console.log(`OK ${path.relative(process.cwd(), file)}: рядов ${series.length}, пропущено ${skipped.length}`);
for (const s of series) console.log(`  ${s.key}: уровень ${s.level}/день, коридор ±${s.band}%`);
for (const s of skipped) console.log(`  пропущен: ${s.key} — ${s.reason}`);
