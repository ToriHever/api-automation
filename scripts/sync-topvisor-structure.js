// scripts/sync-topvisor-structure.js
// Разовая/периодическая синхронизация справочника TopVisor: проекты -> группы -> ключевые фразы (target URL).
// Не связан с ежедневным сбором позиций (services/topvisor/TopVisorCollector.js) — отдельный процесс, своя БД-схема.
//
// Запуск: node scripts/sync-topvisor-structure.js

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const DatabaseManager = require('../core/DatabaseManager');

const API_BASE = 'https://api.topvisor.com/v2/json';

function authHeaders() {
    return {
        'Content-Type': 'application/json',
        'User-Id': process.env.TOPVISOR_USER_ID,
        'Authorization': `bearer ${process.env.TOPVISOR_API_KEY}`
    };
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiPost(endpoint, body, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await axios.post(`${API_BASE}${endpoint}`, body, {
                headers: authHeaders(),
                timeout: 30000
            });
            return response.data.result || [];
        } catch (error) {
            if (error.response?.status === 429 && attempt < retries) {
                await delay(attempt * 10000);
                continue;
            }
            throw error;
        }
    }
}

async function getProjects() {
    return apiPost('/get/projects_2/projects', { fields: ['id', 'name', 'url'] });
}

async function getGroups(projectId) {
    return apiPost('/get/keywords_2/groups', {
        project_id: projectId,
        fields: ['id', 'project_id', 'folder_id', 'name', 'on', 'count_keywords']
    });
}

async function getKeywords(projectId) {
    return apiPost('/get/keywords_2/keywords', {
        project_id: projectId,
        fields: ['id', 'project_id', 'group_id', 'name', 'target']
    });
}

async function upsertProjects(db, projects) {
    for (const p of projects) {
        await db.query(
            `INSERT INTO topvisor.dim_projects (id, name, url)
             VALUES ($1, $2, $3)
             ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url, updated_at = CURRENT_TIMESTAMP`,
            [parseInt(p.id, 10), p.name, p.url]
        );
    }
}

async function upsertGroups(db, groups) {
    for (const g of groups) {
        await db.query(
            `INSERT INTO topvisor.dim_groups (id, project_id, folder_id, name, is_on, count_keywords)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (id) DO UPDATE SET
                project_id = EXCLUDED.project_id, folder_id = EXCLUDED.folder_id,
                name = EXCLUDED.name, is_on = EXCLUDED.is_on,
                count_keywords = EXCLUDED.count_keywords, updated_at = CURRENT_TIMESTAMP`,
            [
                parseInt(g.id, 10),
                parseInt(g.project_id, 10),
                g.folder_id ? parseInt(g.folder_id, 10) : null,
                g.name,
                !!Number(g.on),
                g.count_keywords !== undefined ? parseInt(g.count_keywords, 10) : null
            ]
        );
    }
}

async function upsertKeywords(db, keywords) {
    for (const k of keywords) {
        await db.query(
            `INSERT INTO topvisor.dim_keywords (id, project_id, group_id, name, target)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id) DO UPDATE SET
                project_id = EXCLUDED.project_id, group_id = EXCLUDED.group_id,
                name = EXCLUDED.name, target = EXCLUDED.target, updated_at = CURRENT_TIMESTAMP`,
            [
                parseInt(k.id, 10),
                parseInt(k.project_id, 10),
                k.group_id ? parseInt(k.group_id, 10) : null,
                k.name,
                k.target || null
            ]
        );
    }
}

async function main() {
    if (!process.env.TOPVISOR_API_KEY || !process.env.TOPVISOR_USER_ID) {
        throw new Error('TOPVISOR_API_KEY и TOPVISOR_USER_ID обязательны');
    }

    const db = new DatabaseManager('topvisor-structure');
    await db.connect();

    try {
        const schemaPath = path.join(__dirname, '..', 'services', 'topvisor', 'structure_schema.sql');
        await db.query(fs.readFileSync(schemaPath, 'utf8'));

        console.log('Получаю список проектов...');
        const projects = await getProjects();
        console.log(`Проектов: ${projects.length}`);
        await upsertProjects(db, projects);

        for (const project of projects) {
            const projectId = parseInt(project.id, 10);
            console.log(`\n=== Проект "${project.name}" (${projectId}) ===`);

            await delay(500);
            const groups = await getGroups(projectId);
            console.log(`  Групп: ${groups.length}`);
            await upsertGroups(db, groups);

            await delay(500);
            const keywords = await getKeywords(projectId);
            console.log(`  Ключевых фраз: ${keywords.length}`);
            await upsertKeywords(db, keywords);
        }

        console.log('\nГотово.');
    } finally {
        await db.disconnect();
    }
}

main().catch(error => {
    console.error('Ошибка синхронизации структуры TopVisor:', error.message);
    process.exit(1);
});
