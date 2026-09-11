const { DEFAULT_CONFIG } = require('./config');
const { createRouteIndex } = require('./route-index');
const { parsePortOrDefault } = require('./management-utils');
const { createLogger } = require('./logger');

const safeLog = createLogger('routing');
const TARGET_URL_CACHE_LIMIT = 256;
const WILDCARD_ROUTE_REGEX_CACHE_LIMIT = 1024;
const targetUrlCache = new Map();
const wildcardRouteRegexCache = new Map();

// Per-config route index; rebuilt on demand when routes change
let _indexCache = null; // { routes, index }

function getOrBuildIndex(modelRoutes) {
  if (_indexCache && _indexCache.routes === modelRoutes) return _indexCache.index;
  const index = createRouteIndex(modelRoutes, { cacheLimit: 1024 });
  _indexCache = { routes: modelRoutes, index };
  return index;
}

function cacheSetWithLimit(cache, key, value, limit) {
  cache.set(key, value);
  if (cache.size > limit) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}

function parseTargetUrl(value) {
  const cacheKey = value || DEFAULT_CONFIG.profiles[0].targetUrl;
  const cached = targetUrlCache.get(cacheKey);
  if (cached) return { ...cached };

  const parsed = new URL(cacheKey);
  const defaultPort = parsed.protocol === 'https:' ? 443 : 80;
  let path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
  if (!path) {
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'api.openai.com' ||
      host === 'api.anthropic.com' ||
      host === 'api.deepseek.com' ||
      host === 'api.groq.com'
    ) {
      path = '/v1';
    }
  }
  const result = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsePortOrDefault(parsed.port, defaultPort),
    path,
  };
  cacheSetWithLimit(targetUrlCache, cacheKey, result, TARGET_URL_CACHE_LIMIT);
  return { ...result };
}

function wildcardRouteMatcher(source) {
  const cached = wildcardRouteRegexCache.get(source);
  if (cached) return cached;

  const escaped = source
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const matcher = {
    regex: new RegExp('^' + escaped + '$', 'i'),
    score: 1000 + source.replace(/\*/g, '').length,
  };
  cacheSetWithLimit(wildcardRouteRegexCache, source, matcher, WILDCARD_ROUTE_REGEX_CACHE_LIMIT);
  return matcher;
}

function routeMatchScore(pattern, model) {
  if (!pattern || !model) return -1;
  const source = String(pattern).trim();
  const target = String(model).trim();
  if (!source) return -1;
  if (source === target) return 10000 + source.length;
  if (source === '*' || source.toLowerCase() === 'default') return 1;
  if (!source.includes('*')) return -1;
  const matcher = wildcardRouteMatcher(source);
  return matcher.regex.test(target) ? matcher.score : -1;
}

function resolveRoute(model, modelRoutes, profiles, activeProfile) {
  // Fast path: use the indexed lookup (prefix buckets + LRU)
  const index = getOrBuildIndex(modelRoutes);
  const best = index.findBest(model);
  if (best && best.entry) {
    let selectedRoute = best.entry.route;
    if (best.candidateCount > 1) {
      // Load balancing: walk matches again and pick a random same-score peer.
      // The index only stores the highest-scoring entry's count for tie-breaking
      // simplicity, so we re-scan to pick a different route at random.
      const peers = [];
      const seen = new Set();
      const matches = index._index.buckets;
      for (const [key, entries] of matches) {
        if (key === '*' || model.indexOf(key) === 0) {
          for (const e of entries) {
            if (!seen.has(e) && e.score === best.entry.score && e.regex.test(model)) {
              peers.push(e);
              seen.add(e);
            }
          }
        }
      }
      if (peers.length > 1) {
        selectedRoute = peers[Math.floor(Math.random() * peers.length)].route;
      }
    }
    const profile = profiles.find((item) => item.id === selectedRoute.profileId) || activeProfile;
    return { profile, route: selectedRoute };
  }

  // Fallback: original linear scan (covers cases the index missed, e.g. disabled routes
  // not in the index but the original code would still consider)
  let fallbackBest = null;
  const candidates = [];
  for (const item of modelRoutes) {
    if (!item || item.enabled === false) continue;
    const score = routeMatchScore(item.from, model);
    if (score < 0) continue;
    if (!fallbackBest || score > fallbackBest.score) {
      fallbackBest = { route: item, score };
      candidates.length = 0;
      candidates.push(item);
    } else if (score === fallbackBest.score) {
      candidates.push(item);
    }
  }
  if (!fallbackBest) return { profile: activeProfile, route: null };
  const selectedRoute =
    candidates.length > 1
      ? candidates[Math.floor(Math.random() * candidates.length)]
      : fallbackBest.route;
  const profile = profiles.find((item) => item.id === selectedRoute.profileId) || activeProfile;
  return { profile, route: selectedRoute };
}

