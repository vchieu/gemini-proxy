const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
if (!LEVELS.hasOwnProperty(currentLevel)) currentLevel = 'info';

function setLevel(level) {
  if (LEVELS.hasOwnProperty(level)) currentLevel = level;
}

function shouldLog(level) {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function fmt(level, msg, meta) {
  const ts = new Date().toISOString();
  const extra = meta !== undefined ? ` ${JSON.stringify(meta)}` : '';
  return `[${ts}] [${level.toUpperCase()}] ${msg}${extra}`;
}

const logger = {
  setLevel,
  get level() {
    return currentLevel;
  },
  debug(msg, meta) {
    if (shouldLog('debug')) console.log(fmt('debug', msg, meta));
  },
  info(msg, meta) {
    if (shouldLog('info')) console.log(fmt('info', msg, meta));
  },
  warn(msg, meta) {
    if (shouldLog('warn')) console.warn(fmt('warn', msg, meta));
  },
  error(msg, meta) {
    if (shouldLog('error')) console.error(fmt('error', msg, meta));
  },
};

function createLogger(level) {
  if (level) setLevel(level);
  return logger;
}

module.exports = { logger, createLogger };
