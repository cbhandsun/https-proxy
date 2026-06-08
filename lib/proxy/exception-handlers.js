/**
 * 全局异常兜底模块
 *
 * 集中安装:
 *   - uncaughtException  : 记录并尝试优雅退出（仅在严重错误时）
 *   - unhandledRejection : 记录并发出诊断事件
 *   - warning            : 捕获 Node 运行时警告（依赖废弃、内存等）
 *   - beforeExit / exit  : 清理统计
 *
 * 设计目标:
 *   1. 进程不应因单个 Promise reject / 同步异常而崩溃
 *   2. 所有异常都应进入日志和诊断通道
 *   3. 仅在标记为 FATAL 时才触发 graceful shutdown
 *   4. 防止重复安装（幂等）
 */

const { createLogger } = require('./logger');

const log = createLogger('safety');

const FATAL_CODES = new Set([
  'ERR_OUT_OF_MEMORY',
  'ERR_HEAP_ALLOCATION_FAILED',
  'ERR_STACK_OVERFLOW',
  'ERR_PROCESS_EXIT',
]);

const _state = {
  installed: false,
  uncaughtCount: 0,
  rejectionCount: 0,
  warningCount: 0,
  shutdownScheduled: false,
  startedAt: Date.now(),
  lastError: null,
  onShutdown: null, // user-supplied graceful shutdown hook
  onEvent: null, // user-supplied diagnostic event hook (e.g. logProxyEvent)
};

function isFatalError(err) {
  if (!err) return false;
  if (err.code && FATAL_CODES.has(err.code)) return true;
  // Node 16+ tags OOM with this message
  if (
    typeof err.message === 'string' &&
    /out of memory|heap allocation failed|stack overflow/i.test(err.message)
  )
    return true;
  return false;
}

function tryCallHook(hook, ...args) {
  if (typeof hook !== 'function') return;
  try {
    hook(...args);
  } catch (e) {
    /* swallow */
  }
}

function gracefulShutdown(reason) {
  if (_state.shutdownScheduled) return;
  _state.shutdownScheduled = true;
  log.error('[safety] scheduling graceful shutdown, reason:', reason);
  // Give logs a tick to flush, then close
  setImmediate(() => {
    tryCallHook(_state.onShutdown, reason);
    // Hard exit fallback if user hook didn't terminate
    setTimeout(() => {
      log.error('[safety] graceful shutdown did not exit, forcing exit(1)');
      process.exit(1);
    }, 3000).unref();
  });
}

function install(options) {
  if (_state.installed) return;
  _state.installed = true;
  if (options && typeof options.onShutdown === 'function') {
    _state.onShutdown = options.onShutdown;
  }
  if (options && typeof options.onEvent === 'function') {
    _state.onEvent = options.onEvent;
  }

  process.on('uncaughtException', (err, origin) => {
    _state.uncaughtCount += 1;
    _state.lastError = {
      type: 'uncaughtException',
      message: err && err.message,
      stack: err && err.stack,
      at: Date.now(),
    };
    log.error('[uncaughtException]', err && err.stack ? err.stack : err);
    log.error('[uncaughtException] origin:', origin);
    tryCallHook(_state.onEvent, 'uncaught_exception', {
      error: err && err.message,
      stack: err && err.stack,
      origin: String(origin || 'unknown'),
    });
    if (isFatalError(err)) {
      gracefulShutdown('uncaughtException fatal: ' + ((err && err.code) || (err && err.message)));
    }
  });

  process.on('unhandledRejection', (reason) => {
    _state.rejectionCount += 1;
    const err = reason instanceof Error ? reason : new Error(String(reason));
    _state.lastError = {
      type: 'unhandledRejection',
      message: err.message,
      stack: err.stack,
      at: Date.now(),
    };
    log.error('[unhandledRejection]', err && err.stack ? err.stack : err);
    tryCallHook(_state.onEvent, 'unhandled_rejection', {
      reason: err.message,
      stack: err.stack,
    });
    if (isFatalError(reason)) {
      gracefulShutdown('unhandledRejection fatal: ' + err.message);
    }
  });

  process.on('warning', (warning) => {
    _state.warningCount += 1;
    // Deprecation warnings can be very chatty; trim to one line.
    const name = warning && warning.name ? warning.name : 'Warning';
    const msg = warning && warning.message ? warning.message : String(warning);
    log.warn(`[${name}] ${msg}`);
    tryCallHook(_state.onEvent, 'process_warning', { name, message: msg });
  });

  process.on('beforeExit', (code) => {
    log.info(
      `[lifecycle] beforeExit code=${code} uncaught=${_state.uncaughtCount} rejection=${_state.rejectionCount} warning=${_state.warningCount}`
    );
  });
}

function getStats() {
  return {
    installed: _state.installed,
    uncaughtCount: _state.uncaughtCount,
    rejectionCount: _state.rejectionCount,
    warningCount: _state.warningCount,
    shutdownScheduled: _state.shutdownScheduled,
    uptimeMs: Date.now() - _state.startedAt,
    lastError: _state.lastError,
  };
}

function setShutdownHook(hook) {
  if (typeof hook === 'function') _state.onShutdown = hook;
}

function setEventHook(hook) {
  if (typeof hook === 'function') _state.onEvent = hook;
}

function reset() {
  // For tests only - clears counters but keeps listeners in place
  _state.uncaughtCount = 0;
  _state.rejectionCount = 0;
  _state.warningCount = 0;
  _state.shutdownScheduled = false;
  _state.lastError = null;
  _state.startedAt = Date.now();
}

module.exports = {
  install,
  setShutdownHook,
  setEventHook,
  getStats,
  reset,
  isFatalError,
};
