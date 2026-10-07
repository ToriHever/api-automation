// services/ai-nlp/YandexAiClient.js
// Клиент Yandex Foundation Models: YandexGPT (completion) и эмбеддинги (textEmbedding).
// Ведёт учёт токенов и оценку стоимости по тарифам из config.json и останавливает
// работу, когда оценка превышает maxCostRubPerRun (защита бюджета).

const axios = require('axios');
const config = require('./config.json');

class BudgetExceededError extends Error {
    constructor(spent, limit) {
        super(`Превышен бюджет запуска: ~${spent.toFixed(2)} ₽ из ${limit} ₽`);
        this.name = 'BudgetExceededError';
    }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class YandexAiClient {
    constructor({ modelAlias, maxCostRub } = {}) {
        this.apiKey = process.env.YANDEX_AI_API_KEY;
        this.folderId = process.env.YANDEX_AI_FOLDER_ID || process.env.YANDEX_SEARCH_FOLDER_ID;
        if (!this.apiKey || !this.folderId) {
            throw new Error('YANDEX_AI_API_KEY and YANDEX_AI_FOLDER_ID environment variables are required');
        }

        const alias = modelAlias || config.defaultModel;
        this.modelName = config.models[alias] || alias; // можно передать и прямое имя модели
        this.embeddingModelName = config.embeddingModel;
        this.maxCostRub = maxCostRub ?? config.maxCostRubPerRun;

        this.usage = { inputTokens: 0, outputTokens: 0, costRub: 0, calls: 0 };
    }

    modelUri(name, kind = 'gpt') {
        return `${kind}://${this.folderId}/${name}/latest`;
    }

    headers() {
        return {
            Authorization: `Api-Key ${this.apiKey}`,
            'x-folder-id': this.folderId,
            'Content-Type': 'application/json'
        };
    }

    addCost(modelName, inputTokens, outputTokens = 0) {
        const price = config.pricesRubPer1kTokens[modelName] || 0;
        const cost = ((inputTokens + outputTokens) / 1000) * price;
        this.usage.inputTokens += inputTokens;
        this.usage.outputTokens += outputTokens;
        this.usage.costRub += cost;
        this.usage.calls += 1;
        if (this.usage.costRub > this.maxCostRub) {
            throw new BudgetExceededError(this.usage.costRub, this.maxCostRub);
        }
    }

    async post(path, body) {
        let lastError;
        for (let attempt = 1; attempt <= config.retries; attempt++) {
            try {
                const { data } = await axios.post(`${config.baseUrl}/${path}`, body, {
                    headers: this.headers(),
                    timeout: config.timeout
                });
                await sleep(config.requestDelayMs);
                return data;
            } catch (err) {
                lastError = err;
                const status = err.response?.status;
                // 4xx кроме 429 — ошибка запроса/доступа, повтор не поможет
                if (status && status >= 400 && status < 500 && status !== 429) {
                    const detail = JSON.stringify(err.response.data || {}).slice(0, 300);
                    throw new Error(`Yandex AI ${path}: HTTP ${status} ${detail}`);
                }
                await sleep(1000 * attempt * attempt);
            }
        }
        throw new Error(`Yandex AI ${path}: не удалось после ${config.retries} попыток: ${lastError.message}`);
    }

    /**
     * Один вызов YandexGPT. Возвращает текст ответа.
     * temperature низкая — нужны стабильные структурированные ответы.
     */
    async complete(systemText, userText, { temperature = 0.1, maxTokens = 2000 } = {}) {
        const data = await this.post('completion', {
            modelUri: this.modelUri(this.modelName),
            completionOptions: { stream: false, temperature, maxTokens: String(maxTokens) },
            messages: [
                { role: 'system', text: systemText },
                { role: 'user', text: userText }
            ]
        });

        const result = data.result;
        const text = result?.alternatives?.[0]?.message?.text;
        if (!text) throw new Error('Yandex AI completion: пустой ответ');

        this.addCost(
            this.modelName,
            Number(result.usage?.inputTextTokens || 0),
            Number(result.usage?.completionTokens || 0)
        );
        return text;
    }

    /**
     * completion + разбор JSON из ответа. Один повтор, если модель вернула мусор.
     */
    async completeJson(systemText, userText, options) {
        let lastText = '';
        for (let attempt = 1; attempt <= 2; attempt++) {
            lastText = await this.complete(systemText, userText, options);
            const parsed = extractJson(lastText);
            if (parsed !== null) return parsed;
        }
        throw new Error(`Не удалось разобрать JSON из ответа модели: ${lastText.slice(0, 200)}`);
    }

    /**
     * Эмбеддинг одного текста. Возвращает массив чисел.
     */
    async embed(text) {
        const data = await this.post('textEmbedding', {
            modelUri: this.modelUri(this.embeddingModelName, 'emb'),
            text
        });
        if (!Array.isArray(data.embedding)) throw new Error('Yandex AI embedding: нет поля embedding');
        this.addCost(this.embeddingModelName, Number(data.numTokens || 0));
        return data.embedding.map(Number);
    }
}

/**
 * Достаёт JSON (массив или объект) из ответа модели: снимает ```-ограждения,
 * ищет первую скобку. Возвращает null, если разобрать не удалось.
 */
function extractJson(text) {
    const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
    const starts = [cleaned.indexOf('['), cleaned.indexOf('{')].filter(i => i >= 0);
    if (starts.length === 0) return null;
    const start = Math.min(...starts);
    const open = cleaned[start];
    const close = open === '[' ? ']' : '}';
    const end = cleaned.lastIndexOf(close);
    if (end <= start) return null;
    try {
        return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
        return null;
    }
}

/**
 * Грубая оценка токенов для dry-run: русский текст ≈ 2.5 символа на токен.
 */
function estimateTokens(text) {
    return Math.ceil(String(text).length / 2.5);
}

function estimateCostRub(modelName, tokens) {
    return (tokens / 1000) * (config.pricesRubPer1kTokens[modelName] || 0);
}

module.exports = { YandexAiClient, BudgetExceededError, extractJson, estimateTokens, estimateCostRub, config };
