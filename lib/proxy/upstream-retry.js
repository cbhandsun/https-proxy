const {
  getUpstreamCooldown,
  getGeminiCooldown,
  parseRetryAfterHeaderSeconds: defaultParseRetryAfterHeaderSeconds,
  setUpstreamCooldown: defaultSetUpstreamCooldown,
} = require('./errors');

const MAX_RETRY_DELAY_MS = 120000;
const MAX_IDEMPOTENCY_KEY_CHARS = 256;
const SAFE_REPLAY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 在请求体发出之前就失败的 TLS 错误码。
 *
 * 背景：DNS 被投毒时连到的服务器持有别人的证书，TLS 校验先于任何应用层字节失败，
 * 于是请求从未到达上游。这类失败重放不会产生重复副作用，因此即便是不带
 * Idempotency-Key 的 POST 也应该允许重试——否则一次投毒会让整段对话直接 502。
 * 只收录握手阶段明确失败的错误码；连接中途断开的错误不在此列，仍走原有的
 * 可重放判定。
 */
const PRE_TRANSMISSION_TLS_ERROR_CODES = new Set([
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
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
]);

function normalizeErrorCode(value) {
  return String(value == null ? '' : value)
    .trim()
    .toUpperCase();
}

/**
 * 判断失败是否发生在"请求体尚未发出"的阶段，因此重放没有上游副作用。
 *
 * 两个来源：
 * 1. 错误码本身就能证明握手失败（证书不匹配等），应用层字节从未写出；
 * 2. 失败时 TLS 握手尚未完成。TLS 层在握手完成前只缓存应用层写入，握手没完成
 *    就没有任何 HTTP 字节到达网络——这是协议保证，与具体错误码无关，因此
 *    "握手阶段被重置"也属于这一类，不必把 ECONNRESET 整体列为可重放。
 *
 * 复用连接不享受第 2 条：握手早已完成，复用连接上的失败无法证明请求体未发出。
 */
function isPreTransmissionFailure(errorCode, context) {
  if (PRE_TRANSMISSION_TLS_ERROR_CODES.has(normalizeErrorCode(errorCode))) return true;
  const safeContext = context && typeof context === 'object' ? context : {};
  if (safeContext.reusedSocket === true) return false;
  return safeContext.tlsHandshakeIncomplete === true;
}

/**
 * 从出站请求对象读取判定所需的连接状态。
 *
 * `secureConnecting` 在 TLS 握手期间为 true，握手完成后为 false；握手阶段被重置时
 * 它保持 true，因此错误回调里读取是可靠的。普通 TCP socket 上该属性不存在，按
 * "非 TLS"处理。
 */
function readPreTransmissionContext(request) {
  const socket = request && request.socket ? request.socket : null;
  return {
    tlsHandshakeIncomplete: !!(socket && socket.secureConnecting === true),
    reusedSocket: !!(request && request.reusedSocket === true),
  };
}

function isRetryableStatusCode(statusCode) {
  return statusCode === 429 || statusCode >= 500;
}

function shouldRetryAttempt(attempt, maxRetries) {
  const parsedAttempt = Number(attempt);
  const parsedMaxRetries = Number(maxRetries);
  return (
    Number.isInteger(parsedAttempt) &&
    Number.isInteger(parsedMaxRetries) &&
    parsedAttempt >= 1 &&
    parsedMaxRetries >= 0 &&
    parsedAttempt <= parsedMaxRetries
  );
}

function parseRetryAfterMs(value, now = Date.now(), maxDelayMs = MAX_RETRY_DELAY_MS) {
  if (value == null || value === '') return null;
  const safeMaxDelay = Number.isFinite(Number(maxDelayMs))
    ? Math.max(0, Math.trunc(Number(maxDelayMs)))
    : MAX_RETRY_DELAY_MS;
  const text = String(value).trim();
  if (!text) return null;

  let delayMs;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    delayMs = Number(text) * 1000;
  } else {
    const timestamp = Date.parse(text);
    const nowMs = Number(now);
    if (!Number.isFinite(timestamp) || !Number.isFinite(nowMs)) return null;
    delayMs = timestamp - nowMs;
  }
  if (!Number.isFinite(delayMs)) return null;
  return Math.min(safeMaxDelay, Math.max(0, Math.ceil(delayMs)));
}

