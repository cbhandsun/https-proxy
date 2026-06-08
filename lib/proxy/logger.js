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

function serializeError(err) {
  if (!err) return null;
  if (typeof err === 'string') return { message: err };
  return {
    type: err.constructor && err.constructor.name,
    message: err.message,
    code: err.code,
    stack: err.stack,
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
    return [first, rest.map(formatVal).join(' ')];
  }
  return [{}, args.map(formatVal).join(' ')];
}

function formatVal(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.message;
  try {
    return JSON.stringify(v);
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
      debug: (...a) => console.log(`[${module}]`, ...a),
      info: (...a) => console.log(`[${module}]`, ...a),
      warn: (...a) => console.warn(`[${module}]`, ...a),
      error: (...a) => console.error(`[${module}]`, ...a),
      fatal: (...a) => console.error(`[${module}]`, ...a),
      log: (...a) => console.log(`[${module}]`, ...a),
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
    const reqId = headerId || newRequestId();
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
  installReqIdMiddleware,
  LEVELS,
  levelNames,
  _als, // for tests
};
