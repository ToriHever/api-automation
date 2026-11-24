const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'docs', 'database', 'config.json');
const GENERATED_MARKER = '<!-- docs-db:generated -->';

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolveFromRoot(value) {
    const resolved = path.resolve(ROOT, value);
    assert(resolved === ROOT || resolved.startsWith(ROOT + path.sep), `Путь выходит за пределы проекта: ${value}`);
    return resolved;
}

function objectName(row) {
    return `${row.schema}.${row.object_name || row.name}`;
}

function unique(values) {
    return [...new Set(values)];
}

function difference(left, right) {
    const rightSet = new Set(right);
    return left.filter(value => !rightSet.has(value));
}

function matchesGlob(value, pattern) {
    let valueIndex = 0;
    let patternIndex = 0;
    let starIndex = -1;
    let retryIndex = 0;
    while (valueIndex < value.length) {
        if (patternIndex < pattern.length && (pattern[patternIndex] === '?' || pattern[patternIndex] === value[valueIndex])) {
            valueIndex++;
            patternIndex++;
        } else if (patternIndex < pattern.length && pattern[patternIndex] === '*') {
            starIndex = patternIndex++;
            retryIndex = valueIndex;
        } else if (starIndex !== -1) {
            patternIndex = starIndex + 1;
            valueIndex = ++retryIndex;
        } else {
            return false;
        }
    }
    while (patternIndex < pattern.length && pattern[patternIndex] === '*') patternIndex++;
    return patternIndex === pattern.length;
}

function escapeMarkdown(value) {
    const text = String(value === null || value === undefined || value === '' ? '—' : value);
    return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function inlineCode(value) {
    return `\`${String(value).replace(/`/g, "'")}\``;
}

function toNumberArray(value) {
    if (Array.isArray(value)) return value.map(Number);
    return String(value || '').replace(/[{}]/g, '').split(',').filter(Boolean).map(Number);
}

function validateConfig(config) {
    assert(config.newObjects === 'deny', 'Для генерации требуется newObjects: deny');
    assert(config.source && config.source.readOnly === true, 'Источник должен быть read-only');
    assert(config.source.includeDatabaseComments === false, 'Автоматическая публикация COMMENT ON запрещена');
    assert(Array.isArray(config.scope && config.scope.tables), 'Не задан список таблиц');
    assert(Array.isArray(config.scope && config.scope.views), 'Не задан список представлений');
    assert(Array.isArray(config.scope && config.scope.excludedTables), 'Не задан список исключений');
    assert(unique(config.scope.tables).length === config.scope.tables.length, 'Дубли в списке таблиц');
    assert(unique(config.scope.views).length === config.scope.views.length, 'Дубли в списке представлений');
    assert(config.views && config.views.includeDefinitions === false, 'SQL представлений должен быть запрещён');
    assert(config.functions && config.functions.mode === 'exclude-all', 'Функции должны быть исключены');
    assert(config.materializedViews && config.materializedViews.mode === 'exclude-all', 'Материализованные представления должны быть исключены');
    assert(config.output && Array.isArray(config.output.domains), 'Не заданы доменные разделы');
    const files = config.output.domains.map(domain => domain.file);
    assert(unique(files).length === files.length, 'Дубли файлов в доменных разделах');
    assert(config.views.includeDatabaseComments === false, 'COMMENT ON представлений не должен публиковаться');
    assert(config.functions.includeSignatures === false && config.functions.includeSource === false, 'Сигнатуры и исходный код функций запрещены');
    assert(config.tableMetadata && config.tableMetadata.includeDefaults === 'reviewed-only', 'Значения по умолчанию публикуются только после проверки');
    assert(config.expressions && config.expressions.defaults === 'review-required', 'Непроверенные defaults должны скрываться');
    assert(config.expressions.checks === 'presence-only', 'CHECK должен публиковаться только как факт наличия');
    assert(config.expressions.partialIndexes === 'presence-only', 'WHERE частичных индексов должен скрываться');
    assert(config.expressions.indexExpressions === 'presence-only', 'Индексные выражения должны скрываться');
    const forbiddenSafetyFlags = [
        'includeOwners', 'includePrivileges', 'includeViewDefinitions', 'includeRowCounts',
        'includeSampleData', 'includeConnectionParameters', 'includeServerVersion',
        'includeFullDump', 'includeStatistics', 'includeTableSizes', 'includePolicies',
        'includeFunctionDefinitions'
    ];
    for (const flag of forbiddenSafetyFlags) {
        assert(config.safety && config.safety[flag] === false, `Небезопасный параметр safety.${flag}`);
    }
    const restrictedPolicies = [
        ...Object.values(config.restrictedObjects || {}),
        ...Object.values(config.restrictedPatterns || {})
    ];
    for (const policy of restrictedPolicies) {
        assert(policy.allowExamples === false && policy.allowValues === false, 'Чувствительные объекты не должны разрешать примеры и значения');
    }
}

