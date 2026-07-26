const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { createLogger } = require('./logger');
const {
  parseBoundedInteger,
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

const writeQueue = [];
let writing = false;

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
  } catch (err) {
    await fs.promises.copyFile(filePath, rotated);
    await fs.promises.writeFile(filePath, '');
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
      await fs.promises.mkdir(path.dirname(AUDIT_LOG_FILE), { recursive: true });
      await rotateAuditFileIfNeeded(AUDIT_LOG_FILE, AUDIT_LOG_MAX_BYTES, Buffer.byteLength(line));
      await fs.promises.appendFile(AUDIT_LOG_FILE, line);
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
      fs.writeFileSync(AUDIT_LOG_FILE, '', 'utf8');
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
    readAuditRecordsFromFile,
    rotateAuditFileIfNeeded,
  },
};
