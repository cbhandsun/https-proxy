'use strict';

const { normalizeCompactionData } = require('../proxy/context-compaction-envelope');
const validNumber = (value) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER;

function createEvidenceGatewayProgressForwarder({ token, send, isActive }) {
  const validToken =
    (typeof token === 'string' &&
      token.length <= 256 &&
      Buffer.from(token, 'utf8').toString('utf8') === token) ||
    (typeof token === 'number' && Number.isSafeInteger(token));
  let attempts = 0;
  let forwarded = 0;
  let failures = 0;
  let lastProgress = -1;
  async function accept(value) {
    if (attempts++ >= 64 || !validToken || !isActive()) return false;
    let progress;
    try {
      progress = normalizeCompactionData(value, 4096);
    } catch {
      return false;
    }
    if (
      !progress ||
      typeof progress !== 'object' ||
      Array.isArray(progress) ||
      !validNumber(progress.progress) ||
      progress.progress <= lastProgress ||
      (progress.total !== undefined &&
        (!validNumber(progress.total) || progress.total < progress.progress))
    )
      return false;
    lastProgress = progress.progress;
    try {
      await send({
        progressToken: token,
        progress: progress.progress,
        ...(progress.total === undefined ? {} : { total: progress.total }),
      });
      forwarded++;
      return true;
    } catch {
      failures++;
      return false;
    }
  }
  return { accept, inspect: () => ({ attempts, forwarded, failures }) };
}

module.exports = { createEvidenceGatewayProgressForwarder };