function validateInventory(inventory, config) {
    const allowedTables = config.scope.tables;
    const allowedViews = config.scope.views;
    const excludedTables = config.scope.excludedTables;
    const actualTables = inventory.filter(row => ['r', 'p'].includes(row.kind)).map(objectName).sort();
    const actualViews = inventory.filter(row => row.kind === 'v').map(objectName).sort();
    const materialized = inventory.filter(row => row.kind === 'm').map(objectName).sort();
    const unapprovedTables = difference(actualTables, [...allowedTables, ...excludedTables]);
    const unapprovedViews = difference(actualViews, allowedViews);
    const missingTables = difference(allowedTables, actualTables);
    const missingViews = difference(allowedViews, actualViews);
    const missingExclusions = difference(excludedTables, actualTables);
    const allowedExcluded = allowedTables.filter(name => excludedTables.includes(name));

    assert(materialized.length === 0, `Обнаружены непроверенные материализованные представления: ${materialized.join(', ')}`);
    assert(unapprovedTables.length === 0, `Новые таблицы требуют проверки: ${unapprovedTables.join(', ')}`);
    assert(unapprovedViews.length === 0, `Новые представления требуют проверки: ${unapprovedViews.join(', ')}`);
    assert(missingTables.length === 0, `Разрешённые таблицы отсутствуют в БД: ${missingTables.join(', ')}`);
    assert(missingViews.length === 0, `Разрешённые представления отсутствуют в БД: ${missingViews.join(', ')}`);
    assert(missingExclusions.length === 0, `Исключённые таблицы отсутствуют в БД: ${missingExclusions.join(', ')}`);
    assert(allowedExcluded.length === 0, `Исключённые таблицы попали в allowlist: ${allowedExcluded.join(', ')}`);
}

async function fetchColumns(db, objects) {
    const result = await db.query(`
        SELECT
            n.nspname AS schema,
            c.relname AS object_name,
            c.relkind AS kind,
            a.attnum,
            a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS data_type,
            a.attnotnull AS not_null,
            a.attidentity AS identity,
            a.attgenerated AS generated,
            pg_get_expr(ad.adbin, ad.adrelid) AS default_expression
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
        LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
        WHERE n.nspname || '.' || c.relname = ANY($1)
          AND a.attnum > 0
          AND NOT a.attisdropped
        ORDER BY n.nspname, c.relname, a.attnum
    `, [objects]);

    const byObject = new Map(objects.map(name => [name, []]));
    const byAttnum = new Map();
    for (const row of result.rows) {
        const name = objectName(row);
        byObject.get(name).push(row);
        byAttnum.set(`${name}:${row.attnum}`, row.column_name);
    }
    return { byObject, byAttnum };
}

async function fetchConstraints(db, tables, columns) {
    const result = await db.query(`
        SELECT
            n.nspname AS schema,
            c.relname AS object_name,
            con.conname AS constraint_name,
            con.contype AS constraint_type,
            con.conkey,
            con.confkey,
            con.confdeltype AS delete_action,
            con.confupdtype AS update_action,
            rn.nspname AS ref_schema,
            rc.relname AS ref_object_name
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid
        LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
        WHERE n.nspname || '.' || c.relname = ANY($1)
        ORDER BY n.nspname, c.relname, con.conname
    `, [tables]);

    const byObject = new Map(tables.map(name => [name, []]));
    const columnName = (object, attnum) => columns.byAttnum.get(`${object}:${attnum}`) || `колонка ${attnum}`;
    for (const row of result.rows) {
        const name = objectName(row);
        const refObject = row.ref_schema ? `${row.ref_schema}.${row.ref_object_name}` : null;
        byObject.get(name).push({
            name: row.constraint_name,
            type: row.constraint_type,
            object: name,
            columns: toNumberArray(row.conkey).map(attnum => columnName(name, attnum)),
            refObject,
            refColumns: toNumberArray(row.confkey).map(attnum => columnName(refObject, attnum)),
            deleteAction: row.delete_action,
            updateAction: row.update_action
        });
    }
    return byObject;
}

