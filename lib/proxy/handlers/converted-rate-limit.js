'use strict';

const { sendRateLimit } = require('../local-handlers');

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
    'Upstream rate limit cooldown active. Please retry in ' + cooldown.retryAfterSeconds + 's.',
    {
      source: 'local_cooldown',
      profileId,
    },
    logRequestEnd,
    { type: 'upstream_rate_limit' }
  );
  return true;
}

module.exports = {
  convertedRateLimitCooldown,
  sendConvertedLocalCooldown,
  shouldApplyConvertedRateLimitCooldown,
};
