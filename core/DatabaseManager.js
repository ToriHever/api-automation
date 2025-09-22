// core/DatabaseManager.js
const { Client } = require('pg');

class DatabaseManager {
    constructor(serviceName = 'default') {
        this.serviceName = serviceName;
        this.client = null;
    }

    async connect() {
        this.client = new Client({
            host: process.env.PGHOST,
            user: process.env.PGUSER,
            password: process.env.PGPASSWORD,
            database: process.env.PGDATABASE,
            port: process.env.PGPORT || 5432
        });

        await this.client.connect();
    }

    async disconnect() {
        if (this.client) {
            await this.client.end();
            this.client = null;
        }
    }

    async query(text, params = []) {
        if (!this.client) {
            throw new Error('Database not connected');
        }
        return await this.client.query(text, params);
    }
}

module.exports = DatabaseManager;