function resetRouteIndex() {
  _indexCache = null;
}

function rebuildRouteIndex(modelRoutes) {
  // Hot-reload entry point. If the index already exists for these routes,
  // reuse it (so the LRU survives); otherwise build a fresh one. Returning
  // a boolean lets callers know whether a real rebuild actually happened
  // (so they can decide whether to bump metrics counters).
  if (_indexCache && _indexCache.routes === modelRoutes && _indexCache.index) {
    _indexCache.index.rebuild(modelRoutes);
    return true;
  }
  const index = createRouteIndex(modelRoutes, { cacheLimit: 1024 });
  _indexCache = { routes: modelRoutes, index };
  return true;
}

function isGeminiProfile(profile) {
  return profile && profile.protocol === 'gemini';
}

function isOpenAIProfile(profile) {
  return (
    !profile ||
    !profile.protocol ||
    profile.protocol === 'openai' ||
    profile.protocol === 'openai-chat' ||
    profile.protocol === 'openai-responses' ||
    profile.protocol === 'workbuddy'
  );
}

function shouldConvertResponsesToOpenAIChat(profile) {
  if (!profile) return false;
  return (
    profile.forceChatCompletions === true ||
    profile.supportsResponses === false ||
    profile.responsesMode === 'chat' ||
    profile.responsesEndpoint === 'chat' ||
    profile.protocol === 'openai-chat'
  );
}

function isClaudeProfile(profile) {
  return profile && profile.protocol === 'claude';
}

function isClaudeMessagesPath(pathname) {
  return (
    pathname === '/v1/messages' ||
    pathname.indexOf('/v1/messages?') === 0 ||
    pathname === '/messages' ||
    pathname.indexOf('/messages?') === 0
  );
}

function shouldConvertClaudeMessagesToOpenAI(clientReq, profile, pathname) {
  return (
    isOpenAIProfile(profile) &&
    isClaudeMessagesPath(pathname) &&
    Boolean(clientReq.headers['anthropic-version'] || clientReq.headers['anthropic-beta'])
  );
}

function isOpenAIChatCompletionsPath(pathname) {
  return (
    pathname === '/v1/chat/completions' ||
    pathname.indexOf('/v1/chat/completions?') === 0 ||
    pathname === '/chat/completions' ||
    pathname.indexOf('/chat/completions?') === 0
  );
}

function isOpenAIResponsesPath(pathname) {
  return (
    pathname === '/v1/responses' ||
    pathname.indexOf('/v1/responses?') === 0 ||
    pathname === '/responses' ||
    pathname.indexOf('/responses?') === 0
  );
}

function isOpenAIImagesGenerationsPath(pathname) {
  return (
    pathname === '/v1/images/generations' ||
    pathname.indexOf('/v1/images/generations?') === 0 ||
    pathname === '/images/generations' ||
    pathname.indexOf('/images/generations?') === 0
  );
}

function isOpenAIImageJobsCollectionPath(pathname) {
  const normalized = String(pathname || '').split('?')[0];
  return normalized === '/v1/image-jobs' || normalized === '/image-jobs';
}

function parseOpenAIImageJobId(pathname) {
  const normalized = String(pathname || '').split('?')[0];
  const match = normalized.match(/^\/(?:v1\/)?image-jobs\/(imgjob_[a-f0-9]{32})$/i);
  return match ? match[1].toLowerCase() : null;
}

function isOpenAIImageJobsPath(pathname) {
  return isOpenAIImageJobsCollectionPath(pathname) || Boolean(parseOpenAIImageJobId(pathname));
}

function isConversationRequestPath(method, pathname) {
  return (
    method === 'POST' &&
    (isClaudeMessagesPath(pathname) ||
      isOpenAIChatCompletionsPath(pathname) ||
      isOpenAIImagesGenerationsPath(pathname) ||
      isOpenAIImageJobsCollectionPath(pathname) ||
      isOpenAIResponsesPath(pathname))
  );
}

