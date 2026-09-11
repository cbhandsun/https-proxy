'use strict';

const DEFAULT_WARMUP_INTERVAL_MS = 45 * 1000;
const MIN_WARMUP_INTERVAL_MS = 10 * 1000;
const MAX_WARMUP_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_WARMUP_TIMEOUT_MS = 5000;
const DEFAULT_WARMUP_MAX_TARGETS = 4;
const MAX_WARMUP_TARGETS = 16;
const DEFAULT_WARMUP_STAGGER_MS = 200;
const MAX_WARMUP_STAGGER_MS = 5000;
const RECENT_PROFILE_LIMIT = 64;

function parseBoundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function warmupSettings(config) {
  const appSettings = config && config.appSettings ? config.appSettings : {};
  return {
    enabled: appSettings.upstreamWarmupEnabled === true,
    intervalMs: parseBoundedInteger(
      appSettings.upstreamWarmupIntervalMs,
      DEFAULT_WARMUP_INTERVAL_MS,
      MIN_WARMUP_INTERVAL_MS,
      MAX_WARMUP_INTERVAL_MS
    ),
    maxTargets: parseBoundedInteger(
      appSettings.upstreamWarmupMaxTargets,
      DEFAULT_WARMUP_MAX_TARGETS,
      1,
      MAX_WARMUP_TARGETS
    ),
    staggerMs: parseBoundedInteger(
      appSettings.upstreamWarmupStaggerMs,
      DEFAULT_WARMUP_STAGGER_MS,
      0,
      MAX_WARMUP_STAGGER_MS
    ),
  };
}

function warmupHeaders(profile, apiKey) {
  const headers = { accept: 'application/json' };
  if (!apiKey) return headers;
  if (profile.protocol === 'claude') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = profile.protocolVersion || '2023-06-01';
  } else if (profile.protocol === 'gemini') {
    if (String(apiKey).startsWith('ya29.')) headers.authorization = 'Bearer ' + apiKey;
    else headers['x-goog-api-key'] = apiKey;
  } else {
    headers.authorization = 'Bearer ' + apiKey;
  }
  return headers;
}

function isWarmableProfile(profile) {
  return !!(
    profile &&
    profile.enabled !== false &&
    profile.targetUrl &&
    profile.protocol !== 'trae'
  );
}

function profileIdentity(profile) {
  return [
    String(profile.protocol || ''),
    String(profile.targetUrl || '')
      .replace(/\/+$/, '')
      .toLowerCase(),
    String(profile.apiKey || ''),
  ].join('\u0000');
}

function selectWarmupProfiles(state, maxTargets, recentProfileIds = []) {
  const profiles = Array.isArray(state && state.PROFILES)
    ? state.PROFILES
    : Array.isArray(state && state.CONFIG && state.CONFIG.profiles)
      ? state.CONFIG.profiles
      : [];
  const byId = new Map(
    profiles
      .filter((profile) => profile && profile.id)
      .map((profile) => [String(profile.id), profile])
  );
  const candidates = [];
  const addProfile = (profile) => {
    if (isWarmableProfile(profile)) candidates.push(profile);
  };

  for (const profileId of recentProfileIds) addProfile(byId.get(String(profileId)));
  for (const routes of [state && state.MODEL_ROUTES, state && state.CLAUDE_DESKTOP_ROUTES]) {
    for (const route of Array.isArray(routes) ? routes : []) {
      if (!route || route.enabled === false || !route.profileId) continue;
      addProfile(byId.get(String(route.profileId)));
    }
  }
  addProfile(state && state.ACTIVE_PROFILE);

  const unique = [];
  const identities = new Set();
  for (const profile of candidates) {
    const identity = profileIdentity(profile);
    if (identities.has(identity)) continue;
    identities.add(identity);
    unique.push(profile);
  }
  const limit = parseBoundedInteger(maxTargets, DEFAULT_WARMUP_MAX_TARGETS, 1, MAX_WARMUP_TARGETS);
  return { eligibleCount: unique.length, profiles: unique.slice(0, limit) };
}

