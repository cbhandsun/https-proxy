const dns = require('dns');
const https = require('https');
const net = require('net');

const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 4096;
const MAX_URL_LENGTH = 2048;
const HEALTH_MARKER = 'https-proxy-manager';

const blockedAddresses = new net.BlockList();
for (const [address, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
]) {
  blockedAddresses.addSubnet(address, prefix, family);
}

function parseTimeout(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(parsed)));
}

function normalizeBasePath(pathname) {
  const path = String(pathname || '/').replace(/\/+$/, '');
  if (!path) return '/v1';
  if (path === '/v1') return path;
  if (path === '/v1/models') return '/v1';
  if (path === '/v1/chat/completions') return '/v1';
  if (path === '/v1/responses') return '/v1';
  if (path === '/v1/messages') return '/v1';
  throw new Error('External ingress URL path must be empty, /v1, or a supported /v1 endpoint');
}

function parseExternalIngressUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('External ingress URL is required');
  }
  const text = value.trim();
  if (text.length > MAX_URL_LENGTH) throw new Error('External ingress URL is too long');
  let parsed;
  try {
    parsed = new URL(text);
  } catch (error) {
    throw new Error('External ingress URL is invalid', { cause: error });
  }
  if (parsed.protocol !== 'https:') throw new Error('External ingress URL must use HTTPS');
  if (parsed.username || parsed.password) {
    throw new Error('External ingress URL must not include credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('External ingress URL must not include query parameters or fragments');
  }
  if (parsed.port && parsed.port !== '443') {
    throw new Error('External ingress URL must use the standard HTTPS port');
  }
  const basePath = normalizeBasePath(parsed.pathname);
  parsed.pathname = `${basePath}/.well-known/hpm-health`;
  return {
    baseUrl: `${parsed.origin}${basePath}`,
    hostname: parsed.hostname,
    probeUrl: parsed.toString(),
  };
}

function isPublicIpAddress(address) {
  const normalized = String(address || '').replace(/^\[|\]$/g, '');
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedIpv4) return isPublicIpAddress(mappedIpv4[1]);
  const family = net.isIP(normalized);
  if (!family) return false;
  const familyName = family === 6 ? 'ipv6' : 'ipv4';
  return !blockedAddresses.check(normalized, familyName);
}

async function resolvePublicAddresses(hostname, lookup = dns.promises.lookup) {
  const normalizedHostname = String(hostname || '').replace(/^\[|\]$/g, '');
  if (net.isIP(normalizedHostname)) {
    if (!isPublicIpAddress(normalizedHostname)) {
      const error = new Error('External ingress host must be public');
      error.code = 'ERR_UNSAFE_ADDRESS';
      throw error;
    }
    return [{ address: normalizedHostname, family: net.isIP(normalizedHostname) }];
  }
  let records;
  try {
    records = await lookup(normalizedHostname, { all: true, verbatim: true });
  } catch (error) {
    const next = new Error('External ingress DNS lookup failed', { cause: error });
    next.code = error && error.code ? error.code : 'DNS_LOOKUP_FAILED';
    throw next;
  }
  const normalized = (Array.isArray(records) ? records : [records])
    .map((record) =>
      typeof record === 'string'
        ? { address: record, family: net.isIP(record) }
        : { address: record && record.address, family: Number(record && record.family) }
    )
    .filter((record) => record.address && (record.family === 4 || record.family === 6));
  if (!normalized.length) {
    const error = new Error('External ingress DNS returned no usable addresses');
    error.code = 'DNS_EMPTY_RESULT';
    throw error;
  }
  if (normalized.some((record) => !isPublicIpAddress(record.address))) {
    const error = new Error('External ingress DNS must resolve only to public addresses');
    error.code = 'ERR_UNSAFE_ADDRESS';
    throw error;
  }
  return normalized;
}

function boundedHeader(headers, name) {
  const value = headers && headers[name];
  if (Array.isArray(value)) return String(value[0] || '').slice(0, 256);
  return String(value || '')
    .replace(/[\r\n\0]/g, '')
    .slice(0, 256);
}

