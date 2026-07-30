const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { createLogger } = require('./logger');
const { ensurePrivateDirectorySync, ensurePrivateFileSync } = require('./secure-files');
const {
  parseBoundedInteger,
  PRIVATE_FILE_MODE,
  readLastLinesOfJsonl: readSharedLastLinesOfJsonl,
} = require('./management-utils');

const safeLog = createLogger('audit');
const AUDIT_LOG_FILE = path.join(DATA_DIR, 'conversations-audit.jsonl');
const AUDIT_LOG_MAX_BYTES = parseBoundedInteger(
  process.env.PROXY_AUDIT_MAX_BYTES,
  10 * 1024 * 1024,
  256 * 1024,
  128 * 1024 * 1024
);
const MAX_TEXT_CHARS = parseBoundedInteger(
  process.env.PROXY_AUDIT_MAX_TEXT_CHARS,
  120000,
  1024,
  1024 * 1024
);
const SENSITIVE_AUDIT_KEY =
  /^(?:authorization|proxy-authorization|(?:x-)?api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|bearer[-_]?token|cookie|password|passwd|secret|credential)$/i;

let operationTail = Promise.resolve();
let pendingOperations = 0;
const securedAuditDirectories = new Set();
const securedAuditFiles = new Set();

async function ensurePrivateAuditFile(filePath) {
  ensurePrivateFileSync(filePath);
}

async function ensurePrivateAuditDirectory(directoryPath) {
  ensurePrivateDirectorySync(directoryPath);
}

async function ensurePrivateAuditDirectoryOnce(directoryPath) {
  const resolved = path.resolve(directoryPath);
  if (securedAuditDirectories.has(resolved)) return;
  await ensurePrivateAuditDirectory(resolved);
  securedAuditDirectories.add(resolved);
}

async function ensurePrivateAuditFileOnce(filePath) {
  const resolved = path.resolve(filePath);
  if (securedAuditFiles.has(resolved)) return;
  await ensurePrivateAuditFile(resolved);
  securedAuditFiles.add(resolved);
}

function ensurePrivateAuditFileSync(filePath) {
  ensurePrivateFileSync(filePath);
}

function ensurePrivateAuditDirectorySync(directoryPath) {
  ensurePrivateDirectorySync(directoryPath);
}

function compactAuditValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (value.length <= MAX_TEXT_CHARS) return value;
    return value.slice(0, MAX_TEXT_CHARS) + '...[truncated]';
  }
  if (typeof value !== 'object') return value;
  if (depth > 8) return '[max-depth]';
  if (Array.isArray(value)) return value.map((item) => compactAuditValue(item, depth + 1));

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_AUDIT_KEY.test(key) ? '[redacted]' : compactAuditValue(item, depth + 1);
  }
  return result;
}

async function rotateAuditFileIfNeeded(
  filePath = AUDIT_LOG_FILE,
  maxBytes = AUDIT_LOG_MAX_BYTES,
  nextBytes = 0
) {
  try {
    const stats = await fs.promises.stat(filePath);
    if (stats.size + Math.max(0, nextBytes) <= maxBytes) return false;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }

  const rotated = filePath + '.1';
  securedAuditFiles.delete(path.resolve(filePath));
  securedAuditFiles.delete(path.resolve(rotated));
  try {
    await fs.promises.unlink(rotated);
  } catch (err) {}
  try {
    await fs.promises.rename(filePath, rotated);
    await ensurePrivateAuditFileOnce(rotated);
  } catch (err) {
    await fs.promises.copyFile(filePath, rotated);
    await ensurePrivateAuditFileOnce(rotated);
    await fs.promises.writeFile(filePath, '', { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    await ensurePrivateAuditFileOnce(filePath);
  }
  return true;
}

function enqueueAuditOperation(operation) {
  pendingOperations += 1;
  const result = operationTail.then(operation);
  operationTail = result
    .catch(() => {})
    .finally(() => {
      pendingOperations = Math.max(0, pendingOperations - 1);
    });
  return result;
}

async function writeAuditEntry(entry) {
  const line = JSON.stringify(entry) + '\n';
  await ensurePrivateAuditDirectoryOnce(path.dirname(AUDIT_LOG_FILE));
  await rotateAuditFileIfNeeded(AUDIT_LOG_FILE, AUDIT_LOG_MAX_BYTES, Buffer.byteLength(line));
  const existed = fs.existsSync(AUDIT_LOG_FILE);
  await fs.promises.appendFile(AUDIT_LOG_FILE, line, {
    encoding: 'utf8',
    mode: PRIVATE_FILE_MODE,
  });
  if (!existed) securedAuditFiles.delete(path.resolve(AUDIT_LOG_FILE));
  await ensurePrivateAuditFileOnce(AUDIT_LOG_FILE);
}

function appendAuditRecord(record) {
  try {
    const entry = {
      time: new Date().toISOString(),
      ...compactAuditValue(record),
    };
    enqueueAuditOperation(() => writeAuditEntry(entry)).catch((err) => {
      safeLog.warn('!! failed to write conversation audit: ' + err.message);
    });
    return true;
  } catch (err) {
    safeLog.warn('!! failed to enqueue conversation audit: ' + err.message);
    return false;
  }
}

async function flushAuditWrites() {
  await operationTail;
}

function readAuditRecordsFromFile(filePath, maxLines, maxBytes = 512 * 1024) {
  return readSharedLastLinesOfJsonl(filePath, maxLines, maxBytes).reverse();
}

function getAuditRecords(limit = 50) {
  try {
    const safeLimit = parseBoundedInteger(limit, 50, 1, 500);
    return readAuditRecordsFromFile(AUDIT_LOG_FILE, safeLimit);
  } catch (err) {
    safeLog.error('!! failed to read conversation audit:', err.message);
    return [];
  }
}

function getAuditRecordById(id, limit = 500) {
  const targetId = String(id || '').trim();
  if (!targetId) return null;
  return getAuditRecords(limit).find((record) => String(record.id || '') === targetId) || null;
}

async function clearAuditRecords() {
  try {
    await enqueueAuditOperation(async () => {
      ensurePrivateAuditDirectorySync(path.dirname(AUDIT_LOG_FILE));
      securedAuditDirectories.add(path.resolve(path.dirname(AUDIT_LOG_FILE)));
      if (fs.existsSync(AUDIT_LOG_FILE)) {
        fs.writeFileSync(AUDIT_LOG_FILE, '', { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
        ensurePrivateAuditFileSync(AUDIT_LOG_FILE);
        securedAuditFiles.add(path.resolve(AUDIT_LOG_FILE));
      }
      const rotated = AUDIT_LOG_FILE + '.1';
      if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
      securedAuditFiles.delete(path.resolve(rotated));
    });
    return true;
  } catch (err) {
    safeLog.error('!! failed to clear conversation audit:', err.message);
    return false;
  }
}

module.exports = {
  AUDIT_LOG_FILE,
  appendAuditRecord,
  flushAuditWrites,
  getAuditRecords,
  getAuditRecordById,
  clearAuditRecords,
  _test: {
    compactAuditValue,
    ensurePrivateAuditDirectory,
    ensurePrivateAuditDirectoryOnce,
    ensurePrivateAuditDirectorySync,
    ensurePrivateAuditFile,
    ensurePrivateAuditFileOnce,
    ensurePrivateAuditFileSync,
    enqueueAuditOperation,
    getPendingOperationCount: () => pendingOperations,
    resetSecuredPathCache() {
      securedAuditDirectories.clear();
      securedAuditFiles.clear();
    },
    readAuditRecordsFromFile,
    rotateAuditFileIfNeeded,
  },
};
