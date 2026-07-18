/**
 * 结构化日志 + req.id 链路追踪
 *
 * - 基于 pino（生产 JSON 格式 / 开发 pretty）
 * - 兼容旧 API：log.info / warn / error / debug / log 接受可变参数
 * - 通过 AsyncLocalStorage 自动给每条日志附加 req.id
 * - 兼容模式：未安装 pino 时回退到原 console 实现
 *
 * 公共 API:
 *   createLogger(module)              -> 与旧实现完全兼容的 logger
 *   logger.child({ reqId, ... })      -> 子 logger，自动继承父级字段
 *   withRequest({ reqId }, fn)        -> 在 async 作用域中绑定 req.id
 *   getReqId()                        -> 取当前 async 作用域的 reqId
 *   setLevel(level)                   -> 动态调整日志级别
 *   serializeError(err)               -> 通用错误序列化
 */

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

const LEVELS = { TRACE: 10, DEBUG: 20, INFO: 30, WARN: 40, ERROR: 60, FATAL: 70, SILENT: 100 };
const levelNames = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 60: 'ERROR', 70: 'FATAL' };
const MAX_LOG_STRING_CHARS = 8192;
const MAX_LOG_DEPTH = 8;
const SENSITIVE_LOG_KEY =
  /(?:authorization|proxy-authorization|(?:x-)?api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|bearer[-_]?token|cookie|password|passwd|secret|credential)/i;

const _als = new AsyncLocalStorage();

let _pino = null;
let _rootLogger = null;
const _isDev = process.env.NODE_ENV !== 'production' && process.stdout.isTTY;

try {
  _pino = require('pino');
} catch (e) {
  _pino = null;
}

function getRootLogger() {
  if (_rootLogger) return _rootLogger;
  if (_pino) {
    _rootLogger = _pino(
      {
        level: process.env.PROXY_LOG_LEVEL || (_isDev ? 'info' : 'info'),
        base: { app: 'https-proxy-manager', pid: process.pid },
        timestamp: _pino.stdTimeFunctions.isoTime,
        formatters: {
          level: (label) => ({ level: label }),
        },
      },
      _isDev ? _pino.destination({ sync: true }) : process.stdout
    );
  }
  return _rootLogger;
}

function sanitizeLogText(value) {
  let text = String(value == null ? '' : value);
  text = text.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]');
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, '$1[redacted]@');
  text = text.replace(
    /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password)=)[^&#\s]*/gi,
    '$1[redacted]'
  );
  text = text.replace(
    /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password)\s*[:=]\s*['"]?[^&#\s,'"}]+/gi,
    '$1=[redacted]'
  );
  if (text.length > MAX_LOG_STRING_CHARS) {
    return text.slice(0, MAX_LOG_STRING_CHARS) + '...[truncated]';
  }
  return text;
}

function sanitizeLogValue(value, key = '', depth = 0, seen = new WeakSet()) {
  if (SENSITIVE_LOG_KEY.test(String(key || ''))) return '[redacted]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return sanitizeLogText(value);
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    return sanitizeLogText(String(value));
  }
  if (depth >= MAX_LOG_DEPTH) return '[max-depth]';
  if (value instanceof Error) return serializeError(value);
  if (typeof value !== 'object') return sanitizeLogText(String(value));
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item, '', depth + 1, seen));
  }
  const sanitized = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    sanitized[childKey] = sanitizeLogValue(childValue, childKey, depth + 1, seen);
  }
  return sanitized;
}

function sanitizeLogArgs(args) {
  return Array.from(args || [], (value) => sanitizeLogValue(value));
}

function serializeError(err) {
  if (!err) return null;
  if (typeof err === 'string') return { message: sanitizeLogText(err) };
  return {
    type: err.constructor && err.constructor.name,
    message: sanitizeLogText(err.message || ''),
    code: sanitizeLogText(err.code || ''),
    stack: sanitizeLogText(err.stack || ''),
  };
}

// 兼容旧 API 的格式化函数: 把 varargs 转成 pino 可消费的 (obj, msg) 形式
function splitArgs(args) {
  // 约定: 第一个参数如果是纯对象，作为合并字段
  if (
    args.length > 0 &&
    args[0] &&
    typeof args[0] === 'object' &&
    !Array.isArray(args[0]) &&
    !(args[0] instanceof Error) &&
    !(args[0] instanceof Date)
  ) {
    const [first, ...rest] = args;
    return [sanitizeLogValue(first), rest.map(formatVal).join(' ')];
  }
  return [{}, args.map(formatVal).join(' ')];
}

