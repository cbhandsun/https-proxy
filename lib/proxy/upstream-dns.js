/**
 * 出站上游域名的抗污染解析。
 *
 * 问题背景：Windows 的 DNS Client 会在多个已配置的 DNS 服务器之间自行选择，
 * 现场观测到它把 chatgpt.com 交给被投毒的路由器解析，拿到一个属于别人的 IP，
 * TLS 校验随即以 ERR_TLS_CERT_ALTNAME_INVALID 失败（证书主体是 m.minghui.org），
 * 代理只能向客户端返回 502。TLS 校验本身是对的，错的是"用了哪个解析器"。
 *
 * 这里提供一条不走系统解析器缓存的解析路径：直接向受信 DNS 服务器（默认
 * 1.1.1.1 / 8.8.8.8 / 223.5.5.5）查询，按配置顺序取第一个可用结果，并丢弃
 * 回环、私网、链路本地等不可路由地址。全部受信服务器失败时回退到系统解析，
 * 保证极端网络下不会比现状更差。
 *
 * 已知边界：受信服务器自身若返回"公网但错误"的地址，这里无法识别；TLS 证书
 * 校验仍是最后一道防线（本次故障正是被它拦下的）。命中这类失败时调用方应调用
 * invalidate() 丢弃该域名的缓存条目，让重试拿到新答案。
 */
'use strict';

const dns = require('node:dns');
const net = require('node:net');

const DEFAULT_DNS_SERVERS = Object.freeze(['1.1.1.1', '8.8.8.8', '223.5.5.5']);
const MAX_DNS_SERVERS = 8;
const DEFAULT_QUERY_TIMEOUT_MS = 1500;
const MIN_QUERY_TIMEOUT_MS = 50;
const MAX_QUERY_TIMEOUT_MS = 30000;
const DEFAULT_CACHE_TTL_MS = 30000;
const MIN_CACHE_TTL_MS = 1000;
const MAX_CACHE_TTL_MS = 300000;
const DEFAULT_MAX_CACHE_ENTRIES = 512;
const MAX_CACHE_ENTRIES_LIMIT = 10000;
const MAX_ADDRESSES_PER_RESULT = 8;

const PRIVATE_IPV4_RANGES = Object.freeze([
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]);

function clampInt(value, fallback, min, max) {
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value == null ? '' : value), 10);
  const integer = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  return Math.min(max, Math.max(min, integer));
}

function ipv4ToInt(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function isPublicIpv4(address) {
  const value = ipv4ToInt(address);
  if (value === null) return false;
  for (const [base, bits] of PRIVATE_IPV4_RANGES) {
    const baseValue = ipv4ToInt(base);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) >>> 0 === (baseValue & mask) >>> 0) return false;
  }
  return true;
}

function isPublicIpv6(address) {
  const value = String(address).toLowerCase().split('%')[0];
  if (!value) return false;
  if (value === '::' || value === '::1') return false;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) return isPublicIpv4(mapped[1]);
  if (value.startsWith('fc') || value.startsWith('fd')) return false; // 唯一本地地址 fc00::/7
  if (/^fe[89ab]/.test(value)) return false; // 链路本地 fe80::/10
  if (value.startsWith('ff')) return false; // 组播 ff00::/8
  if (value.startsWith('2001:db8')) return false; // 文档地址
  return true;
}

/** 只接受可在公网路由的地址；污染与解析异常常表现为私网/回环答案。 */
function isPublicAddress(address, family) {
  const version = family || net.isIP(String(address));
  if (version === 4) return isPublicIpv4(address);
  if (version === 6) return isPublicIpv6(address);
  return false;
}

/**
 * 解析 DNS 服务器列表。接受数组或逗号分隔字符串，保留顺序去重，
 * 返回可用列表与被拒绝的原始条目，便于配置校验给出具体报错。
 */
function parseDnsServerList(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.trim()
      ? value.split(',')
      : [];
  const servers = [];
  const invalid = [];
  const seen = new Set();
  for (const entry of raw) {
    const text = String(entry == null ? '' : entry).trim();
    if (!text) continue;
    const family = net.isIP(text);
    if (family !== 4 && family !== 6) {
      invalid.push(text);
      continue;
    }
    if (seen.has(text)) continue;
    seen.add(text);
    if (servers.length < MAX_DNS_SERVERS) servers.push(text);
  }
  return { servers, invalid };
}

function normalizeFamily(value) {
  const parsed = Number(value);
  if (parsed === 4 || parsed === 6) return parsed;
  return 0;
}

function normalizeHostnameKey(hostname) {
  return String(hostname).trim().toLowerCase().replace(/\.$/, '');
}

/**
 * 这些错误码说明"连到的那台机器不是我们要找的那台"，最可能的原因是该域名的
 * DNS 答案不可信（污染、劫持、坏缓存）。命中时应丢弃本地缓存条目，让下一次
 * 重试重新查询，而不是继续复用同一个地址。
 *
 * 刻意不包含 ECONNRESET/EPIPE 这类连接中途断开的错误：那类失败与地址是否正确
 * 无关，丢弃缓存只会增加无谓查询。
 */
