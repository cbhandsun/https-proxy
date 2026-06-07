/**
 * Minimal structured logger for HTTPS Proxy Manager.
 * Keeps zero dependencies — wraps console with timestamp + level + module tags.
 */
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const levelNames = Object.keys(LEVELS);

function currentLevel() {
  const env = process.env.PROXY_LOG_LEVEL;
  return (env && LEVELS[env.toUpperCase()] !== undefined) ? LEVELS[env.toUpperCase()] : LEVELS.INFO;
}

function timestamp() {
  return new Date().toISOString();
}

function formatArgs(module, level, args) {
  const ts = timestamp();
  const prefix = `[${ts}] [${level}] [${module}]`;
  return [prefix, ...args];
}

function createLogger(module) {
  function log(level, ...args) {
    if (LEVELS[level] < currentLevel()) return;
    const formatted = formatArgs(module, level, args);
    switch (level) {
      case 'ERROR': console.error(...formatted); break;
      case 'WARN':  console.warn(...formatted); break;
      default:      console.log(...formatted); break;
    }
  }

  return {
    debug: (...args) => log('DEBUG', ...args),
    info:  (...args) => log('INFO', ...args),
    warn:  (...args) => log('WARN', ...args),
    error: (...args) => log('ERROR', ...args),
    // passthrough for backwards compat with (format, ...args) callers
    log:   (...args) => log('INFO', ...args),
  };
}

createLogger.LEVELS = LEVELS;

module.exports = { createLogger };