function classifyResponse({ statusCode, headers, body }) {
  const requestId = boundedHeader(headers, 'x-request-id');
  const marker = boundedHeader(headers, 'x-hpm-proxy');
  const contentType = boundedHeader(headers, 'content-type').toLowerCase();
  const server = boundedHeader(headers, 'server').toLowerCase();
  const normalizedBody = String(body || '')
    .trim()
    .toLowerCase();

  if (marker === HEALTH_MARKER) {
    return {
      ok: statusCode >= 200 && statusCode < 300,
      proxyReached: true,
      classification: 'proxy_reached',
      message: '外部入口已到达 HTTPS Proxy Manager',
    };
  }
  if (requestId && statusCode === 401) {
    return {
      ok: true,
      proxyReached: true,
      classification: 'legacy_proxy_reached',
      message: '外部入口已到达代理鉴权边界；运行版本尚未提供专用健康标记',
    };
  }
  if (statusCode === 404 && server.includes('nginx') && !contentType.includes('json')) {
    return {
      ok: false,
      proxyReached: false,
      classification: 'ingress_route_missing',
      message: 'nginx 已响应，但未匹配到代理转发路由',
    };
  }
  if ([502, 503, 504].includes(statusCode)) {
    return {
      ok: false,
      proxyReached: false,
      classification: 'ingress_upstream_unavailable',
      message: '入口网关无法连接代理上游或隧道',
    };
  }
  if ([301, 302, 303, 307, 308].includes(statusCode)) {
    return {
      ok: false,
      proxyReached: false,
      classification: 'unexpected_redirect',
      message: '入口返回了未预期的重定向',
    };
  }
  if (statusCode === 403) {
    return {
      ok: false,
      proxyReached: false,
      classification: 'ingress_blocked',
      message: '请求被入口网关或 WAF 拒绝',
    };
  }
  return {
    ok: false,
    proxyReached: Boolean(requestId),
    classification: requestId ? 'proxy_probe_rejected' : 'unexpected_response',
    message:
      normalizedBody === '404 page not found'
        ? '入口返回了未归属到代理的 404'
        : '入口返回了无法识别的响应',
  };
}

function classifyRequestError(error) {
  const code = String((error && error.code) || 'REQUEST_FAILED');
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return { classification: 'timeout', message: '外部入口探测超时' };
  }
  if (code.startsWith('ERR_TLS') || code.includes('CERT')) {
    return { classification: 'tls_error', message: '外部入口 TLS 校验失败' };
  }
  if (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'DNS_LOOKUP_FAILED' ||
    code === 'DNS_EMPTY_RESULT'
  ) {
    return { classification: 'dns_error', message: '外部入口 DNS 解析失败' };
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
    return { classification: 'connection_error', message: '外部入口连接失败' };
  }
  return { classification: 'request_error', message: '外部入口探测失败' };
}

function buildRequestFailure(target, startedAt, error) {
  const classification = classifyRequestError(error);
  return {
    ok: false,
    proxyReached: false,
    ...classification,
    checkedAt: new Date().toISOString(),
    url: target.baseUrl,
    elapsedMs: Date.now() - startedAt,
    errorCode: String((error && error.code) || 'REQUEST_FAILED').slice(0, 64),
  };
}

async function probeExternalIngress(value, options = {}) {
  const target = parseExternalIngressUrl(value);
  const timeoutMs = parseTimeout(options.timeoutMs);
  const startedAt = Date.now();
  let addresses;
  try {
    addresses = await resolvePublicAddresses(target.hostname, options.lookup);
  } catch (error) {
    if (error && error.code === 'ERR_UNSAFE_ADDRESS') throw error;
    return buildRequestFailure(target, startedAt, error);
  }
  const selected = addresses[0];
  const requestFactory = options.requestFactory || https.request;

  try {
    const response = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(result);
      };
      const request = requestFactory(
        target.probeUrl,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            connection: 'close',
            'user-agent': 'https-proxy-manager-ingress-probe',
          },
          lookup(_hostname, lookupOptions, callback) {
            if (lookupOptions && lookupOptions.all === true) {
              callback(null, [{ address: selected.address, family: selected.family }]);
              return;
            }
            callback(null, selected.address, selected.family);
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          let capturedBytes = 0;
          res.on('data', (chunk) => {
            if (capturedBytes >= MAX_RESPONSE_BYTES) return;
            const remaining = MAX_RESPONSE_BYTES - capturedBytes;
            const part = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
            chunks.push(part);
            capturedBytes += part.length;
          });
          res.on('end', () =>
            finish(null, {
              statusCode: Number(res.statusCode || 0),
              headers: res.headers || {},
              body: Buffer.concat(chunks, capturedBytes).toString('utf8'),
            })
          );
          res.on('error', (error) => finish(error));
        }
      );
      request.on('timeout', () => {
        const error = new Error('External ingress probe timed out');
        error.code = 'ETIMEDOUT';
        request.destroy(error);
      });
      request.on('error', (error) => finish(error));
      request.end();
    });
    const classification = classifyResponse(response);
    return {
      ...classification,
      checkedAt: new Date().toISOString(),
      url: target.baseUrl,
      statusCode: response.statusCode,
      elapsedMs: Date.now() - startedAt,
      response: {
        contentType: boundedHeader(response.headers, 'content-type'),
        requestId: boundedHeader(response.headers, 'x-request-id'),
        server: boundedHeader(response.headers, 'server'),
      },
    };
  } catch (error) {
    return buildRequestFailure(target, startedAt, error);
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  HEALTH_MARKER,
  classifyRequestError,
  classifyResponse,
  isPublicIpAddress,
  parseExternalIngressUrl,
  probeExternalIngress,
  resolvePublicAddresses,
};
