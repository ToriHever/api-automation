const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pg = require('pg');

const OriginalClient = pg.Client;
let databaseAccessAttempted = false;
pg.Client = class {
    constructor() {
        databaseAccessAttempted = true;
        throw new Error('Обращение к БД запрещено в unit-тестах генератора');
    }
};
after(() => {
    pg.Client = OriginalClient;
});

const generator = require('../scripts/generate-db-docs.js');
const {
    matchesGlob,
    sanitizeDefault,
    restrictedPolicy,
    renderDocumentation,
    validateConfig,
    validateInventory,
    assertSafeGeneratedContent,
    assertNoUnreviewedExpressionLeaks,
    syncGenerated,
    main
} = generator;

const MARKER = '<!-- docs-db:generated -->';

function makeConfig() {
    return {
        newObjects: 'deny',
        source: { readOnly: true, includeDatabaseComments: false },
        scope: {
            tables: ['common.parent', 'common.child'],
            views: ['common.v_child'],
            excludedTables: ['common.old_backup']
        },
        tableMetadata: { includeDefaults: 'reviewed-only' },
        views: { includeDefinitions: false, includeDatabaseComments: false },
        materializedViews: { mode: 'exclude-all' },
        functions: {
            mode: 'exclude-all',
            includeSignatures: false,
            includeSource: false,
            includeAdministrativeFunctions: false
        },
        expressions: {
            defaults: 'review-required',
            checks: 'presence-only',
            partialIndexes: 'presence-only',
            indexExpressions: 'presence-only'
        },
        restrictedObjects: {
            'common.child': {
                allowExamples: false,
                allowValues: false,
                valueRestrictedColumns: ['parent_id']
            }
        },
        restrictedPatterns: {
            'common.v_*': {
                allowExamples: false,
                allowValues: false,
                valueRestrictedColumns: []
            }
        },
        relations: {
            manual: [],
            logicalLabel: 'Логическая связь, не ограничение БД'
        },
        descriptions: {
            file: 'docs/database/public-descriptions.json'
        },
        output: {
            directory: 'docs/database/generated',
            indexFile: 'index.md',
            relationsFile: 'relations.md',
            domains: [{ file: 'common.md', title: 'Common', schemas: ['common'] }]
        },
        safety: {
            includeOwners: false,
            includePrivileges: false,
            includeViewDefinitions: false,
            includeRowCounts: false,
            includeSampleData: false,
            includeConnectionParameters: false,
            includeServerVersion: false,
            includeFullDump: false,
            includeStatistics: false,
            includeTableSizes: false,
            includePolicies: false,
            includeFunctionDefinitions: false
        }
    };
}

function column(name, ordinal, type, options = {}) {
    return {
        column_name: name,
        attnum: ordinal,
        data_type: type,
        not_null: false,
        identity: '',
        generated: '',
        default_expression: null,
        ...options
    };
}