async function fetchIndexes(db, tables, columns) {
    const result = await db.query(`
        SELECT
            n.nspname AS schema,
            c.relname AS object_name,
            x.relname AS index_name,
            am.amname AS index_type,
            i.indisunique AS is_unique,
            i.indisprimary AS is_primary,
            i.indisvalid AS is_valid,
            i.indpred IS NOT NULL AS is_partial,
            i.indexprs IS NOT NULL AS has_expressions,
            i.indnkeyatts AS key_column_count,
            i.indkey::text AS index_keys
        FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_class x ON x.oid = i.indexrelid
        JOIN pg_catalog.pg_am am ON am.oid = x.relam
        WHERE n.nspname || '.' || c.relname = ANY($1)
        ORDER BY n.nspname, c.relname, x.relname
    `, [tables]);

    const byObject = new Map(tables.map(name => [name, []]));
    for (const row of result.rows) {
        const name = objectName(row);
        const keys = String(row.index_keys || '').trim().split(/\s+/).filter(Boolean).map(Number);
        const names = keys.map(attnum => attnum === 0 ? 'выражение скрыто' : columns.byAttnum.get(`${name}:${attnum}`) || `колонка ${attnum}`);
        const keyCount = Number(row.key_column_count);
        byObject.get(name).push({
            name: row.index_name,
            type: row.index_type,
            unique: row.is_unique,
            primary: row.is_primary,
            valid: row.is_valid,
            partial: row.is_partial,
            hasExpressions: row.has_expressions,
            keyColumns: names.slice(0, keyCount),
            includeColumns: names.slice(keyCount)
        });
    }
    return byObject;
}

async function fetchViewDependencies(db, views) {
    const result = await db.query(`
        SELECT DISTINCT
            vn.nspname AS schema,
            vc.relname AS object_name,
            dn.nspname AS dependency_schema,
            dc.relname AS dependency_name
        FROM pg_catalog.pg_depend d
        JOIN pg_catalog.pg_rewrite r ON r.oid = d.objid
        JOIN pg_catalog.pg_class vc ON vc.oid = r.ev_class
        JOIN pg_catalog.pg_namespace vn ON vn.oid = vc.relnamespace
        JOIN pg_catalog.pg_class dc ON dc.oid = d.refobjid
        JOIN pg_catalog.pg_namespace dn ON dn.oid = dc.relnamespace
        WHERE d.refclassid = 'pg_catalog.pg_class'::regclass
          AND vc.relkind = 'v'
          AND dc.relkind IN ('r', 'p', 'v')
          AND vc.oid <> dc.oid
          AND vn.nspname || '.' || vc.relname = ANY($1)
        ORDER BY vn.nspname, vc.relname, dn.nspname, dc.relname
    `, [views]);

    const byObject = new Map(views.map(name => [name, []]));
    for (const row of result.rows) {
        byObject.get(objectName(row)).push(`${row.dependency_schema}.${row.dependency_name}`);
    }
    return byObject;
}

async function fetchSensitiveExpressions(db, tables) {
    const result = await db.query(`
        SELECT n.nspname AS schema, c.relname AS object_name, con.conname AS detail,
               pg_get_constraintdef(con.oid) AS expression, 'CHECK' AS kind
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE con.contype = 'c'
          AND n.nspname || '.' || c.relname = ANY($1)
        UNION ALL
        SELECT n.nspname, c.relname, x.relname,
               pg_get_expr(i.indpred, i.indrelid), 'PARTIAL_INDEX'
        FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_class x ON x.oid = i.indexrelid
        WHERE i.indpred IS NOT NULL
          AND n.nspname || '.' || c.relname = ANY($1)
        UNION ALL
        SELECT n.nspname, c.relname, x.relname,
               pg_get_expr(i.indexprs, i.indrelid), 'INDEX_EXPRESSION'
        FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_class x ON x.oid = i.indexrelid
        WHERE i.indexprs IS NOT NULL
          AND n.nspname || '.' || c.relname = ANY($1)
    `, [tables]);
    return result.rows.map(row => ({
        kind: row.kind,
        object: objectName(row),
        detail: row.detail,
        expression: row.expression
    }));
}

