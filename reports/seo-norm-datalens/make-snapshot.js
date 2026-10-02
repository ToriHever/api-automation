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

// ---- Спрос Wordstat (равновесный индекс фраз, scripts/seasonality-index.js --series demand) ----
// Год к году: reports.v_demand_index_yoy, срез из прод-БД 2026-10-01. Формат: [месяц, значение, значение год назад, год к году %]
const YOY = {
  'L7': [['2026-03', 61320, 90286, -32.1], ['2026-04', 63375, 93344, -32.1], ['2026-05', 51413, 89597, -42.6], ['2026-06', 56983, 89199, -36.1], ['2026-07', 46949, 67860, -30.8], ['2026-08', 39961, 58132, -31.3]],
  'DS': [['2026-03', 8541, 7919, 7.9], ['2026-04', 7599, 9879, -23.1], ['2026-05', 5827, 8140, -28.4], ['2026-06', 5537, 8054, -31.3], ['2026-07', 3618, 6405, -43.5], ['2026-08', 3501, 4733, -26.0]],
  'L3-4': [['2026-03', 295, 350, -15.7], ['2026-04', 300, 358, -16.2], ['2026-05', 224, 358, -37.4], ['2026-06', 321, 374, -14.2], ['2026-07', 169, 270, -37.4], ['2026-08', 138, 168, -17.9]],
  'VDS': [['2026-03', 245437, 252296, -2.7], ['2026-04', 242160, 223416, 8.4], ['2026-05', 175349, 201743, -13.1], ['2026-06', 169956, 202112, -15.9], ['2026-07', 120926, 205366, -41.1], ['2026-08', 127891, 187800, -31.9]],
  'Главная': [['2026-03', 10085, 14242, -29.2], ['2026-04', 10082, 16256, -38.0], ['2026-05', 8128, 14514, -44.0], ['2026-06', 8332, 14879, -44.0], ['2026-07', 7246, 11008, -34.2], ['2026-08', 6304, 9406, -33.0]],
  'Хостинг': [['2026-03', 699, 1389, -49.7], ['2026-04', 936, 8084, -88.4], ['2026-05', 728, 2774, -73.8], ['2026-06', 600, 1428, -58.0], ['2026-07', 784, 1266, -38.1], ['2026-08', 611, 1672, -63.5]],
  'Заказ атаки': [['2026-03', 3938, 4326, -9.0], ['2026-04', 4340, 4052, 7.1], ['2026-05', 3055, 3827, -20.2], ['2026-06', 3301, 3519, -6.2], ['2026-07', 2721, 3563, -23.6], ['2026-08', 2028, 2682, -24.4]],
  'Бренд': [['2026-03', 1750, 1538, 13.8], ['2026-04', 1499, 1916, -21.8], ['2026-05', 1168, 1523, -23.3], ['2026-06', 1694, 2080, -18.6], ['2026-07', 1588, 1695, -6.3], ['2026-08', 1537, 1569, -2.0]],
  'Контроль': [['2026-03', 369801402, 395591561, -6.5], ['2026-04', 378894646, 365249341, 3.7], ['2026-05', 379253362, 354779675, 6.9], ['2026-06', 394315339, 370821144, 6.3], ['2026-07', 432959103, 391424582, 10.6], ['2026-08', 414587660, 377103043, 9.9]],
};
const demand_yoy = Object.entries(YOY).flatMap(([p, rows]) => rows.map(([m, v, prev, yoy]) => ({ p, m, v, prev, yoy, ok: true })));