function makeMetadata() {
    const columns = new Map([
        ['common.parent', [
            column('id', 1, 'integer', { not_null: true, identity: 'a', default_expression: "nextval('private_sequence'::regclass)" }),
            column('label', 2, 'text', { not_null: true, default_expression: "''::text" }),
            column('secret', 3, 'text', { default_expression: "'internal-default'" })
        ]],
        ['common.child', [
            column('id', 1, 'integer', { not_null: true, default_expression: '0' }),
            column('parent_id', 2, 'integer'),
            column('name', 3, 'text', { not_null: true })
        ]],
        ['common.v_child', [
            column('id', 1, 'integer'),
            column('parent_id', 2, 'integer')
        ]]
    ]);
    return {
        columns: { byObject: columns, byAttnum: new Map() },
        constraints: new Map([
            ['common.parent', [
                { name: 'parent_pkey', type: 'p', object: 'common.parent', columns: ['id'] },
                { name: 'parent_label_key', type: 'u', object: 'common.parent', columns: ['label'] }
            ]],
            ['common.child', [
                { name: 'child_pkey', type: 'p', object: 'common.child', columns: ['id'] },
                {
                    name: 'child_parent_fkey',
                    type: 'f',
                    object: 'common.child',
                    columns: ['parent_id'],
                    refObject: 'common.parent',
                    refColumns: ['id'],
                    deleteAction: 'c',
                    updateAction: 'a'
                },
                { name: 'child_positive', type: 'c', object: 'common.child', columns: ['parent_id'] }
            ]]
        ]),
        indexes: new Map([
            ['common.parent', [
                { name: 'parent_pkey', type: 'btree', unique: true, primary: true, valid: true, partial: false, hasExpressions: false, keyColumns: ['id'], includeColumns: [] }
            ]],
            ['common.child', [
                { name: 'idx_child_parent', type: 'btree', unique: false, primary: false, valid: true, partial: true, hasExpressions: true, keyColumns: ['parent_id'], includeColumns: ['name'] }
            ]]
        ]),
        dependencies: new Map([
            ['common.v_child', ['common.child', 'common.parent', 'common.old_backup']]
        ]),
        sensitiveExpressions: [
            { kind: 'DEFAULT', object: 'common.parent', detail: 'id', expression: "nextval('private_sequence'::regclass)" },
            { kind: 'DEFAULT', object: 'common.parent', detail: 'secret', expression: "'internal-default'" },
            { kind: 'CHECK', object: 'common.child', detail: 'child_positive', expression: 'CHECK ((parent_id > 0))' },
            { kind: 'PARTIAL_INDEX', object: 'common.child', detail: 'idx_child_parent', expression: '(parent_id > 0)' },
            { kind: 'INDEX_EXPRESSION', object: 'common.child', detail: 'idx_child_parent', expression: 'lower(name)' }
        ]
    };
}

function makeDescriptions() {
    return {
        tables: {
            'common.parent': 'Родительская | таблица',
            'common.child': 'Дочерняя таблица'
        },
        views: {
            'common.v_child': 'Представление дочерних записей'
        },
        columns: {
            'common.child.parent_id': 'Идентификатор | родителя'
        }
    };
}

function makeFiles() {
    return renderDocumentation(makeConfig(), makeDescriptions(), makeMetadata());
}

