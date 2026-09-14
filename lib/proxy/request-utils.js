const zlib = require('zlib');

const { estimateTokensForValue } = require('./inline-media');

const DEFAULT_MAX_DECOMPRESSED_BODY_BYTES = 32 * 1024 * 1024;

function normalizeByteLimit(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  const fallbackNumber = Number(fallback);
  const safeFallback = Number.isFinite(fallbackNumber)
    ? Math.min(max, Math.max(min, Math.trunc(fallbackNumber)))
    : min;
  if (!Number.isFinite(parsed)) return safeFallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function pathForLogging(value) {
  const path = typeof value === 'string' ? value : '';
  const queryIndex = path.indexOf('?');
  const fragmentIndex = path.indexOf('#');
  const indexes = [queryIndex, fragmentIndex].filter((index) => index >= 0);
  const end = indexes.length > 0 ? Math.min(...indexes) : path.length;
  return path.slice(0, end) || '/';
}

function decodeBodyBuffer(buffer, encoding, options = {}) {
  const maxOutputLength = normalizeByteLimit(
    options.maxOutputLength,
    DEFAULT_MAX_DECOMPRESSED_BODY_BYTES,
    1,
    256 * 1024 * 1024
  );
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buffer, { maxOutputLength }).toString('utf8');
    if (encoding === 'deflate')
      return zlib.inflateSync(buffer, { maxOutputLength }).toString('utf8');
    if (encoding === 'br')
      return zlib.brotliDecompressSync(buffer, { maxOutputLength }).toString('utf8');
  } catch (err) {
    return buffer.toString('utf8');
  }
  return buffer.toString('utf8');
}

function extractJsonField(body, field) {
  try {
    const parsed = JSON.parse(body);
    return parsed && parsed[field] ? String(parsed[field]) : '-';
  } catch (err) {
    return '-';
  }
}

function estimateTokens(value) {
  return estimateTokensForValue(value);
}

function inspectContentLength(headers, limit) {
  const safeLimit = normalizeByteLimit(limit, 0, 0, 1024 * 1024 * 1024);
  if (!headers || typeof headers !== 'object') {
    return { present: false, valid: true, exceeds: false, value: 0, limit: safeLimit };
  }
  let rawValue;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'content-length') {
      rawValue = value;
      break;
    }
  }
  if (rawValue == null || rawValue === '') {
    return { present: false, valid: true, exceeds: false, value: 0, limit: safeLimit };
  }
  if (Array.isArray(rawValue) || !/^\d+$/.test(String(rawValue))) {
    return { present: true, valid: false, exceeds: false, value: 0, limit: safeLimit };
  }
  try {
    const parsed = BigInt(String(rawValue));
    const exceeds = parsed > BigInt(safeLimit);
    const value =
      parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : Number.MAX_SAFE_INTEGER;
    return { present: true, valid: true, exceeds, value, limit: safeLimit };
  } catch (error) {
    return { present: true, valid: false, exceeds: false, value: 0, limit: safeLimit };
  }
}

function collectLimitedRequestBody(req, options) {
  const limit = normalizeByteLimit(options && options.limit, 0, 0, 1024 * 1024 * 1024);
  const onTooLarge = options && options.onTooLarge;
  const onComplete = options && options.onComplete;
  const onAborted = options && options.onAborted;
  const chunks = [];
  let bytes = 0;
  let tooLarge = false;

  req.on('data', function (chunk) {
    if (tooLarge) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    chunks.push(buffer);
    bytes += buffer.length;
    if (bytes > limit) {
      tooLarge = true;
      chunks.length = 0;
      if (typeof onTooLarge === 'function') onTooLarge({ bytes, limit });
    }
  });

  req.on('end', function () {
    if (typeof onComplete !== 'function') return;
    onComplete({
      tooLarge,
      bytes,
      limit,
      buffer: tooLarge ? Buffer.alloc(0) : Buffer.concat(chunks, bytes),
    });
  });

  if (typeof onAborted === 'function') {
    req.on('aborted', onAborted);
  }
}

module.exports = {
  DEFAULT_MAX_DECOMPRESSED_BODY_BYTES,
  normalizeByteLimit,
  getClientIp,
  pathForLogging,
  decodeBodyBuffer,
  extractJsonField,
  estimateTokens,
  inspectContentLength,
  collectLimitedRequestBody,
};
