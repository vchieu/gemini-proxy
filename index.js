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
  // H2: bind theo settings.host (mặc định 127.0.0.1 — chỉ loopback). Muốn cho
  // LAN/Wi-Fi truy cập phải set "host": "0.0.0.0" chủ động trong config.json.
  const host = settings.host || '127.0.0.1';
  const server = app.listen(settings.port, host, () => {
    logger.info(`gemini-proxy listening on http://${host}:${settings.port}`);
    logger.info(`Loaded ${enabledKeys}/${keys.length} keys, ${models.length} models, strategy=${settings.strategy}`);
  });
  // Port bị chiếm (instance thứ 2 start khi instance 1 đang chạy) hay lỗi listen khác:
  // log rõ ràng + exit ngay. Không có handler này -> EventEmitter ném 'error' thô
  // (stack trace khó hiểu), và instance 2 sống trùng còn gây EPERM khi 2 process
  // cùng đọc/ghi state.json (xem state/store.js persist).
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${settings.port} đã bị chiếm — đã có instance gemini-proxy khác đang chạy? Dừng instance cũ trước khi start lại.`);
    } else {
      logger.error(`Server listen error: ${err.message}`);
    }
    process.exit(1);
  });
  const shutdown = (sig) => {
    logger.info(`${sig} received, flushing state`);
    stateStore.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Promise Rejection:', { error: reason instanceof Error ? reason.stack || reason.message : String(reason) });
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