function createUpstreamWarmup({
  getRuntimeState,
  decryptKey,
  getModelsUrl,
  parseTargetUrl,
  http,
  https,
  metricsInstance,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (typeof getRuntimeState !== 'function') {
    throw new TypeError('createUpstreamWarmup requires getRuntimeState');
  }
  if (typeof decryptKey !== 'function') {
    throw new TypeError('createUpstreamWarmup requires decryptKey');
  }
  if (typeof getModelsUrl !== 'function' || typeof parseTargetUrl !== 'function') {
    throw new TypeError('createUpstreamWarmup requires URL helpers');
  }
  if (
    !http ||
    !https ||
    typeof http.request !== 'function' ||
    typeof https.request !== 'function'
  ) {
    throw new TypeError('createUpstreamWarmup requires HTTP transports');
  }

  const warmupCounter = metricsInstance?.counter?.(
    'proxy_upstream_warmup_total',
    'Upstream warmup attempts by outcome'
  );
  const warmupTargetGauge = metricsInstance?.gauge?.(
    'proxy_upstream_warmup_targets',
    'Upstream warmup target counts by selection state'
  );
  const recentProfileIds = new Map();
  const pendingTimers = new Set();
  let timer = null;
  let intervalMs = null;
  let currentCycle = null;

  function recordOutcome(outcome) {
    try {
      warmupCounter?.inc?.(1, { outcome });
    } catch (_error) {}
  }

  function setTargetCount(state, value) {
    try {
      warmupTargetGauge?.set?.(value, { state });
    } catch (_error) {}
  }

  function noteProfileUsed(profile) {
    const id = String((profile && profile.id) || '').trim();
    if (!id) return;
    recentProfileIds.delete(id);
    recentProfileIds.set(id, true);
    while (recentProfileIds.size > RECENT_PROFILE_LIMIT) {
      recentProfileIds.delete(recentProfileIds.keys().next().value);
    }
  }

  function finishTarget(cycle, outcome) {
    if (!cycle || cycle.cancelled || cycle.finishedTargets >= cycle.totalTargets) return;
    cycle.finishedTargets += 1;
    recordOutcome(outcome);
    if (cycle.finishedTargets === cycle.totalTargets && currentCycle === cycle) {
      currentCycle = null;
    }
  }

  function warmProfile(state, profile, cycle) {
    if (cycle.cancelled) return;
    let target;
    let apiKey;
    let url;
    try {
      target = parseTargetUrl(profile.targetUrl);
      apiKey = decryptKey(profile.apiKey || '');
      url = new URL(getModelsUrl(profile.targetUrl, profile.protocol));
    } catch (_error) {
      finishTarget(cycle, 'invalid_target');
      return;
    }

    const transport = target.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      finishTarget(cycle, outcome);
    };
    let req;
    try {
      req = transport.request(
        {
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method: 'GET',
          headers: warmupHeaders(profile, apiKey),
          agent: target.protocol === 'https:' ? state.globalHttpsAgent : state.globalHttpAgent,
          timeout: DEFAULT_WARMUP_TIMEOUT_MS,
        },
        (res) => {
          res.resume();
          res.once('end', () => finish('response'));
          res.once('close', () => finish('closed'));
        }
      );
    } catch (_error) {
      finish('error');
      return;
    }
    req.once('timeout', () => {
      finish('timeout');
      req.destroy();
    });
    req.once('error', () => finish('error'));
    req.end();
  }

  function runOnce() {
    if (currentCycle) return 0;
    const state = getRuntimeState() || {};
    const settings = warmupSettings(state.CONFIG);
    if (!settings.enabled) return 0;

    const selected = selectWarmupProfiles(
      state,
      settings.maxTargets,
      Array.from(recentProfileIds.keys()).reverse()
    );
    setTargetCount('eligible', selected.eligibleCount);
    setTargetCount('selected', selected.profiles.length);
    if (!selected.profiles.length) return 0;

    const cycle = {
      cancelled: false,
      finishedTargets: 0,
      totalTargets: selected.profiles.length,
    };
    currentCycle = cycle;
    selected.profiles.forEach((profile, index) => {
      const delay = index * settings.staggerMs;
      if (!delay) {
        warmProfile(state, profile, cycle);
        return;
      }
      const pending = setTimeoutFn(() => {
        pendingTimers.delete(pending);
        warmProfile(state, profile, cycle);
      }, delay);
      pendingTimers.add(pending);
      if (pending && typeof pending.unref === 'function') pending.unref();
    });
    return selected.profiles.length;
  }

  function refresh() {
    const settings = warmupSettings((getRuntimeState() || {}).CONFIG);
    if (!settings.enabled) {
      if (timer) clearIntervalFn(timer);
      timer = null;
      intervalMs = null;
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

  function stop() {
    if (timer) clearIntervalFn(timer);
    timer = null;
    intervalMs = null;
    if (currentCycle) currentCycle.cancelled = true;
    currentCycle = null;
    for (const pending of pendingTimers) clearTimeoutFn(pending);
    pendingTimers.clear();
  }

  return { noteProfileUsed, refresh, runOnce, stop };
}

module.exports = {
  DEFAULT_WARMUP_INTERVAL_MS,
  DEFAULT_WARMUP_MAX_TARGETS,
  DEFAULT_WARMUP_STAGGER_MS,
  DEFAULT_WARMUP_TIMEOUT_MS,
  MAX_WARMUP_INTERVAL_MS,
  MAX_WARMUP_STAGGER_MS,
  MAX_WARMUP_TARGETS,
  MIN_WARMUP_INTERVAL_MS,
  createUpstreamWarmup,
  selectWarmupProfiles,
  warmupHeaders,
  warmupSettings,
};
