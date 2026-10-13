'use strict';
const { isDeepSeekOfficialTarget } = require('./deepseek-request-contract');

function isDirectStreamingEligible({
  appSettings,
  auditEnabled,
  cliSession,
  contentLength,
  entryAuth,
  entryPath,
  modelRoutes,
  profile,
  requestEncoding,
} = {}) {
  if (!appSettings || appSettings.streamDirectRequestBodies !== true) return false;
  if (auditEnabled || cliSession || requestEncoding) return false;
  if (!contentLength || contentLength.present !== true || contentLength.exceeds === true)
    return false;
  if (!entryAuth || (entryAuth.enabled && !entryAuth.profileAllowed)) return false;
  if (!Array.isArray(modelRoutes) || modelRoutes.length !== 0) return false;
  if (!profile || profile.protocol !== 'openai' || !profile.targetUrl) return false;
  // This provider needs body-dependent capability preflight before dispatch.
  if (isDeepSeekOfficialTarget({ profile })) return false;
  if (/\/backend-api(?:\/|$)/i.test(profile.targetUrl)) return false;
  if (profile.authMode === 'official-login') return false;
  return entryPath === 'chat';
}

module.exports = { isDirectStreamingEligible };
