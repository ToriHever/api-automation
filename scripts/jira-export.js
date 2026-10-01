// scripts/jira-export.js
// Выгрузка задач Jira в CSV: ключ, заголовок, тип, статус, даты создания/решения/обновления, компоненты, метки.
// Нужна, чтобы по датам и заголовкам задач (описаний может не быть) найти релизы и правки сайта рядом с датой события
// (например, перенос страниц на Nuxt 3, правки общих компонентов, шапки, футера, меню).
//
// Окружение (.env или переменные оболочки):
//   JIRA_URL=https://jira.ddos-guard.net
//   JIRA_TOKEN=...                      # персональный токен (Bearer), либо:
//   JIRA_USER=... JIRA_PASSWORD=...     # basic-авторизация
//
// Запуск (CSV в stdout):
//   node scripts/jira-export.js --jql 'updated >= "2026-03-15" AND updated <= "2026-04-30" ORDER BY updated' > jira.csv
//   node scripts/jira-export.js --jql 'text ~ "nuxt" ORDER BY created' > jira-nuxt.csv

require('dotenv').config();
const axios = require('axios');

const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : def;
};
const csv = v => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;

async function main() {
    const base = (process.env.JIRA_URL || '').replace(/\/$/, '');
    const jql = arg('jql');
    if (!base || !jql) throw new Error('Нужны JIRA_URL и --jql');
    const headers = {};
    const auth = process.env.JIRA_TOKEN ? null : { username: process.env.JIRA_USER, password: process.env.JIRA_PASSWORD };
    if (process.env.JIRA_TOKEN) headers.Authorization = `Bearer ${process.env.JIRA_TOKEN}`;

    const fields = ['summary', 'issuetype', 'status', 'created', 'resolutiondate', 'updated', 'components', 'labels', 'fixVersions'];
    console.log(['key', 'summary', 'type', 'status', 'created', 'resolved', 'updated', 'components', 'labels', 'fixVersions'].join(','));
    let startAt = 0, total = Infinity;
    while (startAt < total) {
        const res = await axios.get(`${base}/rest/api/2/search`, {
            headers, auth: auth && auth.username ? auth : undefined, timeout: 60000,
            params: { jql, startAt, maxResults: 100, fields: fields.join(',') }
        });
        total = res.data.total;
        for (const it of res.data.issues) {
            const f = it.fields;
            console.log([it.key, f.summary, f.issuetype?.name, f.status?.name, f.created, f.resolutiondate, f.updated,
                (f.components || []).map(c => c.name).join('; '), (f.labels || []).join('; '),
                (f.fixVersions || []).map(v => v.name).join('; ')].map(csv).join(','));
        }
        if (!res.data.issues.length) break;
        startAt += res.data.issues.length;
    }
}

main().catch(e => { console.error(e.response ? `${e.response.status}: ${JSON.stringify(e.response.data).slice(0, 300)}` : e.message); process.exit(1); });
