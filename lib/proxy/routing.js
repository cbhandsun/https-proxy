const { DEFAULT_CONFIG } = require('./config');
const { shouldConvertResponsesToOpenAIChat } = require('./responses-routing-policy');
const { isOpenAIInputTokensPath } = require('./openai-context-management');
const { createRouteIndex } = require('./route-index');
const { parsePortOrDefault } = require('./management-utils');
const { decompressBodyBuffer } = require('./request-utils');
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
    profile.protocol === 'workbuddy' ||
    profile.protocol === 'tianxi'
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

function extractModelFromHintHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const routingHint = headers['x-codex-routing-hint'];
  if (typeof routingHint === 'string') {
    const match = routingHint.match(/(?:^|[;\s,])model=([^\s;,]+)/i);
    if (match && match[1]) return match[1].trim();
  }
  const turnMetadata = headers['x-codex-turn-metadata'];
  if (typeof turnMetadata === 'string') {
    try {
      const parsed = JSON.parse(turnMetadata);
      if (parsed && parsed.model) return String(parsed.model).trim();
    } catch (_) {}
  }
  return null;
}

function prepareRequestBuffer(buffer, encoding, activeProfile, resolveRouteForModel, options = {}) {
  const headers = options && options.headers;
  const hintModel = extractModelFromHintHeaders(headers);

  let decompressedBuffer = null;
  let parsed = null;
  let model = hintModel || '-';

  if (!encoding || encoding === 'identity') {
    try {
      parsed = JSON.parse(buffer.toString('utf8'));
      if (parsed && parsed.model) model = String(parsed.model);
    } catch (_) {}
  } else {
    try {
      decompressedBuffer = decompressBodyBuffer(buffer, encoding);
      if (
        decompressedBuffer &&
        Buffer.isBuffer(decompressedBuffer) &&
        decompressedBuffer !== buffer
      ) {
        parsed = JSON.parse(decompressedBuffer.toString('utf8'));
        if (parsed && parsed.model) model = String(parsed.model);
      }
    } catch (_) {}
  }

  if (model === '-' && !parsed) {
    return {
      buffer,
      model: '-',
      routed: false,
      rewriteTo: '-',
      profile: activeProfile,
      route: null,
    };
  }

  try {
    const resolved = resolveRouteForModel(model);
    if (resolved && resolved.route) {
      const route = resolved.route;
      const willRewrite = route.to && route.to !== '*' && route.to !== model;
      if (willRewrite && parsed) {
        parsed.model = route.to;
        const rewrittenBuffer = Buffer.from(JSON.stringify(parsed));
        return {
          buffer: rewrittenBuffer,
          model,
          routed: true,
          rewriteTo: parsed.model,
          profile: resolved.profile,
          route,
          decompressed: true,
          decompressedBuffer: rewrittenBuffer,
          bodyChanged: true,
        };
      }
      return {
        buffer,
        model,
        routed: true,
        rewriteTo: route.to && route.to !== '*' ? route.to : model,
        profile: resolved.profile,
        route,
        decompressedBuffer,
      };
    }
    return {
      buffer,
      model,
      routed: false,
      rewriteTo: '-',
      profile: (resolved && resolved.profile) || activeProfile,
      route: null,
      decompressedBuffer,
    };
  } catch (err) {
    return {
      buffer,
      model: '-',
      routed: false,
      rewriteTo: '-',
      profile: activeProfile,
      route: null,
      decompressedBuffer,
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
    prepareRequestBuffer: (buffer, encoding, options) => {
      const state = getState();
      return prepareRequestBufferForRoute(
        buffer,
        encoding,
        state.ACTIVE_PROFILE,
        (model) => resolveActiveRoute(model),
        options
      );
    },
    prepareRequestBufferWithResolver: (buffer, encoding, resolver, options) => {
      const state = getState();
      return prepareRequestBufferForRoute(
        buffer,
        encoding,
        state.ACTIVE_PROFILE,
        resolver || ((model) => resolveActiveRoute(model)),
        options
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
    // Oversized bodies are captured truncated, so the estimate is derived from the
    // full decoded length and reported as a lower bound ("at least N tokens").
    contextEstimateTruncated: prepared.contextEstimateTruncated === true,
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
  isOpenAIInputTokensPath,
  prepareRequestBuffer,
  createRuntimeRouting,
  logModelMapping,
};
