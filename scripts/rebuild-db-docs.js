const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { buildDocumentation, syncGenerated } = require('./generate-db-docs');

const ROOT = path.join(__dirname, '..');
const BASELINE_PATH = path.join(ROOT, 'docs', 'database', 'baseline.json');
const GENERATED_PATH = path.join(ROOT, 'docs', 'database', 'generated');

function quote(identifier) {
    return `"${String(identifier).replace(/"/g, '""')}"`;
}

function qualified(name) {
    return name.split('.').map(quote).join('.');
}

function assertType(type) {
    if (!/^[a-zA-Z0-9_ (),[\]]+$/.test(type)) throw new Error(`Неподдерживаемый тип в baseline: ${type}`);
}

function typedLiteral(type) {
    assertType(type);
    const normalized = type.toLowerCase();
    if (normalized.endsWith('[]')) return `CAST('{}' AS ${type})`;
    if (normalized === 'jsonb') return `CAST('{}' AS ${type})`;
    if (['smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision'].some(value => normalized.startsWith(value))) {
        return `CAST(0 AS ${type})`;
    }
    if (normalized === 'boolean') return 'CAST(TRUE AS boolean)';
    if (['date', 'timestamp with time zone', 'timestamp without time zone'].includes(normalized)) {
        return `CAST('2000-01-01' AS ${type})`;
    }
    return `CAST('redacted' AS ${type})`;
}

