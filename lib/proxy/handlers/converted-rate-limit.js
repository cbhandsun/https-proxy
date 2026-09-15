'use strict';

const { sendRateLimit } = require('../local-handlers');

const MAX_CONVERTED_LOCAL_COOLDOWN_SECONDS = 24 * 60 * 60;

function shouldApplyConvertedRateLimitCooldown(prepared) {
  const profile = prepared && prepared.profile ? prepared.profile : {};
  const id = String(profile.id || '').toLowerCase();
  const protocol = String(profile.protocol || '').toLowerCase();
  return id === 'workbuddy-official' || id === 'codebuddy-official' || protocol === 'workbuddy';
}

function convertedRateLimitCooldown(prepared, targetModel) {
  if (!shouldApplyConvertedRateLimitCooldown(prepared)) return null;
  return {
    profileId: prepared.profile && prepared.profile.id,
    targetModel,
    fallbackSeconds: 45,
  };
}

function formatConvertedCooldownDuration(seconds) {
  const parsed = Math.ceil(Number(seconds));
  if (!Number.isFinite(parsed) || parsed <= 0) return 'a short while';
  const clamped = Math.min(parsed, MAX_CONVERTED_LOCAL_COOLDOWN_SECONDS);
  if (clamped < 60) return clamped + 's';
  if (clamped < 3600) {
    const minutes = Math.floor(clamped / 60);
    const remainingSeconds = clamped % 60;
    return remainingSeconds ? `${minutes}m${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  return minutes ? `${hours}h${minutes}m` : `${hours}h`;
}

function sendConvertedLocalCooldown(
  clientReq,
  clientRes,
  prepared,
  upstreamPath,
  startTime,
  targetModel,
  deps
) {
  const { getUpstreamCooldown, log, logRequestEnd } = deps || {};
  if (
    !shouldApplyConvertedRateLimitCooldown(prepared) ||
    typeof getUpstreamCooldown !== 'function'
  ) {
    return false;
  }
  const profileId = prepared.profile && prepared.profile.id;
  const cooldown = getUpstreamCooldown(profileId, targetModel);
  if (!cooldown) return false;
  log.warn(
    'upstream rate limited ' +
      clientReq.method +
      ' ' +
      upstreamPath +
      ' -> 429 retry_after=' +
      cooldown.retryAfterSeconds +
      's source=local_cooldown target=' +
      targetModel
  );
  sendRateLimit(
    clientReq,
    clientRes,
    upstreamPath,
    startTime,
    targetModel,
    cooldown.retryAfterSeconds,
    'Upstream rate limit cooldown active. Please retry in ' +
      formatConvertedCooldownDuration(cooldown.retryAfterSeconds) +
      '.',
    {
      source: 'local_cooldown',
      profileId,
    },
    logRequestEnd,
    {
      maxRetryAfterSeconds: MAX_CONVERTED_LOCAL_COOLDOWN_SECONDS,
      type: 'upstream_rate_limit',
    }
  );
  return true;
}

module.exports = {
  convertedRateLimitCooldown,
  formatConvertedCooldownDuration,
  sendConvertedLocalCooldown,
  shouldApplyConvertedRateLimitCooldown,
};