async function introspect(config) {
    require('dotenv').config();
    const { Client } = require('pg');
    const db = new Client({
        host: process.env.PGHOST,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE,
        port: process.env.PGPORT || 5432
    });
    await db.connect();
    let inTransaction = false;
    try {
        await db.query('BEGIN TRANSACTION READ ONLY');
        inTransaction = true;
        const inventory = (await db.query(`
            SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p', 'v', 'm')
              AND n.nspname NOT IN ('pg_catalog', 'information_schema')
              AND n.nspname NOT LIKE 'pg_toast%'
            ORDER BY n.nspname, c.relname
        `)).rows;
        validateInventory(inventory, config);
        const objects = [...config.scope.tables, ...config.scope.views];
        const columns = await fetchColumns(db, objects);
        const constraints = await fetchConstraints(db, config.scope.tables, columns);
        const indexes = await fetchIndexes(db, config.scope.tables, columns);
        const dependencies = await fetchViewDependencies(db, config.scope.views);
        const sensitiveExpressions = await fetchSensitiveExpressions(db, config.scope.tables);
        for (const [object, rows] of columns.byObject) {
            for (const row of rows) {
                if (row.default_expression) {
                    sensitiveExpressions.push({
                        kind: 'DEFAULT',
                        object,
                        detail: row.column_name,
                        expression: row.default_expression
                    });
                }
            }
        }
        await db.query('ROLLBACK');
        inTransaction = false;
        return { columns, constraints, indexes, dependencies, sensitiveExpressions };
    } catch (error) {
        if (inTransaction) await db.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        await db.end();
    }
}

function splitColumnReference(reference) {
    const parts = reference.split('.');
    assert(parts.length >= 3, `Некорректная ссылка на колонку: ${reference}`);
    return {
        object: `${parts[0]}.${parts[1]}`,
        column: parts.slice(2).join('.')
    };
}

function validateDescriptions(config, descriptions, metadata) {
    const tables = descriptions.tables || {};
    const views = descriptions.views || {};
    const columns = descriptions.columns || {};
    const allowedObjects = [...config.scope.tables, ...config.scope.views];
    const actualColumns = new Set();
    for (const [object, rows] of metadata.columns.byObject) {
        for (const row of rows) actualColumns.add(`${object}.${row.column_name}`);
    }

    for (const name of Object.keys(tables)) assert(config.scope.tables.includes(name), `Описание удалённой или запрещённой таблицы: ${name}`);
    for (const name of Object.keys(views)) assert(config.scope.views.includes(name), `Описание удалённого или запрещённого представления: ${name}`);
    for (const reference of Object.keys(columns)) assert(actualColumns.has(reference), `Описание удалённой или запрещённой колонки: ${reference}`);
    for (const [name, policy] of Object.entries(config.restrictedObjects || {})) {
        assert(allowedObjects.includes(name), `Чувствительный объект не входит в allowlist: ${name}`);
        for (const column of policy.valueRestrictedColumns || []) {
            assert(actualColumns.has(`${name}.${column}`), `Неизвестная чувствительная колонка: ${name}.${column}`);
        }
    }

    return {
        missingTables: config.scope.tables.filter(name => !tables[name]),
        missingViews: config.scope.views.filter(name => !views[name])
    };
}