// Нормы спроса (только ряды, для которых норма строится): строки из вывода seo-traffic-norm.js --dry-run на 2026-10-01.
// [месяц, факт, норма, низ, верх, отклонение %, статус, уверенность]; ins = месяц входил в расчёт нормы (до 2026-03 включительно)
const NORM_ROWS = {
  'DS': { level: 254.1, band: 22, rows: [
    ['2025-07', 6405, 6041, 4687, 7395, 6, 'in_norm', 'low'], ['2025-08', 4733, 4464, 3463, 5464, 6, 'in_norm', 'low'], ['2025-09', 5798, 5303, 4114, 6491, 9, 'in_norm', 'normal'],
    ['2025-10', 10383, 8966, 6956, 10975, 16, 'in_norm', 'normal'], ['2025-11', 9076, 8967, 6957, 10977, 1, 'in_norm', 'normal'], ['2025-12', 7974, 8936, 6933, 10939, -11, 'in_norm', 'normal'],
    ['2026-01', 6443, 6544, 5077, 8010, -2, 'in_norm', 'normal'], ['2026-02', 5681, 7157, 5553, 8761, -21, 'in_norm', 'normal'], ['2026-03', 8541, 8015, 6218, 9811, 7, 'in_norm', 'normal'],
    ['2026-04', 7599, 9317, 7229, 11405, -18, 'in_norm', 'low'], ['2026-05', 5827, 7677, 5956, 9398, -24, 'below_norm', 'low'], ['2026-06', 5537, 7596, 5893, 9298, -27, 'below_norm', 'low'],
    ['2026-07', 3618, 6041, 4687, 7395, -40, 'below_norm', 'low'], ['2026-08', 3501, 4464, 3463, 5464, -22, 'in_norm', 'low']] },
  'L3-4': { level: 8.7, band: 14, rows: [
    ['2025-07', 270, 275, 236, 314, -2, 'in_norm', 'low'], ['2025-08', 168, 171, 147, 195, -2, 'in_norm', 'low'], ['2025-09', 222, 201, 173, 230, 10, 'in_norm', 'normal'],
    ['2025-10', 282, 267, 230, 305, 6, 'in_norm', 'normal'], ['2025-11', 310, 290, 250, 331, 7, 'in_norm', 'normal'], ['2025-12', 326, 312, 268, 356, 4, 'in_norm', 'normal'],
    ['2026-01', 183, 197, 169, 224, -7, 'in_norm', 'normal'], ['2026-02', 227, 254, 218, 289, -11, 'in_norm', 'normal'], ['2026-03', 295, 326, 280, 372, -10, 'in_norm', 'normal'],
    ['2026-04', 300, 365, 314, 416, -18, 'below_norm', 'low'], ['2026-05', 224, 365, 314, 416, -39, 'below_norm', 'low'], ['2026-06', 321, 381, 328, 435, -16, 'below_norm', 'low'],
    ['2026-07', 169, 275, 236, 314, -39, 'below_norm', 'low'], ['2026-08', 138, 171, 147, 195, -19, 'below_norm', 'low']] },
  'Бренд': { level: 53.3, band: 19, rows: [
    ['2025-07', 1695, 1598, 1292, 1904, 6, 'in_norm', 'low'], ['2025-08', 1569, 1479, 1196, 1763, 6, 'in_norm', 'low'], ['2025-09', 1727, 1502, 1214, 1789, 15, 'in_norm', 'normal'],
    ['2025-10', 1655, 1541, 1246, 1836, 7, 'in_norm', 'normal'], ['2025-11', 1490, 1660, 1342, 1977, -10, 'in_norm', 'normal'], ['2025-12', 1574, 1731, 1400, 2063, -9, 'in_norm', 'normal'],
    ['2026-01', 1348, 1407, 1138, 1677, -4, 'in_norm', 'normal'], ['2026-02', 1673, 1817, 1469, 2165, -8, 'in_norm', 'normal'], ['2026-03', 1750, 1605, 1297, 1912, 9, 'in_norm', 'normal'],
    ['2026-04', 1499, 1807, 1461, 2152, -17, 'in_norm', 'low'], ['2026-05', 1168, 1436, 1161, 1711, -19, 'in_norm', 'low'], ['2026-06', 1694, 1961, 1586, 2337, -14, 'in_norm', 'low'],
    ['2026-07', 1588, 1598, 1292, 1904, -1, 'in_norm', 'low'], ['2026-08', 1537, 1479, 1196, 1763, 4, 'in_norm', 'low']] },
};
const DEMAND_BASIS = 'равновесный индекс фраз (каждая фраза нормируется на своё среднее, одинаковый вес); норма построена на сентябре 2025 – марте 2026, апрель–сентябрь 2026 исключены как контрольный период';
const demandSeries = Object.entries(NORM_ROWS).map(([name, d], i) => ({
  key: 'demand_' + name, label: 'Спрос Wordstat — ' + name, sort: 10 + i, kind: 'demand', level: d.level, band: d.band, basis: DEMAND_BASIS,
  rows: d.rows.map(([m, actual, expected, low, high, dev, status, conf]) => ({
    m, actual, expected, low, high, dev, status, conf, forecast: false, ins: m <= '2026-03', si: null, seasons: conf === 'low' ? 1 : 2 })),
}));
const demandSkipped = [
  ['L7', 'уровень сезонов различается на 25% (порог 20%) — тренд, а не сезонность; коридор ±55% шире порога ±35%'],
  ['VDS', 'уровень сезонов различается на 30%; коридор ±68%'],
  ['Главная', 'уровень сезонов различается на 20%; коридор ±43%'],
  ['Хостинг', 'уровень сезонов различается на 30%; коридор ±68%'],
  ['Заказ атаки', 'уровень сезонов различается на 44%; коридор ±132%'],
].map(([name, reason]) => ({ key: 'demand_' + name, label: 'Спрос Wordstat — ' + name, reason }));