function retryDelayMs(attempt, random = Math.random, retryAfter = null) {
  const parsedAttempt = Number(attempt);
  const safeAttempt = Number.isFinite(parsedAttempt)
    ? Math.min(10, Math.max(0, Math.trunc(parsedAttempt)))
    : 0;
  const jitter = typeof random === 'function' ? Number(random()) : 0;
  const safeJitter = Number.isFinite(jitter) ? Math.min(Math.max(jitter, 0), 1) : 0;
  const exponentialDelay = Math.min(
    MAX_RETRY_DELAY_MS,
    Math.pow(2, safeAttempt) * 1000 + safeJitter * 500
  );
  const retryAfterMs = parseRetryAfterMs(retryAfter);
  return retryAfterMs == null ? exponentialDelay : Math.max(exponentialDelay, retryAfterMs);
}

function shouldRetryUpstreamStatus(statusCode, attempt, maxRetries) {
  return isRetryableStatusCode(Number(statusCode)) && shouldRetryAttempt(attempt, maxRetries);
}

function resolveTargetModelForPrepared(prepared) {
  if (!prepared || typeof prepared !== 'object') return '';
  const rewriteTo = String(prepared.rewriteTo || prepared.targetModel || '').trim();
  if (rewriteTo && rewriteTo !== '-') return rewriteTo;
  const model = String(prepared.model || '').trim();
  if (model && model !== '-') return model;
  return '';
}

function isProfileTargetCoolingDown(profile, targetModel, options = {}) {
  if (!profile || !profile.id || !targetModel || targetModel === '-') return false;
  if (typeof options.isCoolingDown === 'function') {
    return Boolean(options.isCoolingDown(profile.id, targetModel, profile));
  }
  if (getUpstreamCooldown(profile.id, targetModel)) return true;
  if (profile.protocol === 'gemini' && getGeminiCooldown(profile.id, targetModel)) return true;
  return false;
}

function collectFailoverCandidates(prepared, profiles, options = {}) {
  if (!prepared || !Array.isArray(profiles) || profiles.length === 0) return [];
  const currentProfile = prepared.profile || null;
  const route = prepared.route || null;
  const visitedIds = new Set();
  if (currentProfile && currentProfile.id) visitedIds.add(currentProfile.id);
  if (Array.isArray(prepared.failoverVisited)) {
    for (const id of prepared.failoverVisited) {
      if (id) visitedIds.add(String(id));
    }
  }

  const orderedIds = [];
  const seenCandidateIds = new Set();
  const pushCandidateId = (rawId) => {
    const id = String(rawId || '').trim();
    if (!id || visitedIds.has(id) || seenCandidateIds.has(id)) return;
    seenCandidateIds.add(id);
    orderedIds.push(id);
  };

  if (route && Array.isArray(route.fallbacks)) {
    for (const item of route.fallbacks) {
      if (typeof item === 'string') pushCandidateId(item);
      else if (item && typeof item === 'object') pushCandidateId(item.profileId);
    }
  }
  if (route && route.backupProfileId) {
    pushCandidateId(route.backupProfileId);
  }
  if (currentProfile && Array.isArray(currentProfile.fallbackProfileIds)) {
    for (const id of currentProfile.fallbackProfileIds) {
      pushCandidateId(id);
    }
  }
  if (currentProfile && currentProfile.backupProfileId) {
    pushCandidateId(currentProfile.backupProfileId);
  }
  if (Array.isArray(prepared.failoverQueue)) {
    for (const id of prepared.failoverQueue) {
      pushCandidateId(id);
    }
  }

  // Follow chained backupProfileId / fallbackProfileIds when failoverVisited is used
  if (Array.isArray(prepared.failoverVisited)) {
    const queue = [...orderedIds];
    let hops = 0;
    while (queue.length > 0 && hops < 8) {
      hops += 1;
      const nextId = queue.shift();
      const nextProfile = profiles.find((p) => p && p.id === nextId);
      if (!nextProfile) continue;
      if (Array.isArray(nextProfile.fallbackProfileIds)) {
        for (const fid of nextProfile.fallbackProfileIds) {
          const prevLen = orderedIds.length;
          pushCandidateId(fid);
          if (orderedIds.length > prevLen) queue.push(String(fid).trim());
        }
      }
      if (nextProfile.backupProfileId) {
        const prevLen = orderedIds.length;
        pushCandidateId(nextProfile.backupProfileId);
        if (orderedIds.length > prevLen) queue.push(String(nextProfile.backupProfileId).trim());
      }
    }
  }

  const targetModel = resolveTargetModelForPrepared(prepared);
  const candidates = [];
  for (const id of orderedIds) {
    const found = profiles.find((profile) => profile && profile.id === id);
    if (!found) continue;
    if (
      options.ignoreCooldown !== true &&
      targetModel &&
      isProfileTargetCoolingDown(found, targetModel, options)
    ) {
      continue;
    }
    candidates.push(found);
  }
  return candidates;
}

