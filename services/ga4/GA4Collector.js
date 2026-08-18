const GoogleBaseCollector = require('../../core/GoogleBaseCollector');
const config = require('./config.json');
const axios = require('axios');

class GA4Collector extends GoogleBaseCollector {
  constructor() {
    super('ga4');
    this.config = config;
    this.propertyId = process.env.GA4_PROPERTY_ID;
    this.apiUrl = process.env.GA4_API_URL || 'https://analyticsdata.googleapis.com';
  }

  /**
   * Проверка подключения к GA4 Data API
   */
  async checkApiConnection() {
    this.logger.info('Проверка подключения к Google Analytics 4 Data API');

    if (!this.propertyId) {
      throw new Error('GA4_PROPERTY_ID не задан в .env');
    }

    try {
      const headers = await this.authManager.getAuthHeaders();
      await axios.post(
        `${this.apiUrl}/${this.config.apiVersion}/properties/${this.propertyId}:runReport`,
        {
          dateRanges: [{ startDate: 'yesterday', endDate: 'yesterday' }],
          dimensions: [{ name: 'date' }],
          metrics: [{ name: 'eventCount' }],
          limit: 1
        },
        { headers, timeout: 10000 }
      );

      this.logger.info('GA4 Data API подключение успешно');
      return true;
    } catch (error) {
      if (error.response) {
        this.logger.error(`GA4 API Error: ${error.response.status}`, null, { data: error.response.data });
      }
      this.logger.error('Ошибка подключения к GA4 Data API', error);
      throw new Error(`GA4 Data API недоступен: ${error.message}`);
    }
  }

  /**
   * Получение данных из GA4 Data API
   * Этот метод вызывается из BaseCollector.run() после подключения к БД
   */
  async fetchData(startDate, endDate) {
    try {
      this.logger.info(`Получение данных Web Vitals GA4 за период: ${startDate} - ${endDate}`);

      const rows = await this.fetchWebVitals(startDate, endDate);

      if (!rows || rows.length === 0) {
        this.logger.warn('Нет данных Web Vitals из GA4 API');
        return [];
      }

      this.logger.info(`Получено строк из GA4 API: ${rows.length}`);

      const records = this.transformData(rows);

      this.logger.info(`Подготовлено записей для сохранения: ${records.length}`);

      return records;

    } catch (error) {
      this.logger.error(`Ошибка получения данных GA4: ${error.message}`, error);
      throw error;
    }
  }

  /**
   * Запрос отчёта Web Vitals из GA4 Data API (runReport) с пагинацией
   */
  async fetchWebVitals(startDate, endDate) {
    const url = `${this.apiUrl}/${this.config.apiVersion}/properties/${this.propertyId}:runReport`;
    const { eventNames, dimensions, metrics } = this.config.webVitals;
    const pageSize = this.config.batchSize;

    const allRows = [];
    let offset = 0;

    try {
      while (true) {
        const requestBody = {
          dateRanges: [{ startDate, endDate }],
          dimensions,
          metrics,
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              inListFilter: { values: eventNames }
            }
          },
          limit: pageSize,
          offset
        };

        this.logger.info(`Запрос к GA4 API (offset=${offset})`);

        const headers = await this.authManager.getAuthHeaders();

        const response = await axios.post(url, requestBody, {
          headers,
          timeout: this.config.requestTimeout
        });

        const rows = response.data?.rows || [];
        this.logger.info(`Ответ получен. Строк: ${rows.length}`);

        allRows.push(...rows);

        if (rows.length < pageSize) {
          break;
        }

        offset += pageSize;
      }

      return allRows;

    } catch (error) {
      if (error.response) {
        this.logger.error(`GA4 API Error: ${error.response.status}`, null, { data: error.response.data });
      }
      throw error;
    }
  }

  /**
   * Трансформация строк GA4 API (date, pagePath, customEvent:metric_name / eventCount, customEvent:metric_value)
   * в формат для БД
   */
  transformData(rows) {
    const records = [];

    for (const row of rows) {
      const [rawDate, pagePath, metricName] = row.dimensionValues.map(v => v.value);
      const [eventCount, metricValueSum] = row.metricValues.map(v => Number(v.value));

      const eventDate = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;

      records.push({
        event_date: eventDate,
        metric_name: metricName,
        page_path: pagePath,
        event_count: eventCount,
        metric_value: eventCount > 0 ? metricValueSum / eventCount : 0
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
        `SELECT 1 FROM ga4.web_vitals
         WHERE event_date = $1 AND metric_name = $2 AND page_path = $3`,
        [record.event_date, record.metric_name, record.page_path]
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
      `INSERT INTO ga4.web_vitals
       (event_date, metric_name, page_path, event_count, metric_value)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        record.event_date,
        record.metric_name,
        record.page_path,
        record.event_count,
        record.metric_value
      ]
    );
  }

  /**
   * Обновление существующей записи
   */
  async updateRecord(record) {
    await this.dbManager.query(
      `UPDATE ga4.web_vitals
       SET event_count = $4, metric_value = $5, updated_at = CURRENT_TIMESTAMP
       WHERE event_date = $1 AND metric_name = $2 AND page_path = $3`,
      [
        record.event_date,
        record.metric_name,
        record.page_path,
        record.event_count,
        record.metric_value
      ]
    );
  }

  /**
   * Получение ключа записи для логирования
   */
  getRecordKey(record) {
    return `${record.event_date}|${record.metric_name}|${record.page_path}`;
  }

  /**
   * Статистика по собранным данным
   */
  async getStats(startDate, endDate) {
    try {
      const result = await this.dbManager.query(
        `SELECT
          COUNT(*) as total_records,
          COUNT(DISTINCT metric_name) as unique_metrics,
          COUNT(DISTINCT page_path) as unique_pages,
          SUM(event_count) as total_events,
          MIN(event_date) as first_date,
          MAX(event_date) as last_date
         FROM ga4.web_vitals
         WHERE event_date BETWEEN $1 AND $2`,
        [startDate, endDate]
      );

      return {
        service: 'ga4',
        period: { startDate, endDate },
        ...result.rows[0]
      };
    } catch (error) {
      this.logger.error('Ошибка получения статистики', error);
      return {
        service: 'ga4',
        period: { startDate, endDate },
        total_records: 0
      };
    }
  }
}

module.exports = GA4Collector;