function actionSql(action) {
    return ({ a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' })[action] || 'NO ACTION';
}

function columnSql(column, sequenceName) {
    assertType(column.type);
    const parts = [quote(column.name), column.type];
    if (column.identity) {
        parts.push(`GENERATED ${column.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`);
    } else if (column.generated) {
        parts.push(`GENERATED ALWAYS AS (${typedLiteral(column.type)}) STORED`);
    } else if (column.default.kind === 'raw') {
        parts.push(`DEFAULT ${column.default.expression}`);
    } else if (column.default.kind === 'sequence') {
        parts.push(`DEFAULT nextval('${sequenceName}'::regclass)`);
    } else if (column.default.kind === 'hidden') {
        const literal = typedLiteral(column.type);
        parts.push(`DEFAULT NULLIF(${literal}, ${literal})`);
    }
    if (column.notNull) parts.push('NOT NULL');
    return parts.join(' ');
}

function viewOrder(views) {
    const byName = new Map(views.map(view => [view.name, view]));
    const state = new Map();
    const ordered = [];
    function visit(name) {
        if (state.get(name) === 'done') return;
        if (state.get(name) === 'active') throw new Error(`Циклическая зависимость представлений: ${name}`);
        state.set(name, 'active');
        const view = byName.get(name);
        for (const dependency of view.dependencies) {
            if (byName.has(dependency)) visit(dependency);
        }
        state.set(name, 'done');
        ordered.push(view);
    }
    for (const name of [...byName.keys()].sort()) visit(name);
    return ordered;
}

function tableStatements(table, sequences) {
    const statements = [];
    const byAttnum = new Map(table.columns.map(column => [column.attnum, column]));
    const maxAttnum = Math.max(...table.columns.map(column => column.attnum));
    const definitions = [];
    const dropped = [];
    for (let attnum = 1; attnum <= maxAttnum; attnum++) {
        const column = byAttnum.get(attnum);
        if (column) {
            definitions.push(columnSql(column, sequences.get(`${table.name}:${attnum}`)));
        } else {
            const name = `__db_docs_drop_${attnum}`;
            definitions.push(`${quote(name)} text`);
            dropped.push(name);
        }
    }
    for (const constraint of table.constraints) {
        if (constraint.type === 'p') definitions.push(`CONSTRAINT ${quote(constraint.name)} PRIMARY KEY (${constraint.columns.map(quote).join(', ')})`);
        if (constraint.type === 'u') definitions.push(`CONSTRAINT ${quote(constraint.name)} UNIQUE (${constraint.columns.map(quote).join(', ')})`);
        if (constraint.type === 'c') definitions.push(`CONSTRAINT ${quote(constraint.name)} CHECK (TRUE)`);
    }
    statements.push(`CREATE TABLE ${qualified(table.name)} (\n  ${definitions.join(',\n  ')}\n)`);
    for (const name of dropped) statements.push(`ALTER TABLE ONLY ${qualified(table.name)} DROP COLUMN ${quote(name)}`);

    const constraintIndexes = new Set(table.constraints.filter(constraint => ['p', 'u'].includes(constraint.type)).map(constraint => constraint.name));
    for (const index of table.indexes) {
        if (index.primary || constraintIndexes.has(index.name)) continue;
        if (!index.valid) throw new Error(`Невалидный индекс в baseline: ${index.name}`);
        if (!/^[a-z][a-z0-9_]*$/.test(index.type)) throw new Error(`Неподдерживаемый метод индекса: ${index.type}`);
        const expressionColumn = table.columns[0].name;
        let expressionNumber = 0;
        let keys = index.keyColumns.map(column => {
            if (column !== 'выражение скрыто') return quote(column);
            expressionNumber++;
            return `(lower(CAST(${quote(expressionColumn)} AS text)) || '${expressionNumber}')`;
        });
        if (index.hasExpressions && !index.keyColumns.includes('выражение скрыто')) {
            keys = [`(lower(CAST(${quote(expressionColumn)} AS text)) || '0')`, ...keys.slice(1)];
        }
        const include = index.includeColumns.length ? ` INCLUDE (${index.includeColumns.map(quote).join(', ')})` : '';
        const partial = index.partial ? ' WHERE (1 = 1)' : '';
        statements.push(`CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quote(index.name)} ON ${qualified(table.name)} USING ${index.type} (${keys.join(', ')})${include}${partial}`);
    }
    return statements;
}

function buildSqlStatements(baseline) {
    const statements = [];
    const schemas = new Set();
    for (const object of [...baseline.tables, ...baseline.views, ...baseline.excludedTables.map(name => ({ name }))]) schemas.add(object.name.split('.')[0]);
    for (const schema of [...schemas].sort()) statements.push(`CREATE SCHEMA IF NOT EXISTS ${quote(schema)}`);

    const sequences = new Map();
    let sequenceNumber = 0;
    for (const table of baseline.tables) {
        for (const column of table.columns) {
            if (column.default.kind !== 'sequence') continue;
            const sequence = `public.db_docs_seq_${++sequenceNumber}`;
            sequences.set(`${table.name}:${column.attnum}`, sequence);
            statements.push(`CREATE SEQUENCE ${qualified(sequence)}`);
        }
    }

    const foreignKeys = [];
    for (const table of baseline.tables) {
        statements.push(...tableStatements(table, sequences));
        for (const constraint of table.constraints) {
            if (constraint.type === 'f') foreignKeys.push({ table: table.name, constraint });
        }
    }
    for (const { table, constraint } of foreignKeys) {
        statements.push(`ALTER TABLE ONLY ${qualified(table)} ADD CONSTRAINT ${quote(constraint.name)} FOREIGN KEY (${constraint.columns.map(quote).join(', ')}) REFERENCES ${qualified(constraint.refObject)} (${constraint.refColumns.map(quote).join(', ')}) ON DELETE ${actionSql(constraint.deleteAction)} ON UPDATE ${actionSql(constraint.updateAction)}`);
    }
    for (const excluded of baseline.excludedTables) statements.push(`CREATE TABLE ${qualified(excluded)} (id integer)`);

    for (const view of viewOrder(baseline.views)) {
        const columns = view.columns.map(column => `CAST(NULL AS ${column.type}) AS ${quote(column.name)}`);
        const dependencies = view.dependencies.map((dependency, index) => `${qualified(dependency)} AS ${quote(`r${index}`)}`);
        let statement = `CREATE VIEW ${qualified(view.name)} AS SELECT ${columns.join(', ')}`;
        if (dependencies.length) statement += ` FROM ${dependencies.join(' CROSS JOIN ')}`;
        statement += ' WHERE FALSE';
        statements.push(statement);
    }
    return statements;
}

function connection(database) {
    return new Client({
        host: process.env.DB_DOCS_PGHOST || process.env.PGHOST,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database,
        port: process.env.PGPORT || 5432
    });
}

async function main() {
    require('dotenv').config();
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    if (baseline.kind !== 'sanitized-structure') throw new Error('Неподдерживаемый формат baseline');
    const statements = buildSqlStatements(baseline);
    const originalDatabase = process.env.PGDATABASE;
    const originalHost = process.env.PGHOST;
    const admin = connection(originalDatabase);
    const database = `db_docs_${process.pid}_${Date.now()}`;
    let temporary;
    let created = false;
    try {
        await admin.connect();
        await admin.query(`CREATE DATABASE ${quote(database)}`);
        created = true;
        temporary = connection(database);
        await temporary.connect();
        await temporary.query('BEGIN');
        try {
            for (const statement of statements) await temporary.query(statement);
            await temporary.query('COMMIT');
        } catch (error) {
            await temporary.query('ROLLBACK').catch(() => {});
            throw error;
        }
        await temporary.end();
        temporary = null;

        process.env.PGDATABASE = database;
        process.env.PGHOST = process.env.DB_DOCS_PGHOST || originalHost;
        const { files } = await buildDocumentation();
        const result = syncGenerated(files, GENERATED_PATH, true);
        if (result.differences.length) {
            throw new Error(`Документация после восстановления отличается:\n${result.differences.join('\n')}`);
        }
        console.log(JSON.stringify({
            result: 'ok',
            tables: baseline.tables.length,
            views: baseline.views.length,
            statements: statements.length,
            documentationDifferences: 0
        }));
    } finally {
        process.env.PGDATABASE = originalDatabase;
        process.env.PGHOST = originalHost;
        if (temporary) await temporary.end().catch(() => {});
        if (created) await admin.query(`DROP DATABASE IF EXISTS ${quote(database)}`).catch(error => {
            console.error(`Не удалось удалить временную БД: ${error.message}`);
        });
        await admin.end().catch(() => {});
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { buildSqlStatements, viewOrder, typedLiteral };
