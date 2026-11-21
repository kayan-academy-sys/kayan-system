// نقطة دخول بديلة للاستضافة بدون عملية دائمة (serverless):
// تشغّل المهام المجدولة بشكل كسول (مرة كل 10 دقائق كحد أقصى مع كل طلب) بدل المؤقت الدائم.
const app = require('./app');
const { migrate } = require('./migrate');
const { runAll } = require('./lib/automation');

let migrated = false;
let lastRun = 0;

module.exports = async (req, res) => {
  if (!migrated) { await migrate(); migrated = true; }
  if (Date.now() - lastRun > 10 * 60 * 1000) {
    lastRun = Date.now();
    runAll().catch(e => console.error('lazy automation failed', e));
  }
  return app(req, res);
};
