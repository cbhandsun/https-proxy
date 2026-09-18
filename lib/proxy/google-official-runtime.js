const { writeJsonFileAtomically } = require('./management-utils');
const { createLogger } = require('./logger');

const safeLog = createLogger('google-official-runtime');
const DEFAULT_ANTIGRAVITY_WATCHDOG_INTERVAL_MS = 60 * 1000;
const MIN_ANTIGRAVITY_WATCHDOG_INTERVAL_MS = 15 * 1000;
const MAX_ANTIGRAVITY_WATCHDOG_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_ANTIGRAVITY_REFRESH_FALLBACK_DELAY_MS = 1200;
const MAX_ANTIGRAVITY_REFRESH_FALLBACK_DELAY_MS = 5000;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function delay(ms, setTimeoutFn) {
  const waitMs = boundedInteger(
    ms,
    DEFAULT_ANTIGRAVITY_REFRESH_FALLBACK_DELAY_MS,
    0,
    MAX_ANTIGRAVITY_REFRESH_FALLBACK_DELAY_MS
  );
  if (waitMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeoutFn(resolve, waitMs));
}

function antigravityWatchdogSettings(config) {
  const appSettings = config && config.appSettings ? config.appSettings : {};
  return {
    enabled: appSettings.antigravityCredentialWatchdogEnabled !== false,
    intervalMs: boundedInteger(
      appSettings.antigravityCredentialWatchdogIntervalMs,
      DEFAULT_ANTIGRAVITY_WATCHDOG_INTERVAL_MS,
      MIN_ANTIGRAVITY_WATCHDOG_INTERVAL_MS,
      MAX_ANTIGRAVITY_WATCHDOG_INTERVAL_MS
    ),
  };
}

function summarizeAntigravityCredential(result) {
  if (!result || !result.content) return { source: '', dbPath: '', credentialTarget: '' };
  return {
    source: result.source || result.content.__source || '',
    dbPath: result.dbPath || '',
    credentialTarget: result.credentialTarget || '',
  };
}

function hasGoogleOfficialRoute(state) {
  const profiles = Array.isArray(state && state.PROFILES) ? state.PROFILES : [];
  const routes = Array.isArray(state && state.MODEL_ROUTES) ? state.MODEL_ROUTES : [];
  return (
    profiles.some(
      (profile) =>
        profile &&
        profile.protocol === 'gemini' &&
        (profile.authMode === 'official-login' || profile.id === 'google-official')
    ) || routes.some((route) => route && route.profileId === 'google-official')
  );
}

