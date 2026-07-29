// services/domains-meta/DomainsMetaCollector.js
const BaseCollector = require('../../core/BaseCollector');
const puppeteer = require('puppeteer');
const fs = require('fs');

class DomainsMetaCollector extends BaseCollector {
    constructor() {
        super('domains-meta');
        this.config = this.getConfig();

        if (!process.env.DOMAINS_META_COOKIES_FILE) {
            throw new Error('DOMAINS_META_COOKIES_FILE environment variable is required');
        }

        this.cookies = this.loadCookies(process.env.DOMAINS_META_COOKIES_FILE);
    }

    /**
     * Читает JSON-экспорт куки (Cookie-Editor/EditThisCookie) и приводит поля
     * к формату, который ожидает puppeteer's page.setCookie().
     */
    loadCookies(filePath) {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!Array.isArray(raw)) {
            throw new Error(`Файл куки должен быть JSON-массивом: ${filePath}`);
        }

        const sameSiteMap = {
            no_restriction: 'None',
            unspecified: undefined,
            lax: 'Lax',
            strict: 'Strict',
            none: 'None'
        };

        return raw.map(c => {
            const cookie = {
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path || '/',
                httpOnly: !!c.httpOnly,
                secure: !!c.secure
            };

            const expires = c.expirationDate ?? c.expires;
            if (typeof expires === 'number') cookie.expires = expires;

            const sameSite = typeof c.sameSite === 'string' ? sameSiteMap[c.sameSite.toLowerCase()] : undefined;
            if (sameSite) cookie.sameSite = sameSite;

            return cookie;
        });
    }

    async checkApiConnection() {
        this.logger.info('Проверка запуска Chromium');
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        await browser.close();
        this.logger.info(`Chromium запускается, куки загружены: ${this.cookies.length}`);
        return true;
    }

    /**
     * Список доменов для обработки — из l7.clients, за вычетом мусора
     * (запрещённые, IP-адреса, домены с цифрами), а также доменов, уже
     * отсканированных СЕГОДНЯ — так прогон можно спокойно перезапускать
     * после обрыва соединения: уже готовые домены не трогаются повторно,
     * обработка продолжается с того места, где оборвалась.
     * Флаг FORCE_OVERRIDE=true отключает этот пропуск (пересканировать всё заново).
     */
    async fetchData() {
        const skipAlreadyScannedToday = process.env.FORCE_OVERRIDE !== 'true';

        const result = await this.dbManager.query(
            `SELECT c.id, c.clean_domain AS domain
             FROM l7.clients c
             WHERE c.is_forbidden = false
               AND c.has_digits = false
               AND c.is_ip = false
               AND c.clean_domain IS NOT NULL
               AND ($1 = false OR NOT EXISTS (
                   SELECT 1 FROM l7.domains_meta_scan m
                   WHERE m.domain = c.clean_domain
                     AND m.scanned_at::date = CURRENT_DATE
               ))`,
            [skipAlreadyScannedToday]
        );

        this.logger.info(`К обработке: ${result.rows.length} доменов${skipAlreadyScannedToday ? ' (уже отсканированные сегодня пропущены)' : ' (FORCE_OVERRIDE — пересканирую всё)'}`);
        return result.rows;
    }

    urlFor(domain) {
        return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
    }

    async checkForCaptcha(page) {
        try {
            const pageContent = await page.evaluate(() => ({
                title: document.title?.toLowerCase() || '',
                bodyText: document.body?.innerText?.substring(0, 2000)?.toLowerCase() || '',
                url: window.location.href?.toLowerCase() || ''
            }));

            const textToCheck = `${pageContent.title} ${pageContent.bodyText} ${pageContent.url}`;
            const hasKeyword = this.config.captchaKeywords.some(kw => textToCheck.includes(kw.toLowerCase()));
            if (hasKeyword) return true;

            return await page.evaluate(() => {
                const iframes = Array.from(document.querySelectorAll('iframe'));
                return iframes.some(iframe => {
                    const src = (iframe.src || '').toLowerCase();
                    return ['captcha', 'recaptcha', 'hcaptcha', 'turnstile', 'challenge'].some(k => src.includes(k));
                });
            });
        } catch (e) {
            return false;
        }
    }

    async extractMeta(page) {
        return page.evaluate(() => {
            const getMeta = (selector) => {
                const el = document.querySelector(selector);
                return el?.content || el?.getAttribute('content') || '';
            };
            return {
                title: document.title || '',
                description: getMeta('meta[name="description"]') || getMeta('meta[property="og:description"]') || '',
                keywords: getMeta('meta[name="keywords"]') || '',
                ogTitle: getMeta('meta[property="og:title"]') || '',
                ogImage: getMeta('meta[property="og:image"]') || '',
                canonical: document.querySelector('link[rel="canonical"]')?.href || '',
                h1: document.querySelector('h1')?.textContent?.trim() || '',
                robots: getMeta('meta[name="robots"]') || '',
                viewport: getMeta('meta[name="viewport"]') || '',
                charset: document.characterSet || ''
            };
        });
    }

    extractRedirectInfo(response, requestedUrl) {
        if (!response) return { hadRedirect: false, redirectStatus: '', finalUrl: requestedUrl };

        const chain = response.request().redirectChain();
        const finalUrl = response.url();
        if (chain.length === 0) return { hadRedirect: false, redirectStatus: '', finalUrl };

        const redirectStatus = chain.map(req => req.response()?.status()).filter(Boolean).join(' → ');
        return { hadRedirect: true, redirectStatus, finalUrl };
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Заход на страницу + повтор при капче: сперва просто перепроверяем DOM
     * без перезахода (капча иногда сама пропадает), затем один раз перезаходим
     * на страницу. Если не помогло — сдаёмся и помечаем is_captcha=true
     * (на сервере некому решить капчу руками, в отличие от локального скрипта).
     */
    async scrapeOne(client, browser) {
        const url = this.urlFor(client.domain);
        const page = await browser.newPage();

        try {
            await page.setUserAgent(this.config.userAgent);
            if (this.cookies.length > 0) {
                await page.setCookie(...this.cookies);
            }

            let response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.timeout });
            const statusCode = response?.status() || 0;
            const { hadRedirect, redirectStatus, finalUrl } = this.extractRedirectInfo(response, url);

            await this.delay(800);

            let hasCaptcha = await this.checkForCaptcha(page);

            for (let attempt = 0; hasCaptcha && attempt < this.config.captchaMaxRetries; attempt++) {
                if (attempt === 0) {
                    // Сначала просто ждём и перепроверяем без перезахода — капча иногда сама пропадает
                    await this.delay(this.config.captchaRecheckDelayMs);
                } else {
                    // Не помогло — перезаходим на страницу ещё раз
                    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.timeout }).catch(() => response);
                    await this.delay(800);
                }
                hasCaptcha = await this.checkForCaptcha(page);
            }

            if (hasCaptcha) {
                await page.close().catch(() => {});
                return {
                    client_id: client.id, domain: client.domain,
                    status_code: statusCode, had_redirect: hadRedirect, redirect_status: redirectStatus, final_url: finalUrl,
                    title: '', description: '', keywords: '', h1: '', og_title: '', og_image: '',
                    canonical: '', robots: '', viewport: '', charset: '',
                    is_captcha: true, success: false, error_message: 'Капча не снялась после повторных попыток'
                };
            }

            const meta = await this.extractMeta(page);
            await page.close();

            return {
                client_id: client.id, domain: client.domain,
                status_code: statusCode, had_redirect: hadRedirect, redirect_status: redirectStatus, final_url: finalUrl,
                title: meta.title, description: meta.description, keywords: meta.keywords, h1: meta.h1,
                og_title: meta.ogTitle, og_image: meta.ogImage, canonical: meta.canonical,
                robots: meta.robots, viewport: meta.viewport, charset: meta.charset,
                is_captcha: false, success: true, error_message: null
            };
        } catch (error) {
            await page.close().catch(() => {});
            return {
                client_id: client.id, domain: client.domain,
                status_code: 0, had_redirect: false, redirect_status: '', final_url: url,
                title: '', description: '', keywords: '', h1: '', og_title: '', og_image: '',
                canonical: '', robots: '', viewport: '', charset: '',
                is_captcha: false, success: false, error_message: error.message
            };
        }
    }

    chunkArray(arr, size) {
        const chunks = [];
        for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
        return chunks;
    }

    async processAndSaveData(clients) {
        if (!clients || clients.length === 0) {
            this.logger.warn('Нет доменов для обработки');
            return;
        }

        // Один браузер на весь прогон — домены обрабатываются как вкладки (newPage()),
        // а не отдельными процессами Chromium. Запуск браузера — тяжёлая операция,
        // 5 параллельных launch() на VDS с ограниченными ресурсами конкурируют за CPU
        // и работают МЕДЛЕННЕЕ, чем последовательные вкладки в одном браузере.
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
        });

        const batches = this.chunkArray(clients, this.config.parallelLimit);
        let captchaCount = 0;
        let errorCount = 0;

        try {
            for (let i = 0; i < batches.length; i++) {
                const batch = batches[i];
                this.logger.info(`Пакет ${i + 1}/${batches.length} (${batch.length} доменов)`);

                const results = await Promise.all(batch.map(client => this.scrapeOne(client, browser)));

                // Пишем в БД сразу после пачки, а не копим всё до конца прогона —
                // если скрипт упадёт на середине списка, уже собранные данные не потеряются.
                await this.bulkInsertRecords(results);

                this.stats.processed += results.length;
                this.stats.inserted += results.length;
                captchaCount += results.filter(r => r.is_captcha).length;
                errorCount += results.filter(r => !r.success && !r.is_captcha).length;

                if (i < batches.length - 1) {
                    await this.delay(this.config.delayBetweenBatches);
                }
            }
        } finally {
            await browser.close().catch(() => {});
        }

        this.stats.errors += errorCount;
        this.logger.info(`✅ Записано: ${this.stats.inserted} строк (капча: ${captchaCount}, ошибок: ${errorCount})`);
    }

    async bulkInsertRecords(records) {
        const columns = [
            'client_id', 'domain', 'status_code', 'had_redirect', 'redirect_status', 'final_url',
            'title', 'description', 'keywords', 'h1', 'og_title', 'og_image',
            'canonical', 'robots', 'viewport', 'charset', 'is_captcha', 'success', 'error_message'
        ];

        const chunkSize = 500;
        for (let i = 0; i < records.length; i += chunkSize) {
            const chunk = records.slice(i, i + chunkSize);
            const values = [];
            const params = [];
            let idx = 1;

            for (const r of chunk) {
                const rowParams = columns.map(col => r[col]);
                const placeholders = rowParams.map(() => `$${idx++}`);
                values.push(`(${placeholders.join(', ')})`);
                params.push(...rowParams);
            }

            const query = `
                INSERT INTO l7.domains_meta_scan (${columns.join(', ')})
                VALUES ${values.join(',')}
            `;

            await this.dbManager.query(query, params);
        }
    }
}

module.exports = DomainsMetaCollector;