const ADDRESS_UNTRUSTWORTHY_ERROR_CODES = new Set([
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_PACKET_LENGTH_TOO_LONG',
  'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
  'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

function isUntrustworthyAddressError(errorCode) {
  const code = String(errorCode == null ? '' : errorCode)
    .trim()
    .toUpperCase();
  return ADDRESS_UNTRUSTWORTHY_ERROR_CODES.has(code);
}

/**
 * 判断是否应该直接交给系统解析。
 *
 * 单标签名（localhost、内网机器名）与 .local/.internal/.lan/… 由搜索域、NetBIOS 或
 * mDNS 提供，公网 DNS 一定查不到。若交给受信服务器，每次都要等满超时再回退，
 * 会把正常的内网请求拖慢数秒，因此这类名字直接走系统解析。
 */
function shouldUseSystemResolver(hostname) {
  const host = normalizeHostnameKey(hostname);
  if (!host) return true;
  if (host === 'localhost') return true;
  if (!host.includes('.')) return true;
  return /\.(?:local|localhost|internal|intranet|lan|home|corp|localdomain)$/.test(host);
}

function withTimeout(promise, timeoutMs, onTimeout) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        if (typeof onTimeout === 'function') onTimeout();
      } catch (error) {}
      const error = new Error(`DNS query timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 使用 promise 版 Resolver：回调版 resolve4 不接受 { ttl: true }，
 * 而 TTL 是这里的缓存依据之一。
 */
function defaultCreateResolver() {
  return new dns.promises.Resolver({ timeout: DEFAULT_QUERY_TIMEOUT_MS, tries: 2 });
}

function collectAddresses(records, family) {
  const items = Array.isArray(records) ? records : [];
  const addresses = [];
  const seen = new Set();
  let minTtlMs = null;
  for (const item of items) {
    const address = typeof item === 'string' ? item : item && item.address;
    if (typeof address !== 'string' || !address) continue;
    if (!isPublicAddress(address, family)) continue;
    if (seen.has(address)) continue;
    seen.add(address);
    addresses.push({ address, family });
    const ttlSeconds = item && typeof item === 'object' ? Number(item.ttl) : NaN;
    if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
      const ttlMs = ttlSeconds * 1000;
      minTtlMs = minTtlMs === null ? ttlMs : Math.min(minTtlMs, ttlMs);
    }
    if (addresses.length >= MAX_ADDRESSES_PER_RESULT) break;
  }
  return { addresses, minTtlMs };
}

/**
 * 创建把 IPv4 放在首位、只返回公网地址的上游解析器。
 *
 * servers 为空表示纯系统解析（等同于禁用本模块），调用方据此支持用户关闭。
 */
function createUpstreamResolver(options = {}) {
  const {
    servers = DEFAULT_DNS_SERVERS,
    queryTimeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    maxCacheEntries = DEFAULT_MAX_CACHE_ENTRIES,
    systemLookup = dns.lookup,
    createResolver = defaultCreateResolver,
    logger = null,
    now = Date.now,
  } = options;
  if (typeof systemLookup !== 'function') {
    throw new TypeError('createUpstreamResolver requires systemLookup to be a function');
  }
  if (typeof createResolver !== 'function') {
    throw new TypeError('createUpstreamResolver requires createResolver to be a function');
  }

  const trustedServers = parseDnsServerList(servers).servers;
  const timeoutMs = clampInt(
    queryTimeoutMs,
    DEFAULT_QUERY_TIMEOUT_MS,
    MIN_QUERY_TIMEOUT_MS,
    MAX_QUERY_TIMEOUT_MS
  );
  const ttlCapMs = clampInt(cacheTtlMs, DEFAULT_CACHE_TTL_MS, MIN_CACHE_TTL_MS, MAX_CACHE_TTL_MS);
  const entryCap = clampInt(maxCacheEntries, DEFAULT_MAX_CACHE_ENTRIES, 1, MAX_CACHE_ENTRIES_LIMIT);
  const cache = new Map();

  function readCache(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      cache.delete(key);
      return null;
    }
    return entry.addresses;
  }

  function writeCache(key, addresses, minTtlMs) {
    const ttl = Math.min(ttlCapMs, Math.max(MIN_CACHE_TTL_MS, minTtlMs || ttlCapMs));
    if (cache.size >= entryCap) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, { addresses, expiresAt: now() + ttl });
  }

  function queryServer(server, hostname, family) {
    let resolver;
    try {
      resolver = createResolver({ timeout: timeoutMs });
      resolver.setServers([server]);
    } catch (error) {
      return Promise.reject(error);
    }
    const queries = [];
    if (family !== 6) {
      queries.push(
        resolver.resolve4(hostname, { ttl: true }).then((records) => collectAddresses(records, 4))
      );
    }
    if (family !== 4) {
      queries.push(
        resolver.resolve6(hostname, { ttl: true }).then((records) => collectAddresses(records, 6))
      );
    }
    if (queries.length === 0) return Promise.reject(new Error('no query family selected'));

    return withTimeout(
      Promise.allSettled(queries).then((results) => {
        const addresses = [];
        const seen = new Set();
        let minTtlMs = null;
        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          for (const item of result.value.addresses) {
            if (seen.has(item.address)) continue;
            seen.add(item.address);
            addresses.push(item);
            if (addresses.length >= MAX_ADDRESSES_PER_RESULT) break;
          }
          if (result.value.minTtlMs != null) {
            minTtlMs =
              minTtlMs === null ? result.value.minTtlMs : Math.min(minTtlMs, result.value.minTtlMs);
          }
        }
        if (addresses.length === 0) {
          const error = new Error(`No usable address from ${server}`);
          error.code = 'ENODATA';
          throw error;
        }
        return { addresses, minTtlMs };
      }),
      timeoutMs,
      () => {
        try {
          resolver.cancel();
        } catch (error) {}
      }
    );
  }

  /** 按配置顺序取第一个返回可用地址的服务器；顺序即优先级。 */
  function resolveViaTrustedServers(hostname, family) {
    const attempts = trustedServers.map((server) =>
      queryServer(server, hostname, family).then(
        (result) => ({ server, result }),
        (error) => ({ server, error })
      )
    );
    return Promise.all(attempts).then((results) => {
      for (const item of results) {
        if (item.result && item.result.addresses.length > 0) return item.result;
      }
      const error = new Error('All trusted DNS servers failed');
      error.code = 'EAI_AGAIN';
      throw error;
    });
  }

  function reply(addresses, wantsAll, callback) {
    if (wantsAll) {
      callback(
        null,
        addresses.map((item) => ({ address: item.address, family: item.family }))
      );
      return;
    }
    callback(null, addresses[0].address, addresses[0].family);
  }

  /**
   * 与 dns.lookup 同签名，可直接作为 http/https Agent 的 lookup 选项。
   */
  function lookup(hostname, options, callback) {
    let normalizedOptions = options;
    let done = callback;
    if (typeof normalizedOptions === 'function') {
      done = normalizedOptions;
      normalizedOptions = {};
    }
    if (typeof done !== 'function') {
      throw new TypeError('lookup requires a callback');
    }
    const opts =
      typeof normalizedOptions === 'number'
        ? { family: normalizedOptions }
        : normalizedOptions || {};
    const family = normalizeFamily(opts.family);
    const wantsAll = opts.all === true;
    const host = String(hostname);

    const literalFamily = net.isIP(host);
    if (literalFamily) {
      queueMicrotask(() => reply([{ address: host, family: literalFamily }], wantsAll, done));
      return;
    }
    if (trustedServers.length === 0) {
      systemLookup(host, normalizedOptions, done);
      return;
    }
    if (shouldUseSystemResolver(host)) {
      systemLookup(host, normalizedOptions, done);
      return;
    }

    const key = `${normalizeHostnameKey(host)}|${family}`;
    const cached = readCache(key);
    if (cached && cached.length > 0) {
      queueMicrotask(() => reply(cached, wantsAll, done));
      return;
    }

    resolveViaTrustedServers(host, family).then(
      (result) => {
        writeCache(key, result.addresses, result.minTtlMs);
        reply(result.addresses, wantsAll, done);
      },
      (error) => {
        if (logger && typeof logger.debug === 'function') {
          logger.debug(
            { err: error, host },
            'Trusted upstream DNS failed; falling back to system resolver'
          );
        }
        systemLookup(host, normalizedOptions, done);
      }
    );
  }

  function invalidate(hostname) {
    const base = normalizeHostnameKey(hostname);
    let removed = false;
    for (const key of [...cache.keys()]) {
      if (key === base || key.startsWith(`${base}|`)) {
        cache.delete(key);
        removed = true;
      }
    }
    return removed;
  }

  return {
    lookup,
    invalidate,
    shouldUseSystemResolver,
    servers: Object.freeze([...trustedServers]),
    cacheSize: () => cache.size,
  };
}

module.exports = {
  DEFAULT_DNS_SERVERS,
  MAX_DNS_SERVERS,
  shouldUseSystemResolver,
  ADDRESS_UNTRUSTWORTHY_ERROR_CODES,
  isUntrustworthyAddressError,
  DEFAULT_QUERY_TIMEOUT_MS,
  DEFAULT_CACHE_TTL_MS,
  MIN_CACHE_TTL_MS,
  MAX_CACHE_TTL_MS,
  DEFAULT_MAX_CACHE_ENTRIES,
  isPublicAddress,
  parseDnsServerList,
  createUpstreamResolver,
};
