// scripts/notes-bot.js
// Долгоживущий процесс (НЕ коллектор, НЕ через cron/run-service.js) — слушает
// Telegram-бота командой /note и пишет заметки в common.notes. Запускать
// постоянно (pm2/systemd), например: pm2 start scripts/notes-bot.js --name notes-bot
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Pool } = require('pg');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const OFFSET_FILE = path.join(__dirname, '..', 'services', 'notes', '.offset');
const SCHEMA_FILE = path.join(__dirname, '..', 'services', 'notes', 'schema.sql');

if (!BOT_TOKEN || !ALLOWED_CHAT_ID) {
    console.error('❌ TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID обязательны');
    process.exit(1);
}

const db = new Pool({
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    port: process.env.PGPORT || 5432
});

// chat_id -> { categoryId, categoryName } — состояние "ждём текст заметки после выбора категории"
const pending = new Map();

function loadOffset() {
    try {
        return parseInt(fs.readFileSync(OFFSET_FILE, 'utf8'), 10) || 0;
    } catch {
        return 0;
    }
}

function saveOffset(offset) {
    fs.writeFileSync(OFFSET_FILE, String(offset));
}

async function getCategories() {
    const result = await db.query('SELECT category_id, category_name FROM common.notes_categories ORDER BY category_name');
    return result.rows;
}

async function sendMessage(chatId, text, replyMarkup) {
    await axios.post(`${API}/sendMessage`, {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: replyMarkup
    });
}

async function answerCallback(callbackQueryId) {
    await axios.post(`${API}/answerCallbackQuery`, { callback_query_id: callbackQueryId });
}

async function handleNoteCommand(chatId) {
    const categories = await getCategories();
    if (categories.length === 0) {
        await sendMessage(chatId, '⚠️ Справочник категорий пуст (common.notes_categories)');
        return;
    }

    const keyboard = {
        inline_keyboard: categories.map(c => [{ text: c.category_name, callback_data: `cat:${c.category_id}` }])
    };
    await sendMessage(chatId, '📝 Выберите категорию заметки:', keyboard);
}

async function handleCategoryChoice(chatId, categoryId, categoryName, callbackQueryId) {
    pending.set(chatId, { categoryId, categoryName });
    await answerCallback(callbackQueryId);
    await sendMessage(
        chatId,
        `Категория: <b>${categoryName}</b>\n\nТеперь пришлите одним сообщением в формате:\n` +
        `<code>ГГГГ-ММ-ДД | Заголовок | Описание</code>\n(описание можно не указывать)`
    );
}

async function handleNoteText(chatId, text) {
    const state = pending.get(chatId);
    if (!state) return false; // не в процессе создания заметки — игнорируем как обычное сообщение

    const parts = text.split('|').map(p => p.trim());
    const [dateStr, title, description] = parts;

    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        await sendMessage(chatId, '⚠️ Дата должна быть первой и в формате ГГГГ-ММ-ДД. Формат: ГГГГ-ММ-ДД | Заголовок | Описание');
        return true;
    }
    if (!title) {
        await sendMessage(chatId, '⚠️ Заголовок не может быть пустым. Формат: ГГГГ-ММ-ДД | Заголовок | Описание');
        return true;
    }

    await db.query(
        `INSERT INTO common.notes (title, description, event_date, category_id, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [title, description || null, dateStr, state.categoryId, String(chatId)]
    );

    pending.delete(chatId);
    await sendMessage(chatId, `✅ Заметка добавлена: <b>${title}</b> (${state.categoryName}, ${dateStr})`);
    return true;
}

async function processUpdate(update) {
    if (update.callback_query) {
        const cq = update.callback_query;
        const chatId = cq.message.chat.id;
        if (String(chatId) !== String(ALLOWED_CHAT_ID)) return;

        const match = /^cat:(\d+)$/.exec(cq.data || '');
        if (match) {
            const categories = await getCategories();
            const cat = categories.find(c => String(c.category_id) === match[1]);
            if (cat) {
                await handleCategoryChoice(chatId, cat.category_id, cat.category_name, cq.id);
            }
        }
        return;
    }

    const message = update.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    if (String(chatId) !== String(ALLOWED_CHAT_ID)) return;

    const text = message.text.trim();

    if (text === '/note' || text.startsWith('/note@')) {
        await handleNoteCommand(chatId);
        return;
    }

    await handleNoteText(chatId, text);
}

async function pollLoop() {
    let offset = loadOffset();

    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            const resp = await axios.get(`${API}/getUpdates`, {
                params: { offset: offset + 1, timeout: 30 },
                timeout: 35000
            });

            for (const update of resp.data.result) {
                offset = update.update_id;
                try {
                    await processUpdate(update);
                } catch (error) {
                    console.error(`Ошибка обработки update ${update.update_id}:`, error.message);
                }
            }

            if (resp.data.result.length > 0) {
                saveOffset(offset);
            }
        } catch (error) {
            console.error('Ошибка long polling:', error.message);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

async function main() {
    const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
    await db.query(schema);
    console.log('✅ Схема common.notes создана/обновлена');

    console.log('🤖 notes-bot запущен, слушаю команду /note');
    await pollLoop();
}

main().catch(error => {
    console.error('💥 Критическая ошибка notes-bot:', error);
    process.exit(1);
});
