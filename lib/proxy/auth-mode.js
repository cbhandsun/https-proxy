const { isGoogleOfficialLoginToken } = require('./google-official');
const { isTraeOfficialTarget } = require('./trae-official');
const { isTianxiOfficialTarget } = require('./tianxi-official');
const {
  isWorkBuddyOfficialTarget,
  isWorkBuddyOfficialLoginToken,
} = require('./workbuddy-official');

function isRedactedSecret(value) {
  return (
    !value ||
    value === 'PROXY_MANAGED' ||
    String(value).includes('***') ||
    String(value).includes('[redacted]')
  );
}

function isOpenAIOfficialLoginToken(value) {
  return typeof value === 'string' && value.startsWith('eyJ');
}

function shouldUseChatGPTBackendForOfficialLogin(targetUrl) {
  try {
    const url = new URL(targetUrl || 'https://api.openai.com/v1');
    return url.hostname === 'api.openai.com' || url.hostname === 'chatgpt.com';
  } catch (e) {
    return true;
  }
}

function configuredAuthMode(profile) {
  const raw = String(
    (profile &&
      (profile.authMode || profile.credentialMode || profile.authType || profile.authentication)) ||
      ''
  )
    .trim()
    .toLowerCase();
  if (!raw) return '';
  if (raw === 'api-key' || raw === 'apikey' || raw === 'key') return 'api-key';
  if (
    raw === 'official-login' ||
    raw === 'official' ||
    raw === 'oauth' ||
    raw === 'cli' ||
    raw === 'cli-credentials'
  )
    return 'official-login';
  return '';
}

function officialLoginProvider(profile) {
  const id = profile && profile.id ? String(profile.id).toLowerCase() : '';
  if (id === 'openai-official') return 'openai';
  if (id === 'google-official') return 'google';
  if (id === 'trae-official') return 'trae';
  if (id === 'tianxi-official') return 'tianxi';
  if (id === 'workbuddy-official' || id === 'codebuddy-official') return 'workbuddy';
  if (configuredAuthMode(profile) === 'official-login') {
    const protocol = profile && profile.protocol ? String(profile.protocol).toLowerCase() : '';
    if (protocol === 'gemini') return 'google';
    if (protocol === 'openai' || protocol === 'openai-chat' || protocol === 'openai-responses')
      return 'openai';
    if (protocol === 'trae') return 'trae';
    if (protocol === 'tianxi') return 'tianxi';
    if (protocol === 'workbuddy' || protocol === 'codebuddy') return 'workbuddy';
    if (isTraeOfficialTarget(profile && profile.targetUrl)) return 'trae';
    if (isTianxiOfficialTarget(profile && profile.targetUrl)) return 'tianxi';
    if (isWorkBuddyOfficialTarget(profile && profile.targetUrl)) return 'workbuddy';
  }
  return '';
}

function inferOfficialProfileAuthMode(profile, provider) {
  const explicit = configuredAuthMode(profile);
  if (explicit) return explicit;
  const apiKey = profile && profile.apiKey;
  if (provider === 'google') {
    if (isRedactedSecret(apiKey)) return 'official-login';
    return isGoogleOfficialLoginToken(apiKey) ? 'official-login' : 'api-key';
  }
  if (provider === 'openai') {
    if (isRedactedSecret(apiKey)) return 'official-login';
    return isOpenAIOfficialLoginToken(apiKey) ? 'official-login' : 'api-key';
  }
  if (provider === 'trae') {
    return 'official-login';
  }
  if (provider === 'tianxi') {
    return 'official-login';
  }
  if (provider === 'workbuddy') {
    if (isRedactedSecret(apiKey)) return 'official-login';
    return isWorkBuddyOfficialLoginToken(apiKey) ? 'official-login' : 'official-login';
  }
  return isRedactedSecret(apiKey) ? '' : 'api-key';
}

module.exports = {
  isRedactedSecret,
  isOpenAIOfficialLoginToken,
  isWorkBuddyOfficialLoginToken,
  shouldUseChatGPTBackendForOfficialLogin,
  officialLoginProvider,
  configuredAuthMode,
  inferOfficialProfileAuthMode,
};
