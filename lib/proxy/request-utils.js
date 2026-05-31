const zlib = require('zlib');

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function decodeBodyBuffer(buffer, encoding) {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buffer).toString('utf8');
    if (encoding === 'deflate') return zlib.inflateSync(buffer).toString('utf8');
    if (encoding === 'br') return zlib.brotliDecompressSync(buffer).toString('utf8');
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
  if (value == null) return 0;
  if (typeof value === 'string') return Math.ceil(value.length / 4);
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateTokens(item), 0);
  if (typeof value === 'object') return Object.values(value).reduce((sum, item) => sum + estimateTokens(item), 0);
  return Math.ceil(String(value).length / 4);
}

module.exports = {
  getClientIp,
  decodeBodyBuffer,
  extractJsonField,
  estimateTokens,
};
