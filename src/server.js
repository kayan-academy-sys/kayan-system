const app = require('./app');
const config = require('./config');
const { migrate } = require('./migrate');
const automation = require('./lib/automation');

(async () => {
  await migrate();
  app.listen(config.port, () => console.log(`Kayan system on port ${config.port}`));
  if (config.runCron) automation.startScheduler();
})().catch(e => { console.error(e); process.exit(1); });
