function isRetryableStatusCode(statusCode) {
  return statusCode === 429 || statusCode >= 500;
}

function shouldRetryAttempt(attempt, maxRetries) {
  return Number(attempt) <= Number(maxRetries);
}

function retryDelayMs(attempt, random = Math.random) {
  const jitter = typeof random === 'function' ? Number(random()) : 0;
  const safeJitter = Number.isFinite(jitter) ? Math.min(Math.max(jitter, 0), 1) : 0;
  return Math.pow(2, Number(attempt) || 0) * 1000 + safeJitter * 500;
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

module.exports = {
  isRetryableStatusCode,
  shouldRetryAttempt,
  retryDelayMs,
  shouldRetryUpstreamStatus,
  shouldFailoverOnStatus,
  shouldFailoverOnError,
};