function prepareRequestBuffer(buffer, encoding, activeProfile, resolveRouteForModel) {
  if (encoding)
    return {
      buffer,
      model: '-',
      routed: false,
      rewriteTo: '-',
      profile: activeProfile,
      route: null,
    };

  try {
    const parsed = JSON.parse(buffer.toString('utf8'));
    const model = parsed && parsed.model ? String(parsed.model) : '-';
    const resolved = resolveRouteForModel(model);
    if (resolved.route) {
      if (resolved.route.to && resolved.route.to !== '*') parsed.model = resolved.route.to;
      return {
        buffer: Buffer.from(JSON.stringify(parsed)),
        model,
        routed: true,
        rewriteTo: parsed.model,
        profile: resolved.profile,
        route: resolved.route,
      };
    }
    return { buffer, model, routed: false, rewriteTo: '-', profile: resolved.profile, route: null };
  } catch (err) {
    return {
      buffer,
      model: '-',
      routed: false,
      rewriteTo: '-',
      profile: activeProfile,
      route: null,
    };
  }
}

function createRuntimeRouting({
  getState,
  handleLocalModelsRequest,
  prepareRequestBufferForRoute = prepareRequestBuffer,
  resolveRouteForModel = resolveRoute,
} = {}) {
  if (typeof getState !== 'function') throw new TypeError('createRuntimeRouting requires getState');
  function resolveActiveRoute(model, desktop = false) {
    const state = getState();
    return resolveRouteForModel(
      model,
      desktop ? state.CLAUDE_DESKTOP_ROUTES : state.MODEL_ROUTES,
      state.PROFILES,
      state.ACTIVE_PROFILE
    );
  }
  return {
    resolveRoute: (model) => resolveActiveRoute(model),
    resolveClaudeDesktopRoute: (model) => resolveActiveRoute(model, true),
    handleModelsRequest: (clientReq, clientRes, requestInfo, forcedFormat) => {
      const state = getState();
      return handleLocalModelsRequest(
        clientReq,
        clientRes,
        requestInfo,
        state.MODEL_ROUTES,
        forcedFormat
      );
    },
    prepareRequestBuffer: (buffer, encoding) => {
      const state = getState();
      return prepareRequestBufferForRoute(buffer, encoding, state.ACTIVE_PROFILE, (model) =>
        resolveActiveRoute(model)
      );
    },
    prepareRequestBufferWithResolver: (buffer, encoding, resolver) => {
      const state = getState();
      return prepareRequestBufferForRoute(
        buffer,
        encoding,
        state.ACTIVE_PROFILE,
        resolver || ((model) => resolveActiveRoute(model))
      );
    },
  };
}

function logModelMapping(kind, method, upstreamPath, prepared, logProxyEvent) {
  const protocol = prepared.profile.protocol || 'openai';
  const profileName = prepared.profile.name || prepared.profile.id || 'default';
  const requestedModel = prepared.model || '-';
  const routeFrom = prepared.route && prepared.route.from ? String(prepared.route.from) : null;
  const sourceModel =
    routeFrom && (routeFrom === '*' || routeFrom.toLowerCase() === 'default')
      ? 'default'
      : requestedModel;
  const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : requestedModel;
  safeLog.info(
    'route mapping [' +
      kind +
      '] ' +
      method +
      ' ' +
      upstreamPath +
      ' source=' +
      sourceModel +
      ' -> protocol=' +
      protocol +
      ' profile=' +
      prepared.profile.id +
      ' (' +
      profileName +
      ') target=' +
      targetModel +
      ' requested=' +
      requestedModel +
      ' url=' +
      prepared.profile.targetUrl
  );

  logProxyEvent('route', {
    method,
    path: upstreamPath,
    sourceModel,
    targetModel,
    requestedModel,
    protocol,
    profileId: prepared.profile.id,
    profileName,
    estimatedContextTokens: prepared.estimatedContextTokens || 0,
  });
}

module.exports = {
  parseTargetUrl,
  routeMatchScore,
  resolveRoute,
  resetRouteIndex,
  rebuildRouteIndex,
  isGeminiProfile,
  isOpenAIProfile,
  isClaudeProfile,
  shouldConvertResponsesToOpenAIChat,
  isClaudeMessagesPath,
  isConversationRequestPath,
  shouldConvertClaudeMessagesToOpenAI,
  isOpenAIChatCompletionsPath,
  isOpenAIImageJobsCollectionPath,
  isOpenAIImageJobsPath,
  isOpenAIImagesGenerationsPath,
  parseOpenAIImageJobId,
  isOpenAIResponsesPath,
  prepareRequestBuffer,
  createRuntimeRouting,
  logModelMapping,
};
