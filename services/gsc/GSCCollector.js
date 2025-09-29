const GoogleBaseCollector = require('../../core/GoogleBaseCollector');
const config = require('./config');
const axios = require('axios');

class GSCCollector extends GoogleBaseCollector {
  constructor() {
    super('gsc');
    this.config = config;
  }

  /**
   * Проверка подключения к GSC API
   */
  async checkApiConnection() {
    this.logger.info('Проверка подключения к Google Search Console API');
    
    try {
      // Простая проверка - запрос списка сайтов
      const headers = await this.authManager.getAuthHeaders();
      const response = await axios.get(
        'https://www.googleapis.com/webmasters/v3/sites',
        { headers, timeout: 10000 }
      );
      
      this.logger.info('GSC API подключение успешно');
      return true;
    } catch (error) {
      this.logger.error('Ошибка подключения к GSC API', error);
      throw new Error(`GSC API недоступен: ${error.message}`);
    }
  }

  /**
   * Получение данных из GSC API
   * Этот метод вызывается из BaseCollector.run() после подключения к БД
   */
  async fetchData(startDate, endDate) {
    try {
      // Используем даты как есть - run-service уже применил нужное смещение
      this.logger.info(`Получение данных GSC за период: ${startDate} - ${endDate}`);

      // 1. Запрос данных из API
      const searchData = await this.fetchSearchAnalytics(startDate, endDate);
      
      if (!searchData || !searchData.rows || searchData.rows.length === 0) {
        this.logger.warn('Нет данных из GSC API');
        return [];
      }

      this.logger.info(`Получено строк из GSC API: ${searchData.rows.length}`);

      // 2. Нормализация URL через common.site_map
      const urlMapping = await this.normalizeUrls(searchData.rows);
      
      // 3. Трансформация данных в формат для сохранения
      const records = this.transformData(searchData.rows, urlMapping);

      this.logger.info(`Подготовлено записей для сохранения: ${records.length}`);
      
      return records;

    } catch (error) {
      this.logger.error(`Ошибка получения данных GSC: ${error.message}`, error);
      throw error;
    }
  }

  /**
   * Запрос данных из Google Search Console API
   */
  async fetchSearchAnalytics(startDate, endDate) {
    try {
      const url = `${this.config.apiEndpoint}/sites/${this.config.siteUrl}/searchAnalytics/query`;
      
      const requestBody = {
        startDate,
        endDate,
        type: this.config.requestParams.type,
        dataState: this.config.requestParams.dataState,
        dimensions: this.config.requestParams.dimensions,
        rowLimit: this.config.maxRows
      };

      this.logger.info(`Запрос к GSC API`);
      
      const headers = await this.authManager.getAuthHeaders();
      
      const response = await axios.post(url, requestBody, {
        headers,
        timeout: this.config.requestTimeout
      });

      this.logger.info(`Ответ получен. Строк: ${response.data?.rows?.length || 0}`);
      
      return response.data;

    } catch (error) {
      if (error.response) {
        this.logger.error(`GSC API Error: ${error.response.status}`, error.response.data);
      }
      throw error;
    }
  }

  /**
   * Нормализация URL через справочник common.site_map
   */
  async normalizeUrls(rows) {
    try {
      // Извлекаем уникальные URL из keys[2]
      const uniqueUrls = [...new Set(rows.map(row => row.keys[2]))];
      
      this.logger.info(`Найдено уникальных URL: ${uniqueUrls.length}`);

      const urlMapping = {};

      // Batch upsert для всех URL
      for (const url of uniqueUrls) {
        const result = await this.dbManager.query(
          `INSERT INTO common.site_map (url) 
           VALUES ($1) 
           ON CONFLICT (url) DO UPDATE SET url = EXCLUDED.url
           RETURNING id, url`,
          [url]
        );
        
        urlMapping[url] = result.rows[0].id;
      }

      this.logger.info(`URL нормализованы: ${Object.keys(urlMapping).length} записей`);
      
      return urlMapping;

    } catch (error) {
      this.logger.error(`Ошибка нормализации URL: ${error.message}`, error);
      throw error;
    }
  }

  /**
   * Трансформация данных API в формат для БД
   */
  transformData(rows, urlMapping) {
    const records = [];

    for (const row of rows) {
      const [date, query, pageUrl] = row.keys;
      const targetUrlId = urlMapping[pageUrl];

      if (!targetUrlId) {
        this.logger.warn(`⚠️ URL не найден в mapping: ${pageUrl}`);
        continue;
      }

      records.push({
        event_date: date,
        request: query,
        target_url: targetUrlId,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position
      });
    }

    return records;
  }

  /**
   * Проверка существования записи
   */
  async recordExists(record) {
    try {
      const result = await this.dbManager.query(
        `SELECT 1 FROM gsc.search_console 
         WHERE event_date = $1 AND request = $2 AND target_url = $3`,
        [record.event_date, record.request, record.target_url]
      );
      return result.rows.length > 0;
    } catch (error) {
      this.logger.error('Ошибка проверки существования записи', error);
      return false;
    }
  }

  /**
   * Вставка новой записи
   */
  async insertRecord(record) {
    await this.dbManager.query(
      `INSERT INTO gsc.search_console 
       (event_date, request, target_url, clicks, impressions, ctr, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        record.event_date,
        record.request,
        record.target_url,
        record.clicks,
        record.impressions,
        record.ctr,
        record.position
      ]
    );
  }

  /**
   * Обновление существующей записи
   */
  async updateRecord(record) {
    await this.dbManager.query(
      `UPDATE gsc.search_console 
       SET clicks = $4, impressions = $5, ctr = $6, position = $7, updated_at = CURRENT_TIMESTAMP
       WHERE event_date = $1 AND request = $2 AND target_url = $3`,
      [
        record.event_date,
        record.request,
        record.target_url,
        record.clicks,
        record.impressions,
        record.ctr,
        record.position
      ]
    );
  }

  /**
   * Получение ключа записи для логирования
   */
  getRecordKey(record) {
    return `${record.event_date}|${record.request}|${record.target_url}`;
  }

  /**
   * Статистика по собранным данным
   */
  async getStats(startDate, endDate) {
    try {
      const result = await this.dbManager.query(
        `SELECT 
          COUNT(*) as total_records,
          COUNT(DISTINCT request) as unique_queries,
          COUNT(DISTINCT target_url) as unique_urls,
          SUM(clicks) as total_clicks,
          SUM(impressions) as total_impressions,
          MIN(event_date) as first_date,
          MAX(event_date) as last_date
         FROM gsc.search_console
         WHERE event_date BETWEEN $1 AND $2`,
        [startDate, endDate]
      );

      return {
        service: 'gsc',
        period: { startDate, endDate },
        ...result.rows[0]
      };
    } catch (error) {
      this.logger.error('Ошибка получения статистики', error);
      return {
        service: 'gsc',
        period: { startDate, endDate },
        total_records: 0
      };
    }
  }
}

module.exports = GSCCollector;