require('dotenv').config();
const GSCCollector = require('../services/gsc/GSCCollector');

async function testDateLogic() {
  const collector = new GSCCollector();
  
  console.log('=== ТЕСТ ЛОГИКИ ДАТ GSC ===\n');
  
  // Симулируем что run-service передает "вчера"
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 5);
  const yesterdayStr = yesterday.toISOString().split('T')[0];
  
  console.log(`Сегодня: ${new Date().toISOString().split('T')[0]}`);
  console.log(`run-service передает: ${yesterdayStr} (свежая дата GSC)`);
  
  const dates = {
    startDate: yesterdayStr,
    endDate: yesterdayStr
  };
  
  // Коллектор сам скорректирует даты
  try {
    const result = await collector.run(dates);
    console.log('\n✓ Результат:', result);
    process.exit(0);
  } catch (error) {
    console.error('\n✗ Ошибка:', error.message);
    process.exit(1);
  }
}

testDateLogic();