function resolveBackupProfile(prepared, profiles, options = {}) {
  const parsedAttempt = Number(options.attempt == null ? 1 : options.attempt);
  if (!Number.isInteger(parsedAttempt) || parsedAttempt < 1) return null;
  const candidates = collectFailoverCandidates(prepared, profiles, options);
  if (candidates.length === 0) return null;
  if (Array.isArray(prepared && prepared.failoverVisited)) {
    return candidates[0] || null;
  }
  return candidates[parsedAttempt - 1] || null;
}

function advanceFailoverPrepared(prepared, nextProfile, options = {}) {
  const current = prepared && typeof prepared === 'object' ? prepared : {};
  const currentProfile = current.profile || {};
  const visited = Array.isArray(current.failoverVisited) ? [...current.failoverVisited] : [];
  if (currentProfile.id && !visited.includes(currentProfile.id)) {
    visited.push(currentProfile.id);
  }
  const queue = Array.isArray(current.failoverQueue) ? [...current.failoverQueue] : [];
  if (Array.isArray(currentProfile.fallbackProfileIds)) {
    for (const fid of currentProfile.fallbackProfileIds) {
      if (fid && !queue.includes(fid)) queue.push(fid);
    }
  }
  if (currentProfile.backupProfileId && !queue.includes(currentProfile.backupProfileId)) {
    queue.push(currentProfile.backupProfileId);
  }
  if (Number(options.statusCode) === 429 && currentProfile.id) {
    const targetModel = resolveTargetModelForPrepared(current);
    const setCooldown =
      typeof options.setUpstreamCooldown === 'function'
        ? options.setUpstreamCooldown
        : defaultSetUpstreamCooldown;
    const parseRetryAfter =
      typeof options.parseRetryAfterHeaderSeconds === 'function'
        ? options.parseRetryAfterHeaderSeconds
        : defaultParseRetryAfterHeaderSeconds;
    if (targetModel && typeof setCooldown === 'function') {
      const retryAfterSeconds =
        (typeof parseRetryAfter === 'function' && parseRetryAfter(options.retryAfter)) || 30;
      setCooldown(currentProfile.id, targetModel, retryAfterSeconds, {
        source: options.retryAfter ? 'failover_retry_after' : 'failover_rate_limit',
      });
    }
  }
  const nextCount = Number(current.failoverCount || 0) + 1;
  let nextRewriteTo = current.rewriteTo;
  let nextTargetModel = current.targetModel;
  if (nextProfile && nextProfile.id && current.route && Array.isArray(current.route.fallbacks)) {
    const matchedFb = current.route.fallbacks.find(
      (item) => item && typeof item === 'object' && item.profileId === nextProfile.id && item.to
    );
    if (matchedFb && matchedFb.to) {
      nextRewriteTo = matchedFb.to;
      nextTargetModel = matchedFb.to;
    }
  }
  current.profile = nextProfile;
  current.failoverVisited = visited;
  current.failoverQueue = queue;
  current.failoverCount = nextCount;
  if (nextRewriteTo !== undefined) current.rewriteTo = nextRewriteTo;
  if (nextTargetModel !== undefined) current.targetModel = nextTargetModel;
  return {
    ...current,
    profile: nextProfile,
    failoverVisited: visited,
    failoverQueue: queue,
    failoverCount: nextCount,
  };
}

