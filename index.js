const path = require('path');
const { loadConfig } = require('./config/loader');
const { StateStore } = require('./state/store');
const { createServer } = require('./api/server');
const { createLogger } = require('./utils/logger');

function main() {
  const configDir = process.env.CONFIG_DIR || path.join(__dirname, 'config');
  const { keys, models, settings } = loadConfig(configDir);

  const logger = createLogger(settings.log_level);
  const statePath = path.isAbsolute(settings.state_file)
    ? settings.state_file
    : path.join(__dirname, settings.state_file);

  const stateStore = new StateStore(statePath);
  const app = createServer({ models, keys, stateStore, config: settings });

  const enabledKeys = keys.filter((k) => k.enabled !== false).length;
  app.listen(settings.port, () => {
    logger.info(`gemini-proxy listening on http://localhost:${settings.port}`);
    logger.info(`Loaded ${enabledKeys}/${keys.length} keys, ${models.length} models, strategy=${settings.strategy}`);
  });
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`[fatal] ${e.message}`);
    process.exit(1);
  }
}

module.exports = { main };