function formatVal(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return sanitizeLogText(v);
  if (v instanceof Error) return sanitizeLogText(v.message);
  try {
    return JSON.stringify(sanitizeLogValue(v));
  } catch (e) {
    return String(v);
  }
}

function buildLogFn(pinoLogger, level) {
  return function logFn(...args) {
    const [obj, msg] = splitArgs(args);
    const reqId = getReqId();
    const merged = reqId ? Object.assign({ reqId }, obj) : obj;
    if (level === 'error' || level === 'fatal') {
      // 尝试提取 err 字段以供 pino 标准序列化
      const err = merged && merged.err;
      if (err instanceof Error) {
        // 让 pino 走自己的 err 序列化器(包含 type=Error.name 等)
        pinoLogger[level](Object.assign({}, merged, { err }), msg);
        return;
      }
    }
    pinoLogger[level](merged, msg);
  };
}

function createLogger(module) {
  if (!_pino) {
    // Fallback to console when pino is missing (shouldn't happen in normal install)
    return {
      module,
      debug: (...a) => console.log(`[${module}]`, ...sanitizeLogArgs(a)),
      info: (...a) => console.log(`[${module}]`, ...sanitizeLogArgs(a)),
      warn: (...a) => console.warn(`[${module}]`, ...sanitizeLogArgs(a)),
      error: (...a) => console.error(`[${module}]`, ...sanitizeLogArgs(a)),
      fatal: (...a) => console.error(`[${module}]`, ...sanitizeLogArgs(a)),
      log: (...a) => console.log(`[${module}]`, ...sanitizeLogArgs(a)),
      child: () => createLogger(module),
    };
  }
  const root = getRootLogger().child({ module });
  return {
    module,
    debug: buildLogFn(root, 'debug'),
    info: buildLogFn(root, 'info'),
    warn: buildLogFn(root, 'warn'),
    error: buildLogFn(root, 'error'),
    fatal: buildLogFn(root, 'fatal'),
    log: buildLogFn(root, 'info'),
    child: (bindings) => createBoundLogger(root.child(bindings || {})),
  };
}

function createBoundLogger(pinoChild) {
  return {
    debug: buildLogFn(pinoChild, 'debug'),
    info: buildLogFn(pinoChild, 'info'),
    warn: buildLogFn(pinoChild, 'warn'),
    error: buildLogFn(pinoChild, 'error'),
    fatal: buildLogFn(pinoChild, 'fatal'),
    log: buildLogFn(pinoChild, 'info'),
    child: (bindings) => createBoundLogger(pinoChild.child(bindings || {})),
  };
}

function newRequestId() {
  return crypto.randomBytes(6).toString('hex');
}

function normalizeRequestId(value) {
  const requestId = Array.isArray(value) ? value[0] : value;
  const normalized = String(requestId == null ? '' : requestId).trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(normalized) ? normalized : newRequestId();
}

function withRequest(context, fn) {
  return _als.run(context || { reqId: newRequestId() }, fn);
}

function getReqId() {
  const store = _als.getStore();
  return store && store.reqId;
}

function setLevel(level) {
  if (_rootLogger && _rootLogger.level !== level) {
    _rootLogger.level = level;
  }
}

function getLevel() {
  return _rootLogger ? _rootLogger.level : 'info';
}

// Middleware-style helper: 给每个 HTTP 请求分配 reqId
function installReqIdMiddleware(server) {
  server.on('request', (req, res) => {
    const headerId = req.headers && (req.headers['x-request-id'] || req.headers['x-req-id']);
    const reqId = normalizeRequestId(headerId);
    req.reqId = reqId;
    res.setHeader('x-request-id', reqId);
  });
}

module.exports = {
  createLogger,
  newRequestId,
  withRequest,
  getReqId,
  setLevel,
  getLevel,
  serializeError,
  sanitizeLogText,
  sanitizeLogValue,
  sanitizeLogArgs,
  normalizeRequestId,
  installReqIdMiddleware,
  LEVELS,
  levelNames,
  _als, // for tests
};
