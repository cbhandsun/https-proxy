const { writeJsonFileAtomically } = require('./management-utils');
const { createLogger } = require('./logger');

const safeLog = createLogger('google-official-runtime');
function createGoogleOfficialRuntime({
  makeRequest,
  googleOfficialCodeAssistUrl,
  googleOfficialModelsFromAvailableModels,
  readAntigravityOfficialCredentialState,
  isGoogleOfficialLoginToken,
  buildGoogleOfficialLoadCodeAssistRequest,
}) {
  let projectCache = { projectId: '', expiresAt: 0 };
  let antigravityTokenCache = { refreshToken: '', accessToken: '', expiresAt: 0 };

  async function refreshGoogleAccessToken(credsPath, content) {
    const refreshToken = content.refresh_token;
    if (!refreshToken) {
      throw new Error('No refresh token available');
    }

    const clientId =
      content.client_id ||
      '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
    const clientSecret =
      content.client_secret ||
      process.env.GOOGLE_OAUTH_CLIENT_SECRET ||
      'REMOVED_PUBLIC_OAUTH_CLIENT_SECRET';
    const postParams = {
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    };
    if (clientSecret) postParams.client_secret = clientSecret;
    const requestBody = new URLSearchParams(postParams).toString();

    const res = await makeRequest(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        timeout: 8000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(requestBody),
        },
      },
      requestBody
    );

    const parsed = JSON.parse(res.body || '{}');

    if (!parsed.access_token) {
      throw new Error(parsed.error_description || parsed.error || 'Failed to refresh token');
    }

    content.access_token = parsed.access_token;
    if (parsed.expires_in) {
      content.expiry_date = Date.now() + parsed.expires_in * 1000;
    }
    if (!credsPath && content.__readOnly && content.refresh_token) {
      antigravityTokenCache = {
        refreshToken: content.refresh_token,
        accessToken: parsed.access_token,
        expiresAt: content.expiry_date || Date.now() + 55 * 60 * 1000,
      };
    }
    if (credsPath && !content.__readOnly) {
      writeJsonFileAtomically(credsPath, content);
    }
    safeLog.info('[auth] Successfully refreshed Google OAuth access token');
    return parsed.access_token;
  }

  async function getFreshAntigravityOfficialAccessToken() {
    const agyCreds = readAntigravityOfficialCredentialState();
    if (!agyCreds || !agyCreds.content) return '';
    const refreshToken = agyCreds.content.refresh_token || '';
    if (
      refreshToken &&
      antigravityTokenCache.refreshToken === refreshToken &&
      antigravityTokenCache.accessToken &&
      Date.now() < antigravityTokenCache.expiresAt - 300000
    ) {
      return antigravityTokenCache.accessToken;
    }
    if (agyCreds.content.refresh_token) {
      return refreshGoogleAccessToken(null, agyCreds.content);
    }
    return agyCreds.content.access_token || '';
  }

  async function fetchGoogleOfficialAvailableModels(apiKey, projectId) {
    const effectiveApiKey =
      (await getFreshAntigravityOfficialAccessToken().catch(() => '')) || apiKey;
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'antigravity-cli/diagnostic',
    };
    if (effectiveApiKey) headers.authorization = `Bearer ${effectiveApiKey}`;
    const requestModels = async (body) => {
      const requestBody = JSON.stringify(body);
      const res = await makeRequest(
        googleOfficialCodeAssistUrl('fetchAvailableModels'),
        {
          method: 'POST',
          headers: { ...headers, 'content-length': Buffer.byteLength(requestBody) },
        },
        requestBody
      );
      let parsed = null;
      try {
        parsed = JSON.parse(res.body || '{}');
      } catch (e) {}
      return { res, parsed };
    };

    let body = projectId ? { project: projectId } : {};
    let { res, parsed } = await requestModels(body);
    const permissionMessage =
      parsed && parsed.error ? parsed.error.message || JSON.stringify(parsed.error) : '';
    if (projectId && (res.statusCode === 403 || /permission/i.test(permissionMessage))) {
      body = {};
      ({ res, parsed } = await requestModels(body));
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const message =
        parsed && parsed.error
          ? parsed.error.message || JSON.stringify(parsed.error)
          : res.body || `HTTP ${res.statusCode}`;
      return { ok: false, error: message, statusCode: res.statusCode };
    }
    return {
      ok: true,
      models: googleOfficialModelsFromAvailableModels(parsed),
      authMode: 'official-login',
      source: 'code-assist-fetchAvailableModels',
      defaultAgentModelId: parsed && parsed.defaultAgentModelId,
      rawModelCount: parsed && parsed.models ? Object.keys(parsed.models).length : 0,
    };
  }

  async function resolveGoogleOfficialProjectId(apiKey) {
    const configuredProject =
      process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || '';
    if (configuredProject) return configuredProject;
    if (projectCache.projectId && Date.now() < projectCache.expiresAt) {
      return projectCache.projectId;
    }
    if (!apiKey || !isGoogleOfficialLoginToken(apiKey)) return '';
    const probe = buildGoogleOfficialLoadCodeAssistRequest(apiKey);
    const res = await makeRequest(
      probe.fullUrl,
      { method: probe.method, headers: probe.headers },
      probe.requestBody
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error('Google Code Assist project discovery failed: HTTP ' + res.statusCode);
    }
    const parsed = JSON.parse(res.body || '{}');
    const companionProject = parsed.cloudaicompanionProject;
    const projectId =
      typeof companionProject === 'string'
        ? companionProject
        : companionProject && typeof companionProject.id === 'string'
          ? companionProject.id
          : '';
    if (projectId) {
      projectCache = { projectId, expiresAt: Date.now() + 5 * 60 * 1000 };
    }
    return projectId;
  }

  function resolveGoogleOfficialLoginPrepared(prepared, profile, apiKey, resolve) {
    prepared.profile = { ...profile, apiKey };
    prepared.authMode = 'official-login';
    prepared.authProvider = 'google';
    resolveGoogleOfficialProjectId(apiKey)
      .then((projectId) => {
        if (projectId) {
          prepared.googleOfficialProjectId = projectId;
          prepared.profile.googleOfficialProjectId = projectId;
        }
        resolve(prepared);
      })
      .catch((err) => {
        safeLog.warn('[auth] Google Code Assist project discovery failed:', err.message);
        resolve(prepared);
      });
  }

  return {
    refreshGoogleAccessToken,
    getFreshAntigravityOfficialAccessToken,
    fetchGoogleOfficialAvailableModels,
    resolveGoogleOfficialProjectId,
    resolveGoogleOfficialLoginPrepared,
  };
}

module.exports = {
  createGoogleOfficialRuntime,
};
