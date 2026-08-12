// scripts/lemmatize-gsc-queries.js
// Группирует запросы из gsc.top_queries_by_page.query по одинаковому набору
// лемм — тот же принцип, что и scripts/lemmatize-requests.js для
// common.requests, и переиспользует те же справочники (common.request_words,
// common.request_groups): если запрос уже встречался в common.requests,
// попадёт в ту же группу.
//
// Запуск: node scripts/lemmatize-gsc-queries.js
// Требует запущенный лемматизатор: python services/lemmatizer/app.py
// (адрес — LEMMATIZER_API_URL, по умолчанию http://localhost:5001)
//
// Идемпотентно: обрабатывает только строки с group_id IS NULL. У таблицы нет
// serial id (PK — url+period+query), поэтому group_id проставляется по
// совпадению текста query, а не по id строки — один запрос сразу получает
// group_id во всех своих строках (для разных url/period).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const DatabaseManager = require('../core/DatabaseManager');
const Logger = require('../core/Logger');

const SCHEMA_FILE = path.join(__dirname, '..', 'services', 'lemmatizer', 'schema.sql');
const LEMMATIZER_API_URL = process.env.LEMMATIZER_API_URL || 'http://localhost:5001';
const BATCH_SIZE = 500;

const WORD_RE = /[a-zA-Zа-яёА-ЯЁ]{2,}/g;

const logger = new Logger('lemmatizer');

function tokenize(text) {
    const matches = text.toLowerCase().match(WORD_RE);
    return matches ? [...new Set(matches)] : [];
}

async function fetchLemmas(words) {
    if (words.length === 0) return {};
    const { data } = await axios.post(`${LEMMATIZER_API_URL}/lemmatize`, { words });
    return data.lemmas;
}

async function main() {
    const db = new DatabaseManager('lemmatizer');
    await db.connect();

    try {
        logger.info('Применяю schema.sql');
        const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
        await db.query(schema);

        const { rows: queries } = await db.query(`
            SELECT DISTINCT query
            FROM gsc.top_queries_by_page
            WHERE group_id IS NULL
        `);

        logger.info(`Уникальных запросов без группы: ${queries.length}`);
        if (queries.length === 0) {
            logger.info('Нечего обрабатывать.');
            return;
        }

        // 1. Собираем все уникальные слова из необработанных запросов
        const queryWords = new Map(); // query -> [word, ...]
        const allWords = new Set();
        for (const q of queries) {
            const words = tokenize(q.query);
            queryWords.set(q.query, words);
            words.forEach(w => allWords.add(w));
        }
        logger.info(`Уникальных слов: ${allWords.size}`);

        // 2. Какие слова уже есть в общем справочнике (common.request_words)
        const { rows: existingWords } = await db.query(
            `SELECT word_id, word, lemma FROM common.request_words WHERE word = ANY($1)`,
            [[...allWords]]
        );
        const lemmaByWord = new Map(existingWords.map(w => [w.word, w.lemma]));
        const newWords = [...allWords].filter(w => !lemmaByWord.has(w));
        logger.info(`Новых слов для лемматизации: ${newWords.length}`);

        // 3. Лемматизируем новые слова батчами, пишем в общий справочник
        for (let i = 0; i < newWords.length; i += BATCH_SIZE) {
            const batch = newWords.slice(i, i + BATCH_SIZE);
            const lemmas = await fetchLemmas(batch);

            for (const word of batch) {
                const lemma = lemmas[word] || word;
                await db.query(
                    `INSERT INTO common.request_words (word, lemma)
                     VALUES ($1, $2)
                     ON CONFLICT (word) DO UPDATE SET lemma = EXCLUDED.lemma`,
                    [word, lemma]
                );
                lemmaByWord.set(word, lemma);
            }
            logger.info(`Лемматизировано ${Math.min(i + BATCH_SIZE, newWords.length)} / ${newWords.length}`);
        }

        // 4. Считаем подпись (отсортированный уникальный набор лемм) на каждый запрос
        const signatureByQuery = new Map();
        for (const [query, words] of queryWords.entries()) {
            const lemmas = [...new Set(words.map(w => lemmaByWord.get(w)).filter(Boolean))].sort();
            if (lemmas.length === 0) continue; // запрос без единого распознанного слова (только цифры/символы)
            signatureByQuery.set(query, lemmas.join(' '));
        }

        // 5. Создаём недостающие группы в common.request_groups (общие с common.requests —
        // если такая сигнатура уже была, ON CONFLICT просто её переиспользует).
        const signatureToShortestQuery = new Map();
        for (const [query, signature] of signatureByQuery.entries()) {
            const current = signatureToShortestQuery.get(signature);
            if (!current || query.length < current.length) {
                signatureToShortestQuery.set(signature, query);
            }
        }

        for (const [signature, candidateQuery] of signatureToShortestQuery.entries()) {
            await db.query(
                `INSERT INTO common.request_groups (lemma_signature, canonical_request)
                 VALUES ($1, $2)
                 ON CONFLICT (lemma_signature) DO NOTHING`,
                [signature, candidateQuery]
            );
        }

        // 6. Проставляем group_id всем строкам gsc.top_queries_by_page с этим текстом query.
        let updatedQueries = 0;
        for (const [query, signature] of signatureByQuery.entries()) {
            const { rowCount } = await db.query(
                `UPDATE gsc.top_queries_by_page t
                 SET group_id = g.group_id
                 FROM common.request_groups g
                 WHERE g.lemma_signature = $1 AND t.query = $2 AND t.group_id IS NULL`,
                [signature, query]
            );
            if (rowCount > 0) updatedQueries++;
        }
        logger.info(`Групп проставлено для запросов: ${updatedQueries}`);
    } finally {
        await db.disconnect();
    }
}

main().catch(err => {
    logger.error(`Ошибка: ${err.message}`);
    process.exit(1);
});
