const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { parseBoundedInteger } = require('./management-utils');
const { createLogger } = require('./logger');

const safeLog = createLogger('usage');
const USAGE_LOG_FILE = path.join(DATA_DIR, 'usage-stats.jsonl');
const USAGE_LOG_MAX_BYTES = parseBoundedInteger(
  process.env.PROXY_USAGE_MAX_BYTES,
  5 * 1024 * 1024,
  256 * 1024,
  64 * 1024 * 1024
);
const USAGE_FIELD_MAX_CHARS = 512;
const USAGE_TYPE_MAX_CHARS = 64;
const MAX_USAGE_TOKENS = 1000000000;

let usageSummaryCache = {
  signature: '',
  summary: null,
};
const usageWriteQueue = [];
let usageWriting = false;

function fileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch (err) {
    return 'missing';
  }
}

function compactUsageString(value, fallback = 'unknown', maxChars = USAGE_FIELD_MAX_CHARS) {
  const text = String(value == null || value === '' ? fallback : value);
  const limit = parseBoundedInteger(maxChars, USAGE_FIELD_MAX_CHARS, 1, 4096);
  return text.length > limit ? text.slice(0, limit) + '...[truncated]' : text;
}

function usageLogLine(record) {
  return JSON.stringify(record) + '\n';
}

function rotateUsageFileIfNeeded(
  filePath = USAGE_LOG_FILE,
  maxBytes = USAGE_LOG_MAX_BYTES,
  nextBytes = 0
) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (stat.size + Math.max(0, nextBytes) <= maxBytes) return false;
    const rotated = filePath + '.1';
    try {
      fs.unlinkSync(rotated);
    } catch (err) {}
    try {
      fs.renameSync(filePath, rotated);
    } catch (err) {
      fs.writeFileSync(filePath, '', 'utf8');
    }
    return true;
  } catch (err) {}
  return false;
}

function emptyUsageSummary() {
  return { totalInput: 0, totalOutput: 0, totalCachedInput: 0, byProfile: {} };
}

function summarizeUsageLines(lines) {
  const summary = emptyUsageSummary();

  lines.forEach((line) => {
    try {
      const record = JSON.parse(line);
      const profileId = record.profileId || 'unknown';
      const inputTokens = parseBoundedInteger(record.inputTokens, 0, 0, MAX_USAGE_TOKENS);
      const outputTokens = parseBoundedInteger(record.outputTokens, 0, 0, MAX_USAGE_TOKENS);
      const cachedInputTokens = parseBoundedInteger(
        record.cachedInputTokens,
        0,
        0,
        MAX_USAGE_TOKENS
      );
      summary.totalInput += inputTokens;
      summary.totalOutput += outputTokens;
      summary.totalCachedInput += cachedInputTokens;

      if (!summary.byProfile[profileId]) {
        summary.byProfile[profileId] = { input: 0, output: 0, cachedInput: 0, models: {} };
      }
      summary.byProfile[profileId].input += inputTokens;
      summary.byProfile[profileId].output += outputTokens;
      summary.byProfile[profileId].cachedInput += cachedInputTokens;

      const model = record.model || 'unknown';
      if (!summary.byProfile[profileId].models[model]) {
        summary.byProfile[profileId].models[model] = { input: 0, output: 0, cachedInput: 0 };
      }
      summary.byProfile[profileId].models[model].input += inputTokens;
      summary.byProfile[profileId].models[model].output += outputTokens;
      summary.byProfile[profileId].models[model].cachedInput += cachedInputTokens;
    } catch (e) {}
  });

  return summary;
}

async function processUsageQueue() {
  if (usageWriting) return;
  usageWriting = true;
  while (usageWriteQueue.length > 0) {
    const line = usageWriteQueue.shift();
    try {
      await fs.promises.mkdir(path.dirname(USAGE_LOG_FILE), { recursive: true });
      rotateUsageFileIfNeeded(USAGE_LOG_FILE, USAGE_LOG_MAX_BYTES, Buffer.byteLength(line));
      await fs.promises.appendFile(USAGE_LOG_FILE, line);
      usageSummaryCache.signature = '';
    } catch (err) {
      safeLog.warn('Failed to log usage:', err.message);
    }
  }
  usageWriting = false;
}

function normalizeUsageRecord(data = {}) {
  const context = data.context && typeof data.context === 'object' ? data.context : {};
  return {
    time: new Date().toISOString(),
    profileId: compactUsageString(data.profileId),
    model: compactUsageString(data.model),
    inputTokens: parseBoundedInteger(data.inputTokens, 0, 0, MAX_USAGE_TOKENS),
    outputTokens: parseBoundedInteger(data.outputTokens, 0, 0, MAX_USAGE_TOKENS),
    cachedInputTokens: parseBoundedInteger(data.cachedInputTokens, 0, 0, MAX_USAGE_TOKENS),
    contextDiagnostics: context.contextDiagnostics === true,
    contextDroppedCount: parseBoundedInteger(context.contextDroppedCount, 0, 0, MAX_USAGE_TOKENS),
    contextOptimizedCount: parseBoundedInteger(
      context.contextOptimizedCount,
      0,
      0,
      MAX_USAGE_TOKENS
    ),
    contextOverBudgetTokens: parseBoundedInteger(
      context.contextOverBudgetTokens,
      0,
      0,
      MAX_USAGE_TOKENS
    ),
    contextStablePrefixCandidate: context.contextStablePrefixCandidate === true,
    providerCacheCandidate: context.providerCacheCandidate === true,
    providerCacheApplied: context.providerCacheApplied === true,
    contextDiagnosticsMissingReason: compactUsageString(
      data.contextDiagnosticsMissingReason,
      '',
      USAGE_TYPE_MAX_CHARS
    ),
    type: compactUsageString(data.type, 'api', USAGE_TYPE_MAX_CHARS),
  };
}

function logUsage(data = {}) {
  try {
    usageWriteQueue.push(usageLogLine(normalizeUsageRecord(data)));
    processUsageQueue();
    return true;
  } catch (err) {
    safeLog.warn('Failed to enqueue usage:', err.message);
    return false;
  }
}

async function flushUsageWrites() {
  while (usageWriting || usageWriteQueue.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function getUsageSummary() {
  await flushUsageWrites();
  if (!fs.existsSync(USAGE_LOG_FILE)) return emptyUsageSummary();

  const signature = fileSignature(USAGE_LOG_FILE);
  if (usageSummaryCache.signature === signature && usageSummaryCache.summary) {
    return usageSummaryCache.summary;
  }

  const content = fs.readFileSync(USAGE_LOG_FILE, 'utf8');
  const summary = summarizeUsageLines(content.split('\n').filter((l) => l.trim()));
  usageSummaryCache = { signature, summary };
  return summary;
}

module.exports = {
  logUsage,
  getUsageSummary,
  flushUsageWrites,
  _test: {
    summarizeUsageLines,
    compactUsageString,
    normalizeUsageRecord,
    rotateUsageFileIfNeeded,
    usageLogLine,
    flushUsageWrites,
  },
};
