const MAX_RETRY_DELAY_MS = 120000;
const MAX_IDEMPOTENCY_KEY_CHARS = 256;
const SAFE_REPLAY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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

function resolveBackupProfile(prepared, profiles) {
  const backupProfileId = prepared && prepared.profile && prepared.profile.backupProfileId;
  if (!backupProfileId || !Array.isArray(profiles)) return null;
  return profiles.find((profile) => profile && profile.id === backupProfileId) || null;
}

function shouldFailoverOnStatus(statusCode, attempt, prepared, profiles) {
  if (Number(attempt) !== 1 || !isRetryableStatusCode(Number(statusCode))) return null;
  return resolveBackupProfile(prepared, profiles);
}

function shouldFailoverOnError(attempt, prepared, profiles) {
  if (Number(attempt) !== 1) return null;
  return resolveBackupProfile(prepared, profiles);
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

function resolveUpstreamRecovery(options = {}) {
  const { kind, statusCode, attempt, maxRetries, prepared, profiles, retryAfter, random } = options;
  if (!canReplayRequest(options)) return { type: 'none' };

  if (kind === 'status') {
    const backupProfile = shouldFailoverOnStatus(statusCode, attempt, prepared, profiles);
    if (backupProfile && !isUnsafeReplayMethod(options.method)) {
      return { type: 'failover', profile: backupProfile };
    }
    if (shouldRetryUpstreamStatus(statusCode, attempt, maxRetries)) {
      return {
        type: 'retry',
        delayMs: retryDelayMs(attempt, random, retryAfter),
      };
    }
    return { type: 'none' };
  }

  if (kind === 'error') {
    const backupProfile = shouldFailoverOnError(attempt, prepared, profiles);
    if (backupProfile && !isUnsafeReplayMethod(options.method)) {
      return { type: 'failover', profile: backupProfile };
    }
    if (shouldRetryAttempt(attempt, maxRetries)) {
      return { type: 'retry', delayMs: retryDelayMs(attempt, random) };
    }
  }

  return { type: 'none' };
}

module.exports = {
  MAX_RETRY_DELAY_MS,
  MAX_IDEMPOTENCY_KEY_CHARS,
  SAFE_REPLAY_METHODS,
  isRetryableStatusCode,
  shouldRetryAttempt,
  parseRetryAfterMs,
  retryDelayMs,
  shouldRetryUpstreamStatus,
  shouldFailoverOnStatus,
  shouldFailoverOnError,
  isValidIdempotencyKey,
  isUnsafeReplayMethod,
  canReplayRequest,
  resolveUpstreamRecovery,
};
