const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { createLogger } = require('./logger');
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
const PRIVATE_DIRECTORY_MODE = 0o700;
const SENSITIVE_AUDIT_KEY =
  /^(?:authorization|proxy-authorization|(?:x-)?api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|bearer[-_]?token|cookie|password|passwd|secret|credential)$/i;

const writeQueue = [];
let writing = false;

async function ensurePrivateAuditFile(filePath) {
  if (process.platform !== 'win32') {
    await fs.promises.chmod(filePath, PRIVATE_FILE_MODE);
  }
}

async function ensurePrivateAuditDirectory(directoryPath) {
  await fs.promises.mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (process.platform !== 'win32') {
    await fs.promises.chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
  }
}

function ensurePrivateAuditFileSync(filePath) {
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, PRIVATE_FILE_MODE);
  }
}

function ensurePrivateAuditDirectorySync(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (process.platform !== 'win32') {
    fs.chmodSync(directoryPath, PRIVATE_DIRECTORY_MODE);
  }
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
  try {
    await fs.promises.unlink(rotated);
  } catch (err) {}
  try {
    await fs.promises.rename(filePath, rotated);
    await ensurePrivateAuditFile(rotated);
  } catch (err) {
    await fs.promises.copyFile(filePath, rotated);
    await ensurePrivateAuditFile(rotated);
    await fs.promises.writeFile(filePath, '', { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    await ensurePrivateAuditFile(filePath);
  }
  return true;
}

async function processAuditQueue() {
  if (writing) return;
  writing = true;
  while (writeQueue.length > 0) {
    const entry = writeQueue.shift();
    try {
      const line = JSON.stringify(entry) + '\n';
      await ensurePrivateAuditDirectory(path.dirname(AUDIT_LOG_FILE));
      await rotateAuditFileIfNeeded(AUDIT_LOG_FILE, AUDIT_LOG_MAX_BYTES, Buffer.byteLength(line));
      await fs.promises.appendFile(AUDIT_LOG_FILE, line, {
        encoding: 'utf8',
        mode: PRIVATE_FILE_MODE,
      });
      await ensurePrivateAuditFile(AUDIT_LOG_FILE);
    } catch (err) {
      safeLog.warn('!! failed to write conversation audit: ' + err.message);
    }
  }
  writing = false;
}

function appendAuditRecord(record) {
  try {
    const entry = {
      time: new Date().toISOString(),
      ...compactAuditValue(record),
    };
    writeQueue.push(entry);
    processAuditQueue();
    return true;
  } catch (err) {
    safeLog.warn('!! failed to enqueue conversation audit: ' + err.message);
    return false;
  }
}

async function flushAuditWrites() {
  while (writing || writeQueue.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

function clearAuditRecords() {
  try {
    writeQueue.length = 0;
    if (fs.existsSync(AUDIT_LOG_FILE)) {
      ensurePrivateAuditDirectorySync(path.dirname(AUDIT_LOG_FILE));
      fs.writeFileSync(AUDIT_LOG_FILE, '', 'utf8');
      ensurePrivateAuditFileSync(AUDIT_LOG_FILE);
    }
    const rotated = AUDIT_LOG_FILE + '.1';
    if (fs.existsSync(rotated)) {
      fs.unlinkSync(rotated);
    }
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
    ensurePrivateAuditDirectorySync,
    ensurePrivateAuditFile,
    ensurePrivateAuditFileSync,
    readAuditRecordsFromFile,
    rotateAuditFileIfNeeded,
  },
};
