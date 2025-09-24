require('dotenv').config();
const { Client } = require('pg');

const client = new Client({
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    port: process.env.PGPORT || 5432
});

async function test() {
    try {
        await client.connect();
        const result = await client.query('SELECT current_database(), current_user, version()');
        console.log('✅ Подключение к БД успешно:');
        console.log('Database:', result.rows[0].current_database);
        console.log('User:', result.rows[0].current_user);
        console.log('Version:', result.rows[0].version.split(' ')[0] + ' ' + result.rows[0].version.split(' ')[1]);
    } catch (error) {
        console.error('❌ Ошибка подключения к БД:', error.message);
    } finally {
        await client.end();
    }
}

test();