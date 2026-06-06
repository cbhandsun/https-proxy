const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const AUDIT_LOG_FILE = path.join(DATA_DIR, 'conversations-audit.jsonl');
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = Math.max(1024, Number(process.env.PROXY_AUDIT_MAX_TEXT_CHARS || 120000));

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
    result[key] = compactAuditValue(item, depth + 1);
  }
  return result;
}

async function rotateAuditFileIfNeeded() {
  try {
    const stats = await fs.promises.stat(AUDIT_LOG_FILE);
    if (stats.size <= MAX_FILE_SIZE) return;
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }

  const rotated = AUDIT_LOG_FILE + '.1';
  try { await fs.promises.unlink(rotated); } catch (err) {}
  try {
    await fs.promises.rename(AUDIT_LOG_FILE, rotated);
  } catch (err) {
    await fs.promises.copyFile(AUDIT_LOG_FILE, rotated);
    await fs.promises.writeFile(AUDIT_LOG_FILE, '');
  }
}

async function processAuditQueue() {
  if (writing) return;
  writing = true;
  while (writeQueue.length > 0) {
    const entry = writeQueue.shift();
    try {
      await rotateAuditFileIfNeeded();
      await fs.promises.appendFile(AUDIT_LOG_FILE, JSON.stringify(entry) + '\n');
    } catch (err) {
      console.warn('!! failed to write conversation audit: ' + err.message);
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
    console.warn('!! failed to enqueue conversation audit: ' + err.message);
    return false;
  }
}

async function flushAuditWrites() {
  while (writing || writeQueue.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function readLastLinesOfJsonl(filePath, maxLines, maxBytes = 512 * 1024) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return [];

    const fd = fs.openSync(filePath, 'r');
    const bufferSize = Math.min(stat.size, Math.max(8 * 1024, maxBytes));
    const buffer = Buffer.alloc(bufferSize);
    fs.readSync(fd, buffer, 0, bufferSize, stat.size - bufferSize);
    fs.closeSync(fd);

    const lines = buffer.toString('utf8').split('\n').filter((line) => line.trim());
    const records = [];
    const startIdx = Math.max(0, lines.length - maxLines);
    for (let i = lines.length - 1; i >= startIdx; i--) {
      try {
        records.push(JSON.parse(lines[i]));
      } catch (e) {}
    }
    return records;
  } catch (err) {
    console.error('!! failed to read conversation audit:', err.message);
    return [];
  }
}

function getAuditRecords(limit = 50) {
  try {
    const safeLimit = Math.min(500, Math.max(1, Number(limit || 50)));
    return readLastLinesOfJsonl(AUDIT_LOG_FILE, safeLimit);
  } catch (err) {
    console.error('!! failed to read conversation audit:', err.message);
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
    console.error('!! failed to clear conversation audit:', err.message);
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
};
