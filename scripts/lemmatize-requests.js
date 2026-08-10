// scripts/lemmatize-requests.js
// Разбивает common.requests на слова и проставляет им леммы через
// services/lemmatizer/app.py (pymorphy3), заполняя
// common.request_words / common.requests_words.
//
// Запуск: node scripts/lemmatize-requests.js
// Требует запущенный лемматизатор: python services/lemmatizer/app.py
// (адрес — LEMMATIZER_API_URL, по умолчанию http://localhost:5001)
//
// Идемпотентно: обрабатывает только запросы, для которых ещё нет ни одной
// строки в common.requests_words, поэтому безопасно перезапускать
// (в т.ч. регулярно — новые запросы из common.requests подхватятся сами).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const DatabaseManager = require('../core/DatabaseManager');
const Logger = require('../core/Logger');

const SCHEMA_FILE = path.join(__dirname, '..', 'services', 'lemmatizer', 'schema.sql');
const LEMMATIZER_API_URL = process.env.LEMMATIZER_API_URL || 'http://localhost:5001';
const BATCH_SIZE = 500;

// Токен — последовательность букв (кириллица + латиница), минимум 2 символа.
// Числа/спецсимволы (например "24/7", "ez") в леммы не превращаем.
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

        const { rows: requests } = await db.query(`
            SELECT r.request_id, r.request
            FROM common.requests r
            WHERE NOT EXISTS (
                SELECT 1 FROM common.requests_words rw WHERE rw.request_id = r.request_id
            )
        `);

        logger.info(`Запросов без разбора на слова: ${requests.length}`);
        if (requests.length === 0) {
            logger.info('Нечего обрабатывать.');
            return;
        }

        // 1. Собираем все уникальные слова из необработанных запросов
        const requestWords = new Map(); // request_id -> [word, ...]
        const allWords = new Set();
        for (const r of requests) {
            const words = tokenize(r.request);
            requestWords.set(r.request_id, words);
            words.forEach(w => allWords.add(w));
        }
        logger.info(`Уникальных слов: ${allWords.size}`);

        // 2. Какие слова уже есть в справочнике (не дёргаем лемматизатор повторно)
        const { rows: existingWords } = await db.query(
            `SELECT word_id, word FROM common.request_words WHERE word = ANY($1)`,
            [[...allWords]]
        );
        const wordIdByWord = new Map(existingWords.map(w => [w.word, w.word_id]));
        const newWords = [...allWords].filter(w => !wordIdByWord.has(w));
        logger.info(`Новых слов для лемматизации: ${newWords.length}`);

        // 3. Лемматизируем новые слова батчами и вставляем в справочник
        for (let i = 0; i < newWords.length; i += BATCH_SIZE) {
            const batch = newWords.slice(i, i + BATCH_SIZE);
            const lemmas = await fetchLemmas(batch);

            for (const word of batch) {
                const lemma = lemmas[word] || word;
                const { rows } = await db.query(
                    `INSERT INTO common.request_words (word, lemma)
                     VALUES ($1, $2)
                     ON CONFLICT (word) DO UPDATE SET lemma = EXCLUDED.lemma
                     RETURNING word_id`,
                    [word, lemma]
                );
                wordIdByWord.set(word, rows[0].word_id);
            }
            logger.info(`Лемматизировано ${Math.min(i + BATCH_SIZE, newWords.length)} / ${newWords.length}`);
        }

        // 4. Линкуем запросы со словами
        let linked = 0;
        for (const [requestId, words] of requestWords.entries()) {
            for (const word of words) {
                const wordId = wordIdByWord.get(word);
                if (!wordId) continue;
                await db.query(
                    `INSERT INTO common.requests_words (request_id, word_id)
                     VALUES ($1, $2)
                     ON CONFLICT DO NOTHING`,
                    [requestId, wordId]
                );
            }
            linked++;
        }
        logger.info(`Готово. Связано запросов: ${linked}`);
    } finally {
        await db.disconnect();
    }
}

main().catch(err => {
    logger.error(`Ошибка: ${err.message}`);
    process.exit(1);
});
