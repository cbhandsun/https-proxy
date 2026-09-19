'use strict';

const TIANXI_OFFICIAL_TARGET_URL = 'http://127.0.0.1:49305';

function isTianxiOfficialProfile(profileOrId) {
  if (!profileOrId) return false;
  if (typeof profileOrId === 'string') return profileOrId.toLowerCase() === 'tianxi-official';
  const id = profileOrId.id ? String(profileOrId.id).toLowerCase() : '';
  if (id === 'tianxi-official') return true;
  return isTianxiOfficialTarget(profileOrId.targetUrl);
}

function isTianxiOfficialTarget(targetUrl) {
  try {
    const url = new URL(targetUrl || '');
    const host = url.hostname.toLowerCase();
    return (
      host === 'tianxi.local' ||
      host === 'tianxi-bridge.local' ||
      url.protocol === 'tianxi:' ||
      /^\/?tianxi(?:\/|$)/i.test(url.pathname || '')
    );
  } catch (err) {
    return false;
  }
}

function normalizeTianxiOfficialModelName(model) {
  const value = String(model || '').trim();
  if (!value) return 'tianxi-super';
  return value.replace(/^tianxi\//i, '');
}

function getTianxiOfficialBridgeUrl(pathname = '/v1/responses', profile) {
  const base =
    (profile && profile.bridgeUrl) ||
    process.env.TIANXI_BRIDGE_URL ||
    (profile && profile.targetUrl && !isTianxiOfficialTarget(profile.targetUrl)
      ? profile.targetUrl
      : TIANXI_OFFICIAL_TARGET_URL);
  const url = new URL(base || TIANXI_OFFICIAL_TARGET_URL);
  const suffix = String(pathname || '').startsWith('/') ? pathname : '/' + pathname;
  url.pathname = url.pathname.replace(/\/$/, '') + suffix;
  return url.toString();
}

module.exports = {
  TIANXI_OFFICIAL_TARGET_URL,
  getTianxiOfficialBridgeUrl,
  isTianxiOfficialProfile,
  isTianxiOfficialTarget,
  normalizeTianxiOfficialModelName,
};
