const fs = require('fs');
const path = require('path');
const {
    introspect,
    validateConfig,
    sanitizeDefault,
    assertSafeGeneratedContent
} = require('./generate-db-docs');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'docs', 'database', 'config.json');
const BASELINE_PATH = path.join(ROOT, 'docs', 'database', 'baseline.json');

function baselineDefault(expression) {
    if (!expression) return { kind: 'none' };
    if (/^nextval\(/i.test(String(expression).trim())) return { kind: 'sequence' };
    if (sanitizeDefault(expression).startsWith('Есть;')) return { kind: 'hidden' };
    return { kind: 'raw', expression: String(expression).trim() };
}

function serializeColumns(rows) {
    return rows.map(row => ({
        attnum: Number(row.attnum),
        name: row.column_name,
        type: row.data_type,
        notNull: Boolean(row.not_null),
        identity: row.identity || '',
        generated: row.generated || '',
        default: baselineDefault(row.default_expression)
    }));
}

function buildBaseline(config, metadata) {
    const allowedObjects = new Set([...config.scope.tables, ...config.scope.views]);
    const tables = config.scope.tables.map(name => {
        const constraints = (metadata.constraints.get(name) || []).map(constraint => ({ ...constraint }));
        for (const constraint of constraints) {
            if (constraint.type === 'f') {
                if (!config.scope.tables.includes(constraint.refObject)) {
                    throw new Error(`Внешний ключ ${constraint.name} ссылается на недокументируемый объект`);
                }
            }
        }
        return {
            name,
            columns: serializeColumns(metadata.columns.byObject.get(name) || []),
            constraints,
            indexes: (metadata.indexes.get(name) || []).map(index => ({ ...index }))
        };
    });
    const views = config.scope.views.map(name => ({
        name,
        columns: serializeColumns(metadata.columns.byObject.get(name) || []).map(column => ({
            attnum: column.attnum,
            name: column.name,
            type: column.type
        })),
        dependencies: [...new Set(metadata.dependencies.get(name) || [])]
            .filter(dependency => allowedObjects.has(dependency))
            .sort()
    }));
    return {
        version: 1,
        kind: 'sanitized-structure',
        tables,
        views,
        excludedTables: [...config.scope.excludedTables].sort()
    };
}

function syncBaseline(content, check) {
    const exists = fs.existsSync(BASELINE_PATH);
    if (check) {
        if (!exists || fs.readFileSync(BASELINE_PATH, 'utf8') !== content) {
            const error = new Error('baseline.json отсутствует или не соответствует структуре БД');
            error.exitCode = 1;
            throw error;
        }
        return false;
    }
    if (exists && fs.readFileSync(BASELINE_PATH, 'utf8') === content) return false;
    fs.writeFileSync(BASELINE_PATH, content);
    return true;
}

async function buildFromDatabase() {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    validateConfig(config);
    const metadata = await introspect(config);
    const baseline = buildBaseline(config, metadata);
    const content = `${JSON.stringify(baseline, null, 2)}\n`;
    assertSafeGeneratedContent(
        { 'baseline.json': content },
        { ...config, scope: { ...config.scope, excludedTables: [] } }
    );
    return { baseline, content };
}

async function main() {
    const args = process.argv.slice(2);
    const unknown = args.filter(arg => arg !== '--check');
    if (unknown.length) throw new Error(`Неизвестные аргументы: ${unknown.join(', ')}`);
    const check = args.includes('--check');
    const { baseline, content } = await buildFromDatabase();
    const changed = syncBaseline(content, check);
    console.log(check
        ? `baseline.json актуален: ${baseline.tables.length} таблиц, ${baseline.views.length} представлений.`
        : `baseline.json ${changed ? 'обновлён' : 'не изменился'}: ${baseline.tables.length} таблиц, ${baseline.views.length} представлений.`);
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = error.exitCode || 1;
    });
}

module.exports = { baselineDefault, buildBaseline, buildFromDatabase, syncBaseline };