function temporaryDirectory(t) {
    const base = path.join(process.cwd(), 'scripts', 'output');
    fs.mkdirSync(base, { recursive: true });
    const directory = fs.mkdtempSync(path.join(base, 'db-docs-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

test('matchesGlob: точные имена и шаблоны', () => {
    assert.equal(matchesGlob('gsc.search_console', 'gsc.*'), true);
    assert.equal(matchesGlob('common.requests', 'gsc.*'), false);
    assert.equal(matchesGlob('common.old_backup', '*_backup'), true);
    assert.equal(matchesGlob('common.parent', 'common.?arent'), true);
    assert.equal(matchesGlob('common.parent', 'topvisor.*'), false);
});

test('sanitizeDefault: безопасные значения и скрытие выражений', () => {
    assert.equal(sanitizeDefault('0'), '`0`');
    assert.equal(sanitizeDefault('true'), '`true`');
    assert.equal(sanitizeDefault('CURRENT_TIMESTAMP'), '`CURRENT_TIMESTAMP`');
    assert.equal(sanitizeDefault("'{}'::jsonb"), "`'{}'::jsonb`");
    assert.equal(sanitizeDefault("nextval('private_sequence'::regclass)"), '`nextval(…)`');
    assert.equal(sanitizeDefault("'internal-default'"), 'Есть; выражение скрыто до проверки');
});

test('validateInventory: разрешённые, исключённые и новые объекты', () => {
    const config = makeConfig();
    const inventory = [
        { schema: 'common', name: 'parent', kind: 'r' },
        { schema: 'common', name: 'child', kind: 'r' },
        { schema: 'common', name: 'old_backup', kind: 'r' },
        { schema: 'common', name: 'v_child', kind: 'v' }
    ];
    validateInventory(inventory, config);
    assert.throws(() => validateInventory([
        ...inventory,
        { schema: 'common', name: 'new_table', kind: 'r' }
    ], config), /Новые таблицы требуют проверки/);
    assert.throws(() => validateInventory(inventory.slice(1), config), /отсутствуют в БД/);
    assert.throws(() => validateInventory([
        ...inventory,
        { schema: 'common', name: 'mv', kind: 'm' }
    ], config), /материализованные представления/);
    const conflict = makeConfig();
    conflict.scope.tables.push('common.old_backup');
    assert.throws(() => validateInventory(inventory, conflict), /попали в allowlist/);
});

test('validateConfig: запрет ослабления безопасности', () => {
    validateConfig(makeConfig());
    const unsafe = makeConfig();
    unsafe.safety.includeOwners = true;
    assert.throws(() => validateConfig(unsafe), /safety.includeOwners/);
    const unsafeValues = makeConfig();
    unsafeValues.restrictedObjects['common.child'].allowValues = true;
    assert.throws(() => validateConfig(unsafeValues), /примеры и значения/);
});

test('renderDocumentation: структура, PK/FK/UNIQUE, представления и Mermaid', () => {
    const files = makeFiles();
    const common = files['common.md'];
    assert(common.includes('### `common.parent`'));
    assert(common.includes('### `common.child`'));
    assert(common.includes('### `common.v_child`'));
    assert(common.includes('`parent_pkey`: `id`'));
    assert(common.includes('`parent_label_key`: `label`'));
    assert(common.includes('CASCADE'));
    assert(common.includes('NO ACTION'));
    assert(common.includes('- `common.child`'));
    assert(common.includes('- `common.parent`'));
    assert(common.includes('COMMON_PARENT ||--o{ COMMON_CHILD : "parent_id"'));
    assert(files['index.md'].includes('Основных таблиц: 2. Обычных представлений: 1.'));
    assert(files['relations.md'].includes('`child_parent_fkey`'));
});

test('renderDocumentation: скрывает выражения и показывает ограниченный режим', () => {
    const files = makeFiles();
    const common = files['common.md'];
    assert(!common.includes('private_sequence'));
    assert(!common.includes('internal-default'));
    assert(!common.includes('CHECK ((parent_id > 0))'));
    assert(!common.includes('lower(name)'));
    assert(common.includes('выражение скрыто до проверки'));
    assert(common.includes('WHERE скрыт до проверки'));
    assert(common.includes('Ограниченный режим'));
});

test('renderDocumentation: экранирование и фильтрация зависимостей', () => {
    const common = makeFiles()['common.md'];
    assert(common.includes('Родительская \\| таблица'));
    assert(common.includes('Идентификатор \\| родителя'));
    assert(!common.includes('common.old_backup'));
});

test('renderDocumentation: детерминированный результат', () => {
    assert.deepStrictEqual(makeFiles(), makeFiles());
});

test('renderDocumentation: небезопасное описание останавливает генерацию', () => {
    const descriptions = makeDescriptions();
    descriptions.tables['common.parent'] = 'postgres://user:password@example/db';
    assert.throws(
        () => renderDocumentation(makeConfig(), descriptions, makeMetadata()),
        error => !error.message.includes('password')
    );
});

test('assertSafeGeneratedContent: блокирует секреты, DDL, права и дампы', () => {
    const config = makeConfig();
    assertSafeGeneratedContent({ 'index.md': `${MARKER}\n# Безопасно` }, config);
    const forbidden = [
        'postgres://user:password@example/db',
        'DATABASE_URL=secret-value',
        'https://example.internal/path',
        '192.168.10.20',
        'Bearer abcdefgh123456',
        'BEGIN OPENSSH PRIVATE KEY',
        'CREATE VIEW example AS SELECT 1',
        'CREATE FUNCTION example() RETURNS void AS $$ SELECT 1 $$',
        'GRANT SELECT ON example TO public',
        'INSERT INTO example VALUES (1)',
        'COMMENT ON TABLE example IS \'internal\'',
        'SELECT obj_description(oid)'
    ];
    for (const content of forbidden) {
        assert.throws(() => assertSafeGeneratedContent({ 'index.md': content }, config));
    }
    assert.throws(() => assertSafeGeneratedContent({ 'index.md': 'common.old_backup' }, config), /Исключённый объект/);
});

test('assertNoUnreviewedExpressionLeaks: блокирует выражения, но разрешает имена колонок', () => {
    assertNoUnreviewedExpressionLeaks(
        { 'index.md': 'Колонка `is_captcha` и безопасный default `0`.' },
        [
            { kind: 'PARTIAL_INDEX', object: 'common.child', detail: 'idx', expression: 'is_captcha' },
            { kind: 'DEFAULT', object: 'common.child', detail: 'id', expression: '0' }
        ]
    );
    assert.throws(() => assertNoUnreviewedExpressionLeaks(
        { 'index.md': 'CHECK ((parent_id > 0))' },
        [{ kind: 'CHECK', object: 'common.child', detail: 'child_positive', expression: 'CHECK ((parent_id > 0))' }]
    ), error => !error.message.includes('parent_id > 0'));
});

test('restrictedPolicy: объединяет точные и шаблонные правила', () => {
    const config = makeConfig();
    const exact = restrictedPolicy('common.child', config);
    assert.equal(exact.allowValues, false);
    assert(exact.valueRestrictedColumns.includes('parent_id'));
    assert(restrictedPolicy('common.v_child', config));
    assert.equal(restrictedPolicy('common.parent', config), null);
});

test('syncGenerated: запись, повторный запуск и обнаружение изменений', t => {
    const directory = temporaryDirectory(t);
    const files = { 'index.md': `${MARKER}\n# Первый вариант\n` };
    let result = syncGenerated(files, directory, true);
    assert(result.differences[0].includes('отсутствует'));
    assert.equal(fs.existsSync(path.join(directory, 'index.md')), false);

    result = syncGenerated(files, directory, false);
    assert.equal(result.changed, 1);
    assert.equal(syncGenerated(files, directory, false).changed, 0);
    assert.deepStrictEqual(syncGenerated(files, directory, true).differences, []);

    fs.appendFileSync(path.join(directory, 'index.md'), '\nИзменение\n');
    result = syncGenerated(files, directory, true);
    assert(result.differences.some(value => value.includes('отличается')));
});

test('syncGenerated: удаляет только устаревшие автогенерированные файлы', t => {
    const directory = temporaryDirectory(t);
    fs.mkdirSync(directory, { recursive: true });
    const stale = path.join(directory, 'stale.md');
    const manual = path.join(directory, 'manual.md');
    fs.writeFileSync(stale, `${MARKER}\n# Старый файл\n`);
    fs.writeFileSync(manual, '# Ручной файл\n');
    const files = { 'index.md': `${MARKER}\n# Актуальный файл\n` };

    let result = syncGenerated(files, directory, true);
    assert(result.differences.some(value => value.includes('лишний файл: stale.md')));
    assert.equal(fs.existsSync(stale), true);

    result = syncGenerated(files, directory, false);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(manual), true);
});

test('main --check: код ошибки 1 без записи и без production-БД', async t => {
    const directory = temporaryDirectory(t);
    fs.rmSync(directory, { recursive: true, force: true });
    const config = makeConfig();
    const files = { 'index.md': `${MARKER}\n# Проверка\n` };
    const options = {
        args: ['--check'],
        directory,
        logger: { log() {}, warn() {} },
        buildDocumentation: async () => ({
            config,
            files,
            missing: { missingTables: [], missingViews: [] }
        })
    };
    await assert.rejects(
        main(options),
        error => error.exitCode === 1 && error.message.includes('отсутствует: index.md')
    );
    assert.equal(fs.existsSync(directory), false);

    syncGenerated(files, directory, false);
    const result = await main(options);
    assert.deepStrictEqual(result.differences, []);
});

test('все тесты выполнены без обращения к production-БД', () => {
    assert.equal(databaseAccessAttempted, false);
});
