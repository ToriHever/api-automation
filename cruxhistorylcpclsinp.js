// scripts/crux-history-lcp-cls-inp.js
// Разовый скрипт для тикета: тянет из Chrome UX Report (CrUX) History API
// динамику LCP/CLS/INP по датам для конкретных URL.
//
// Важно: это НЕ Google Search Console API — отчёт "Основные интернет-показатели"
// в GSC сам построен на данных CrUX, но отдаёт только текущий агрегат и группы
// URL по статусу, без истории по датам. Историю по датам даёт отдельный
// CrUX History API (28-дневные скользящие периоды, обновляется раз в сутки,
// глубина — до 40 последних периодов, т.е. ~40 дней).
//
// Нужен Google API key с включённым "Chrome UX Report API" в Google Cloud Console
// (обычный API key, НЕ OAuth/service account — в отличие от GA4/GSC в проекте).
//
// Настройка: добавь в .env
//   CRUX_API_KEY=your_google_api_key
//
// Запуск:
//   node scripts/crux-history-lcp-cls-inp.js https://example.com/page1 https://example.com/page2
//
// Результат выводится в консоль и сохраняется в
//   scripts/output/crux-history_<timestamp>.csv

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const API_URL = 'https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord';
const API_KEY = process.env.CRUX_API_KEY;

const METRICS = ['largest_contentful_paint', 'cumulative_layout_shift', 'interaction_to_next_paint'];
const METRIC_LABELS = {
    largest_contentful_paint: 'LCP',
    cumulative_layout_shift: 'CLS',
    interaction_to_next_paint: 'INP'
};

function formatCollectionDate(period) {
    // CrUX History отдаёт firstDate/lastDate периода (28-дневное окно) —
    // для "по датам" берём lastDate (конец окна = дата, к которой относится значение)
    const { year, month, day } = period.lastDate;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

async function fetchHistory(url) {
    const response = await axios.post(`${API_URL}?key=${API_KEY}`, {
        url,
        metrics: METRICS
    });
    return response.data;
}

function parseRecord(data) {
    const collectionPeriods = data.record.collectionPeriods;
    const rows = collectionPeriods.map((period, i) => ({
        date: formatCollectionDate(period)
    }));

    for (const metric of METRICS) {
        const series = data.record.metrics[metric];
        if (!series) continue;
        // p75s — массив p75-значений, по одному на collection period, тот же индекс
        series.percentilesTimeseries.p75s.forEach((value, i) => {
            rows[i][METRIC_LABELS[metric]] = value;
        });
    }
    return rows;
}

async function main() {
    if (!API_KEY) {
        console.error('CRUX_API_KEY не задан в .env');
        process.exit(1);
    }

    const urls = process.argv.slice(2);
    if (urls.length === 0) {
        console.error('Использование: node scripts/crux-history-lcp-cls-inp.js <url1> [url2] ...');
        process.exit(1);
    }

    const csvLines = ['url,date,LCP_ms,CLS,INP_ms'];

    for (const url of urls) {
        console.log(`\n=== ${url} ===`);
        try {
            const data = await fetchHistory(url);
            const rows = parseRecord(data);

            console.log('date       | LCP (ms) | CLS   | INP (ms)');
            for (const row of rows) {
                console.log(
                    `${row.date} | ${String(row.LCP ?? '-').padStart(8)} | ${String(row.CLS ?? '-').padStart(5)} | ${String(row.INP ?? '-').padStart(8)}`
                );
                csvLines.push(`${url},${row.date},${row.LCP ?? ''},${row.CLS ?? ''},${row.INP ?? ''}`);
            }
        } catch (err) {
            if (err.response?.status === 404) {
                console.log('Недостаточно данных CrUX для этого URL (страница вне выборки).');
            } else {
                console.error('Ошибка запроса:', err.response?.data || err.message);
                if (err.response?.data) {
                    console.error(JSON.stringify(err.response.data, null, 2));
                }
            }
        }
    }

    const outDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `crux-history_${Date.now()}.csv`);
    fs.writeFileSync(outFile, csvLines.join('\n'), 'utf-8');
    console.log(`\nСохранено: ${outFile}`);
}

main();