function sanitizeDefault(expression) {
    if (!expression) return '—';
    const value = String(expression).trim();
    if (/^-?\d+(?:\.\d+)?(?:::[a-zA-Z0-9_ ]+)?$/.test(value)) return inlineCode(value);
    if (/^(?:true|false)(?:::[a-zA-Z0-9_ ]+)?$/i.test(value)) return inlineCode(value);
    if (/^null(?:::[a-zA-Z0-9_ ]+)?$/i.test(value)) return '`NULL`';
    if (/^now\(\)(?:::[a-zA-Z0-9_ ]+)?$/i.test(value)) return '`now()`';
    if (/^nextval\(/i.test(value)) return '`nextval(…)`';
    if (/^current_(?:timestamp|date|time)(?:\(\d+\))?(?:::[a-zA-Z0-9_ ]+)?$/i.test(value)) return inlineCode(value);
    if (/^''::(?:text|character varying)$/i.test(value)) return "`''`";
    if (/^'\{\}'::jsonb$/i.test(value)) return "`'{}'::jsonb`";
    if (/^'\[\]'::jsonb$/i.test(value)) return "`'[]'::jsonb`";
    return 'Есть; выражение скрыто до проверки';
}

const FORBIDDEN_CONTENT_PATTERNS = [
    { label: 'строка подключения', pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\//i },
    { label: 'URL', pattern: /\bhttps?:\/\//i },
    { label: 'IP-адрес', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
    { label: 'параметр или секрет', pattern: /\b(?:PGPASSWORD|PGHOST|PGUSER|PGPORT|PGDATABASE|DATABASE_URL|DB_PASSWORD|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|API[_-]?KEY|ACCESS[_-]?KEY|SECRET[_-]?KEY|PASSWORD|TOKEN|SECRET)\s*(?:=|:)\s*[^\s|]+/i },
    { label: 'Bearer-токен', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i },
    { label: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
    { label: 'токен Telegram', pattern: /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/ },
    { label: 'ключ SSH', pattern: /BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY|\bssh-(?:rsa|ed25519)\s+[A-Za-z0-9+/=]{20,}/i },
    { label: 'DDL или определение объекта', pattern: /\b(?:pg_get_viewdef|CREATE\s+(?:OR\s+REPLACE\s+)?VIEW|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+SCHEMA|COMMENT\s+ON)\b/i },
    { label: 'функция или процедура', pattern: /\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)|DO\s+\$\$)\b/i },
    { label: 'роли или права доступа', pattern: /\b(?:GRANT|REVOKE|OWNER\s+TO|CREATE\s+(?:ROLE|USER)|CREATE\s+POLICY|ENABLE\s+ROW\s+LEVEL\s+SECURITY)\b/i },
    { label: 'дамп данных', pattern: /PostgreSQL database dump|Dumped from database version|Dumped by pg_dump|\bINSERT\s+INTO\b|\bCOPY\s+[^;]+\s+FROM\s+stdin\b/i },
    { label: 'чтение database comments', pattern: /\b(?:obj_description|col_description|shobj_description)\s*\(/i }
];

function assertSafeGeneratedContent(files, config) {
    for (const [name, content] of Object.entries(files)) {
        for (const { label, pattern } of FORBIDDEN_CONTENT_PATTERNS) {
            assert(!pattern.test(content), `Проверка безопасности: ${label} в ${name}`);
        }
        assert(!/^(?:<{7}|={7}|>{7})/m.test(content), `Конфликтный маркер в ${name}`);
        for (const excluded of config.scope.excludedTables) {
            assert(!content.includes(excluded), `Исключённый объект ${excluded} попал в ${name}`);
        }
    }
}

function isBareIdentifierExpression(expression) {
    return /^\(?[a-zA-Z_][a-zA-Z0-9_]*\)?$/.test(expression);
}

function assertNoUnreviewedExpressionLeaks(files, expressions) {
    const contents = Object.entries(files);
    for (const item of expressions) {
        const expression = String(item.expression || '').trim();
        if (expression.length < 4 || isBareIdentifierExpression(expression)) continue;
        if (item.kind === 'DEFAULT' && !sanitizeDefault(expression).startsWith('Есть;')) continue;
        const leaked = contents.find(([, content]) => content.includes(expression));
        assert(!leaked, `Непроверенное выражение ${item.kind} из ${item.object} (${item.detail}) попало в ${leaked ? leaked[0] : 'документацию'}`);
    }
}

function restrictedPolicy(name, config) {
    const policies = [];
    if (config.restrictedObjects && config.restrictedObjects[name]) policies.push(config.restrictedObjects[name]);
    for (const [pattern, policy] of Object.entries(config.restrictedPatterns || {})) {
        if (matchesGlob(name, pattern)) policies.push(policy);
    }
    if (policies.length === 0) return null;
    return {
        mode: 'structure-only',
        allowExamples: false,
        allowValues: false,
        valueRestrictedColumns: unique(policies.flatMap(policy => policy.valueRestrictedColumns || []))
    };
}

function columnDescription(name, column, descriptions, policy) {
    const explicit = (descriptions.columns || {})[`${name}.${column}`];
    if (explicit) return explicit;
    if (policy && policy.valueRestrictedColumns.includes(column)) return 'Значения не публикуются.';
    return '—';
}

function renderRestriction(policy) {
    if (!policy) return [];
    return ['', '> Ограниченный режим: публикуются только структура и проверенные описания. Реальные значения и примеры запрещены.'];
}

function renderTable(name, config, descriptions, metadata) {
    const rows = metadata.columns.byObject.get(name);
    const policy = restrictedPolicy(name, config);
    const description = (descriptions.tables || {})[name] || 'Описание не задано.';
    const lines = [`### ${inlineCode(name)}`, '', escapeMarkdown(description), ...renderRestriction(policy), '', '#### Колонки', '',
        '| # | Колонка | Тип | Допустимость | Атрибуты | По умолчанию | Описание |',
        '|---:|---|---|---|---|---|---|'];
    for (const row of rows) {
        const attributes = [];
        if (row.identity === 'a') attributes.push('IDENTITY ALWAYS');
        if (row.identity === 'd') attributes.push('IDENTITY BY DEFAULT');
        if (row.generated) attributes.push('GENERATED');
        lines.push(`| ${row.attnum} | ${inlineCode(row.column_name)} | ${inlineCode(row.data_type)} | ${row.not_null ? 'NOT NULL' : 'NULL'} | ${attributes.length ? attributes.join(', ') : '—'} | ${sanitizeDefault(row.default_expression)} | ${escapeMarkdown(columnDescription(name, row.column_name, descriptions, policy))} |`);
    }

    const constraints = metadata.constraints.get(name) || [];
    const primary = constraints.find(constraint => constraint.type === 'p');
    if (primary) {
        lines.push('', '#### Первичный ключ', '', `${inlineCode(primary.name)}: ${primary.columns.map(inlineCode).join(', ')}`);
    }
    const foreignKeys = constraints.filter(constraint => constraint.type === 'f');
    if (foreignKeys.length) {
        lines.push('', '#### Внешние ключи', '', '| Ограничение | Колонки | Ссылка | ON DELETE | ON UPDATE |', '|---|---|---|---|---|');
        for (const fk of foreignKeys) {
            const allowedReference = config.scope.tables.includes(fk.refObject);
            const reference = allowedReference
                ? `${inlineCode(fk.refObject)} (${fk.refColumns.map(inlineCode).join(', ')})`
                : 'Недокументируемый объект';
            lines.push(`| ${inlineCode(fk.name)} | ${fk.columns.map(inlineCode).join(', ')} | ${reference} | ${actionName(fk.deleteAction)} | ${actionName(fk.updateAction)} |`);
        }
    }
    const uniqueConstraints = constraints.filter(constraint => constraint.type === 'u');
    if (uniqueConstraints.length) {
        lines.push('', '#### Уникальные ограничения', '');
        for (const constraint of uniqueConstraints) lines.push(`- ${inlineCode(constraint.name)}: ${constraint.columns.map(inlineCode).join(', ')}`);
    }
    const checks = constraints.filter(constraint => constraint.type === 'c');
    if (checks.length) {
        lines.push('', '#### CHECK-ограничения', '');
        for (const constraint of checks) lines.push(`- ${inlineCode(constraint.name)} — выражение скрыто до проверки.`);
    }

    const indexes = metadata.indexes.get(name) || [];
    if (indexes.length) {
        lines.push('', '#### Индексы', '', '| Имя | Тип | Уникальный | Колонки | Особенности |', '|---|---|:---:|---|---|');
        for (const index of indexes) {
            const features = [];
            if (index.primary) features.push('PRIMARY KEY');
            if (index.partial) features.push('частичный; WHERE скрыт до проверки');
            if (index.hasExpressions) features.push('выражение скрыто до проверки');
            if (!index.valid) features.push('невалидный');
            let columns = index.keyColumns.map(column => column === 'выражение скрыто' ? column : inlineCode(column)).join(', ');
            if (index.includeColumns.length) columns += `; INCLUDE: ${index.includeColumns.map(inlineCode).join(', ')}`;
            lines.push(`| ${inlineCode(index.name)} | ${inlineCode(index.type)} | ${index.unique ? 'да' : 'нет'} | ${columns || '—'} | ${features.length ? features.join('; ') : '—'} |`);
        }
    }
    return lines;
}

function renderView(name, config, descriptions, metadata) {
    const rows = metadata.columns.byObject.get(name);
    const policy = restrictedPolicy(name, config);
    const description = (descriptions.views || {})[name] || 'Описание не задано.';
    const lines = [`### ${inlineCode(name)}`, '', escapeMarkdown(description), ...renderRestriction(policy), '', '| # | Колонка | Тип | Описание |', '|---:|---|---|---|'];
    for (const row of rows) {
        lines.push(`| ${row.attnum} | ${inlineCode(row.column_name)} | ${inlineCode(row.data_type)} | ${escapeMarkdown(columnDescription(name, row.column_name, descriptions, policy))} |`);
    }
    const allowed = new Set([...config.scope.tables, ...config.scope.views]);
    const dependencies = unique(metadata.dependencies.get(name) || []).filter(dependency => allowed.has(dependency)).sort();
    lines.push('', '#### Зависимости', '');
    if (dependencies.length) {
        for (const dependency of dependencies) lines.push(`- ${inlineCode(dependency)}`);
    } else {
        lines.push('Разрешённые зависимости не найдены.');
    }
    return lines;
}

function actionName(action) {
    return ({ a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' })[action] || '—';
}

function allForeignKeys(config, metadata) {
    const allowedTables = new Set(config.scope.tables);
    const result = [];
    for (const table of config.scope.tables) {
        for (const fk of (metadata.constraints.get(table) || []).filter(constraint => constraint.type === 'f')) {
            if (allowedTables.has(fk.refObject)) result.push(fk);
        }
    }
    return result.sort((a, b) => `${a.object}:${a.name}`.localeCompare(`${b.object}:${b.name}`));
}

function mermaidEntity(name) {
    return name.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase();
}

function renderMermaid(foreignKeys) {
    const lines = ['```mermaid', 'erDiagram'];
    for (const fk of foreignKeys) {
        const label = fk.columns.join(', ').replace(/"/g, "'");
        lines.push(`  ${mermaidEntity(fk.refObject)} ||--o{ ${mermaidEntity(fk.object)} : "${label}"`);
    }
    lines.push('```');
    return lines;
}

function generatedFile(title) {
    return [GENERATED_MARKER, `# ${title}`, '', '> Автоматически сгенерировано. Не редактировать вручную.'];
}

function renderDocumentation(config, descriptions, metadata) {
    const files = {};
    const foreignKeys = allForeignKeys(config, metadata);
    const domains = [];
    for (const domain of config.output.domains) {
        const schemas = new Set(domain.schemas);
        const tables = config.scope.tables.filter(name => schemas.has(name.split('.')[0]));
        const views = config.scope.views.filter(name => schemas.has(name.split('.')[0]));
        const objects = new Set([...tables, ...views]);
        const domainForeignKeys = foreignKeys.filter(fk => objects.has(fk.object) || objects.has(fk.refObject));
        const lines = generatedFile(domain.title);
        lines.push('', `Таблиц: ${tables.length}. Представлений: ${views.length}.`);
        if (tables.length) {
            lines.push('', '## Таблицы');
            for (const table of tables) lines.push('', ...renderTable(table, config, descriptions, metadata));
        }
        if (views.length) {
            lines.push('', '## Представления');
            for (const view of views) lines.push('', ...renderView(view, config, descriptions, metadata));
        }
        lines.push('', '## Диаграмма физических связей', '');
        if (domainForeignKeys.length) lines.push(...renderMermaid(domainForeignKeys));
        else lines.push('Физические связи внешними ключами в этом домене не заданы.');
        lines.push('', '[Назад к навигации](index.md)', '');
        files[domain.file] = lines.join('\n');
        domains.push({ ...domain, tables: tables.length, views: views.length, foreignKeys: domainForeignKeys.length });
    }

    const index = generatedFile('Структура базы данных');
    index.push('', `Основных таблиц: ${config.scope.tables.length}. Обычных представлений: ${config.scope.views.length}.`, '',
        'Документация содержит только техническую структуру и проверенные публичные описания. SQL представлений, функции, реальные значения и непроверенные выражения не публикуются.', '',
        '| Раздел | Таблицы | Представления | Связи FK |', '|---|---:|---:|---:|');
    for (const domain of domains) index.push(`| [${domain.title}](${domain.file}) | ${domain.tables} | ${domain.views} | ${domain.foreignKeys} |`);
    index.push('', `[Связи между объектами](${config.output.relationsFile})`, '');
    files[config.output.indexFile] = index.join('\n');

    const relations = generatedFile('Связи между объектами');
    relations.push('', `Физических внешних ключей между разрешёнными таблицами: ${foreignKeys.length}.`, '');
    if (foreignKeys.length) {
        relations.push('| Таблица | Ограничение | Колонки | Ссылается на | ON DELETE | ON UPDATE |', '|---|---|---|---|---|---|');
        for (const fk of foreignKeys) {
            relations.push(`| ${inlineCode(fk.object)} | ${inlineCode(fk.name)} | ${fk.columns.map(inlineCode).join(', ')} | ${inlineCode(fk.refObject)} (${fk.refColumns.map(inlineCode).join(', ')}) | ${actionName(fk.deleteAction)} | ${actionName(fk.updateAction)} |`);
        }
    }
    relations.push('', '## Логические связи', '');
    const manual = config.relations && Array.isArray(config.relations.manual) ? config.relations.manual : [];
    if (manual.length) {
        for (const relation of manual) relations.push(`- ${inlineCode(relation.from)} → ${inlineCode(relation.to)} — ${escapeMarkdown(relation.description || '')}. **${escapeMarkdown(config.relations.logicalLabel)}**`);
    } else {
        relations.push('Ручные логические связи не заданы.');
    }
    relations.push('', 'Mermaid-диаграммы разделены по доменам и находятся в соответствующих разделах.', '', '[Назад к навигации](index.md)', '');
    files[config.output.relationsFile] = relations.join('\n');

    assertSafeGeneratedContent(files, config);
    assertNoUnreviewedExpressionLeaks(files, metadata.sensitiveExpressions || []);
    return files;
}

function syncGenerated(files, directory, check) {
    const expected = new Set(Object.keys(files));
    const differences = [];
    let changed = 0;
    if (!check) fs.mkdirSync(directory, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
        const file = path.join(directory, name);
        if (!fs.existsSync(file)) {
            differences.push(`отсутствует: ${name}`);
            if (!check) {
                fs.writeFileSync(file, content);
                changed++;
            }
        } else if (fs.readFileSync(file, 'utf8') !== content) {
            differences.push(`отличается: ${name}`);
            if (!check) {
                fs.writeFileSync(file, content);
                changed++;
            }
        }
    }
    if (fs.existsSync(directory)) {
        for (const name of fs.readdirSync(directory)) {
            if (!name.endsWith('.md') || expected.has(name)) continue;
            const file = path.join(directory, name);
            const content = fs.readFileSync(file, 'utf8');
            if (!content.startsWith(GENERATED_MARKER)) continue;
            differences.push(`лишний файл: ${name}`);
            if (!check) {
                fs.unlinkSync(file);
                changed++;
            }
        }
    }
    return { differences, changed };
}

async function buildDocumentation() {
    const config = readJson(CONFIG_PATH);
    validateConfig(config);
    const descriptions = readJson(resolveFromRoot(config.descriptions.file));
    const metadata = await introspect(config);
    const missing = validateDescriptions(config, descriptions, metadata);
    const files = renderDocumentation(config, descriptions, metadata);
    return { config, files, missing };
}

function showHelp() {
    console.log('Использование: node scripts/generate-db-docs.js [--check]');
    console.log('Без флагов — сформировать docs/database/generated.');
    console.log('--check — только проверить соответствие, ничего не записывать.');
}

async function main(options = {}) {
    const args = options.args || process.argv.slice(2);
    const logger = options.logger || console;
    if (args.includes('--help') || args.includes('-h')) {
        showHelp();
        return;
    }
    const unknown = args.filter(arg => arg !== '--check');
    assert(unknown.length === 0, `Неизвестные аргументы: ${unknown.join(', ')}`);
    const check = args.includes('--check');
    const build = options.buildDocumentation || buildDocumentation;
    const { config, files, missing } = await build();
    const directory = options.directory || resolveFromRoot(config.output.directory);
    const result = syncGenerated(files, directory, check);
    if (check && result.differences.length) {
        const error = new Error(`Документация не актуальна:\n${result.differences.join('\n')}`);
        error.exitCode = 1;
        throw error;
    }
    logger.log(check
        ? `Документация актуальна: ${Object.keys(files).length} файлов.`
        : `Документация сформирована: ${Object.keys(files).length} файлов, изменено ${result.changed}.`);
    if (missing.missingTables.length) logger.warn(`Нет публичного описания таблиц (${missing.missingTables.length}): ${missing.missingTables.join(', ')}`);
    if (missing.missingViews.length) logger.warn(`Нет публичного описания представлений (${missing.missingViews.length}): ${missing.missingViews.join(', ')}`);
    return result;
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = error.exitCode || 1;
    });
}

module.exports = {
    matchesGlob,
    sanitizeDefault,
    restrictedPolicy,
    renderDocumentation,
    validateConfig,
    validateInventory,
    assertSafeGeneratedContent,
    assertNoUnreviewedExpressionLeaks,
    isBareIdentifierExpression,
    syncGenerated,
    introspect,
    buildDocumentation,
    main
};
