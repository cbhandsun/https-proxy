const MAX_RETRY_DELAY_MS = 120000;

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

function resolveUpstreamRecovery(options = {}) {
  const { kind, statusCode, attempt, maxRetries, prepared, profiles, retryAfter, random } = options;

  if (kind === 'status') {
    const backupProfile = shouldFailoverOnStatus(statusCode, attempt, prepared, profiles);
    if (backupProfile) return { type: 'failover', profile: backupProfile };
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
    if (backupProfile) return { type: 'failover', profile: backupProfile };
    if (shouldRetryAttempt(attempt, maxRetries)) {
      return { type: 'retry', delayMs: retryDelayMs(attempt, random) };
    }
  }

  return { type: 'none' };
}

module.exports = {
  MAX_RETRY_DELAY_MS,
  isRetryableStatusCode,
  shouldRetryAttempt,
  parseRetryAfterMs,
  retryDelayMs,
  shouldRetryUpstreamStatus,
  shouldFailoverOnStatus,
  shouldFailoverOnError,
  resolveUpstreamRecovery,
};