function shouldFailoverOnStatus(statusCode, attempt, prepared, profiles, options = {}) {
  if (!isRetryableStatusCode(Number(statusCode))) return null;
  return resolveBackupProfile(prepared, profiles, { ...options, attempt });
}

function shouldFailoverOnError(attempt, prepared, profiles, options = {}) {
  return resolveBackupProfile(prepared, profiles, { ...options, attempt });
}

function readHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const expectedName = String(name || '').toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() !== expectedName) continue;
    if (Array.isArray(value)) return value.length === 1 ? String(value[0] || '') : '';
    return value == null ? '' : String(value);
  }
  return '';
}

function isValidIdempotencyKey(value) {
  const key = String(value || '');
  return key.length >= 1 && key.length <= MAX_IDEMPOTENCY_KEY_CHARS && /^[\x21-\x7e]+$/.test(key);
}

function canReplayRequest(options = {}) {
  if (options.responseStarted === true) return false;
  const method = String(options.method || '')
    .trim()
    .toUpperCase();
  if (SAFE_REPLAY_METHODS.has(method)) return true;
  if (!options.prepared?.profile?.retryUnsafeRequests) return false;
  return isValidIdempotencyKey(readHeader(options.headers, 'idempotency-key'));
}

function isUnsafeReplayMethod(method) {
  return !SAFE_REPLAY_METHODS.has(
    String(method || '')
      .trim()
      .toUpperCase()
  );
}

function shouldAllowFailover(options = {}) {
  if (options.responseStarted === true) return false;
  if (options.allowPostFailover === true) return true;
  if (options.prepared?.profile?.allowPostFailover === true) return true;
  return canReplayRequest(options) && !isUnsafeReplayMethod(options.method);
}

function resolveUpstreamRecovery(options = {}) {
  const { kind, statusCode, attempt, maxRetries, prepared, profiles, retryAfter, random } = options;
  if (options.responseStarted === true) return { type: 'none' };

  if (kind === 'status') {
    const backupProfile = shouldFailoverOnStatus(statusCode, attempt, prepared, profiles, options);
    if (backupProfile && shouldAllowFailover(options)) {
      return { type: 'failover', profile: backupProfile };
    }
    if (canReplayRequest(options) && shouldRetryUpstreamStatus(statusCode, attempt, maxRetries)) {
      return {
        type: 'retry',
        delayMs: retryDelayMs(attempt, random, retryAfter),
      };
    }
    return { type: 'none' };
  }

  if (kind === 'error') {
    const backupProfile = shouldFailoverOnError(attempt, prepared, profiles, options);
    if (backupProfile && shouldAllowFailover(options)) {
      return { type: 'failover', profile: backupProfile };
    }
    // 握手前失败（典型是 DNS 投毒导致的证书不匹配）没有产生任何上游副作用，
    // 允许在响应开始前重试，即使请求是不带幂等键的 POST。
    const replaySafe =
      options.responseStarted !== true &&
      (canReplayRequest(options) ||
        isPreTransmissionFailure(options.errorCode, options.preTransmissionContext));
    if (replaySafe && shouldRetryAttempt(attempt, maxRetries)) {
      return { type: 'retry', delayMs: retryDelayMs(attempt, random) };
    }
  }

  return { type: 'none' };
}

module.exports = {
  MAX_RETRY_DELAY_MS,
  MAX_IDEMPOTENCY_KEY_CHARS,
  SAFE_REPLAY_METHODS,
  PRE_TRANSMISSION_TLS_ERROR_CODES,
  isRetryableStatusCode,
  isPreTransmissionFailure,
  readPreTransmissionContext,
  shouldRetryAttempt,
  parseRetryAfterMs,
  retryDelayMs,
  shouldRetryUpstreamStatus,
  collectFailoverCandidates,
  resolveBackupProfile,
  advanceFailoverPrepared,
  shouldFailoverOnStatus,
  shouldFailoverOnError,
  isValidIdempotencyKey,
  isUnsafeReplayMethod,
  canReplayRequest,
  shouldAllowFailover,
  resolveUpstreamRecovery,
};