series.push(...demandSeries);
series.sort((a, b) => a.sort - b.sort);
skipped.push(...demandSkipped);
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

// ---- Покупки из organic (scripts/purchases-kpi.js, CSV аналитиков; CSV не хранятся в git — если файлов нет, блок пропускается) ----
let purchases = null;
{
  const purch = require('../../scripts/purchases-kpi.js');
  const dir = path.join(__dirname, '../../services/reports/data');
  const fp = path.join(dir, 'organic_monthly_products.csv'), fo = path.join(dir, 'organic_monthly_overall.csv');
  if (fs.existsSync(fp) && fs.existsSync(fo)) {
    const rows = purch.parseProducts(fs.readFileSync(fp, 'utf8'));
    const ov = purch.parseOverall(fs.readFileSync(fo, 'utf8'));
    purchases = purch.buildBlock(rows, ov);
  } else console.log('Покупки: CSV нет, блок пропущен');
}

const data = {
  generated: '2026-10-01', source: 'snapshot', site: 'ru',
  note: 'Срез на 2026-10-01: месячные значения трафика и спроса из результатов запросов к прод-БД, нормы трафика пересчитаны алгоритмом scripts/seo-traffic-norm.js, нормы спроса и сравнение год к году взяты из вывода скриптов на сервере.',
  partial: { '2026-09': 'данные за 29 из 30 дней' },   // неполные месяцы: отклонение по ним занижено на долю недостающих дней
  anomaly: { from: '2026-04', to: '2026-09', text: 'Апрель–сентябрь 2026 исключены из расчёта нормы как устойчивое падение органики' },
  series, skipped, engines, segments: SEG, demand_yoy, purchases,
};
const file = path.join(__dirname, 'data.snapshot.json');
fs.writeFileSync(file, JSON.stringify(data, null, 1), 'utf8');
console.log(`OK ${path.relative(process.cwd(), file)}: рядов ${series.length}, пропущено ${skipped.length}`);
for (const s of series) console.log(`  ${s.key}: уровень ${s.level}/день, коридор ±${s.band}%`);
for (const s of skipped) console.log(`  пропущен: ${s.key} — ${s.reason}`);