function createGoogleOfficialRuntime({
  makeRequest,
  googleOfficialCodeAssistUrl,
  googleOfficialModelsFromAvailableModels,
  readAntigravityOfficialCredentialState,
  isGoogleOfficialLoginToken,
  buildGoogleOfficialLoadCodeAssistRequest,
  env = process.env,
  setTimeoutFn = setTimeout,
}) {
  let projectCache = { projectId: '', expiresAt: 0 };
  let antigravityTokenCache = { refreshToken: '', accessToken: '', expiresAt: 0 };
  let antigravityCredentialSummary = { source: '', dbPath: '', credentialTarget: '' };
  const antigravityRefreshInFlight = new Map();

  function clearGoogleOfficialRuntimeCaches() {
    projectCache = { projectId: '', expiresAt: 0 };
    antigravityTokenCache = { refreshToken: '', accessToken: '', expiresAt: 0 };
  }

  async function refreshGoogleAccessToken(credsPath, content) {
    const refreshToken = content.refresh_token;
    if (!refreshToken) {
      throw new Error('No refresh token available');
    }

    const clientId =
      content.client_id ||
      env.GOOGLE_OAUTH_CLIENT_ID ||
      '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
    // Distributed desktop clients cannot keep a client secret. Only use one supplied by
    // the credential owner or by an explicit local environment override.
    const clientSecret =
      content.client_secret ||
      env.GOOGLE_OAUTH_CLIENT_SECRET ||
      env.ANTIGRAVITY_OAUTH_CLIENT_SECRET ||
      '';
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

  async function getFreshAntigravityOfficialAccessToken(options = {}) {
    if (options && options.forceReload) clearGoogleOfficialRuntimeCaches();
    const agyCreds = readAntigravityOfficialCredentialState({
      preferCredentialManager: options.preferCredentialManager === true,
    });
    if (!agyCreds || !agyCreds.content) return '';
    antigravityCredentialSummary = summarizeAntigravityCredential(agyCreds);
    const refreshToken = agyCreds.content.refresh_token || '';
    const accessToken = agyCreds.content.access_token || '';
    const expiresAt = Number(agyCreds.content.expiry_date) || 0;
    if (accessToken && (!expiresAt || Date.now() < expiresAt - 300000)) {
      return accessToken;
    }
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
    return accessToken;
  }

  function antigravityRefreshKey(options = {}) {
    return options.preferCredentialManager === true ? 'credential-manager' : 'default';
  }

  async function refreshAntigravityWithCredentialManagerFallback(options = {}) {
    let primaryError = null;
    const fallbackDelayMs =
      options.secondaryRefreshDelayMs ?? DEFAULT_ANTIGRAVITY_REFRESH_FALLBACK_DELAY_MS;
    try {
      const token = await getFreshAntigravityOfficialAccessToken({
        ...options,
        forceReload: true,
      });
      if (token || options.preferCredentialManager === true) return token;
    } catch (error) {
      primaryError = error;
      if (options.preferCredentialManager === true) throw error;
    }
    await delay(fallbackDelayMs, setTimeoutFn);
    try {
      const fallbackToken = await getFreshAntigravityOfficialAccessToken({
        ...options,
        forceReload: true,
        preferCredentialManager: true,
      });
      if (fallbackToken) return fallbackToken;
    } catch {
      // Preserve the primary failure so callers keep the original safe error boundary.
    }
    if (primaryError) throw primaryError;
    return '';
  }

  async function refreshAntigravityOfficialAccessToken(options = {}) {
    const key = antigravityRefreshKey(options);
    const existing = antigravityRefreshInFlight.get(key);
    if (existing) return existing;
    const refreshPromise = refreshAntigravityWithCredentialManagerFallback(options).finally(() => {
      if (antigravityRefreshInFlight.get(key) === refreshPromise) {
        antigravityRefreshInFlight.delete(key);
      }
    });
    antigravityRefreshInFlight.set(key, refreshPromise);
    return refreshPromise;
  }

  function getAntigravityCredentialStatus() {
    return { ...antigravityCredentialSummary };
  }

  async function probeAntigravityOfficialCredentials(options = {}) {
    const token = await getFreshAntigravityOfficialAccessToken({
      forceReload: options.forceReload === true,
    });
    if (!token) {
      return {
        ok: false,
        statusCode: 0,
        errorType: 'missing_token',
        ...getAntigravityCredentialStatus(),
      };
    }
    const probe = buildGoogleOfficialLoadCodeAssistRequest(token);
    const res = await makeRequest(
      probe.fullUrl,
      { method: probe.method, headers: probe.headers, timeout: 8000 },
      probe.requestBody
    );
    if ((res.statusCode === 401 || res.statusCode === 403) && options.retry !== false) {
      const failedSummary = getAntigravityCredentialStatus();
      let reloadedToken = await refreshAntigravityOfficialAccessToken({
        reason: options.reason || 'probe_auth_failure',
      });
      if (
        (!reloadedToken || reloadedToken === token) &&
        failedSummary.source &&
        failedSummary.source !== 'antigravity-credential-manager'
      ) {
        reloadedToken = await refreshAntigravityOfficialAccessToken({
          reason: options.reason || 'probe_auth_failure',
          preferCredentialManager: true,
        });
      }
      if (reloadedToken && reloadedToken !== token) {
        const retryProbe = buildGoogleOfficialLoadCodeAssistRequest(reloadedToken);
        const retryRes = await makeRequest(
          retryProbe.fullUrl,
          { method: retryProbe.method, headers: retryProbe.headers, timeout: 8000 },
          retryProbe.requestBody
        );
        return {
          ok: retryRes.statusCode >= 200 && retryRes.statusCode < 300,
          statusCode: retryRes.statusCode,
          retried: true,
          ...getAntigravityCredentialStatus(),
        };
      }
    }
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      statusCode: res.statusCode,
      retried: false,
      ...getAntigravityCredentialStatus(),
    };
  }

  function createAntigravityCredentialWatchdog({
    getRuntimeState,
    logProxyEvent = () => {},
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = {}) {
    let timer = null;
    let intervalMs = null;
    let inFlight = false;
    let lastStatusKey = '';

    function stop() {
      if (timer) clearIntervalFn(timer);
      timer = null;
      intervalMs = null;
      inFlight = false;
    }

    async function runOnce() {
      if (inFlight) return { skipped: true, reason: 'in_flight' };
      const state = typeof getRuntimeState === 'function' ? getRuntimeState() || {} : {};
      const settings = antigravityWatchdogSettings(state.CONFIG);
      if (!settings.enabled || !hasGoogleOfficialRoute(state)) {
        return { skipped: true, reason: 'disabled_or_unused' };
      }
      inFlight = true;
      try {
        const result = await probeAntigravityOfficialCredentials({
          reason: 'watchdog',
          forceReload: true,
        });
        const statusKey = [
          result.ok ? 'ok' : 'fail',
          result.statusCode || 0,
          result.errorType || '',
          result.source || '',
          result.dbPath || '',
        ].join('\u0000');
        if (statusKey !== lastStatusKey || !result.ok) {
          logProxyEvent('antigravity_credential_watchdog', {
            ok: result.ok,
            statusCode: result.statusCode,
            errorType: result.errorType,
            retried: result.retried === true,
            source: result.source,
            dbPath: result.dbPath,
            credentialTarget: result.credentialTarget,
          });
          lastStatusKey = statusKey;
        }
        return result;
      } catch (error) {
        const errorType = error && (error.code || error.name) ? error.code || error.name : 'error';
        logProxyEvent('antigravity_credential_watchdog', {
          ok: false,
          statusCode: 0,
          errorType,
        });
        lastStatusKey = ['fail', 0, errorType].join('\u0000');
        return { ok: false, statusCode: 0, errorType };
      } finally {
        inFlight = false;
      }
    }

    function refresh() {
      const state = typeof getRuntimeState === 'function' ? getRuntimeState() || {} : {};
      const settings = antigravityWatchdogSettings(state.CONFIG);
      if (!settings.enabled || !hasGoogleOfficialRoute(state)) {
        stop();
        return;
      }
      if (!timer || intervalMs !== settings.intervalMs) {
        if (timer) clearIntervalFn(timer);
        intervalMs = settings.intervalMs;
        timer = setIntervalFn(runOnce, intervalMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }
      runOnce();
    }

    return { refresh, runOnce, stop };
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
    clearGoogleOfficialRuntimeCaches,
    createAntigravityCredentialWatchdog,
    refreshGoogleAccessToken,
    getFreshAntigravityOfficialAccessToken,
    refreshAntigravityOfficialAccessToken,
    getAntigravityCredentialStatus,
    probeAntigravityOfficialCredentials,
    fetchGoogleOfficialAvailableModels,
    resolveGoogleOfficialProjectId,
    resolveGoogleOfficialLoginPrepared,
  };
}

module.exports = {
  DEFAULT_ANTIGRAVITY_WATCHDOG_INTERVAL_MS,
  MAX_ANTIGRAVITY_WATCHDOG_INTERVAL_MS,
  MIN_ANTIGRAVITY_WATCHDOG_INTERVAL_MS,
  antigravityWatchdogSettings,
  createGoogleOfficialRuntime,
};
