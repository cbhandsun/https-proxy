const { DEFAULT_CONFIG } = require('./config');

const TARGET_URL_CACHE_LIMIT = 256;
const WILDCARD_ROUTE_REGEX_CACHE_LIMIT = 1024;
const targetUrlCache = new Map();
const wildcardRouteRegexCache = new Map();

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
  let path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
  if (!path) {
    const host = parsed.hostname.toLowerCase();
    if (host === 'api.openai.com' || host === 'api.anthropic.com' || host === 'api.deepseek.com' || host === 'api.groq.com') {
      path = '/v1';
    }
  }
  const result = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80),
    path,
  };
  cacheSetWithLimit(targetUrlCache, cacheKey, result, TARGET_URL_CACHE_LIMIT);
  return { ...result };
}

function wildcardRouteMatcher(source) {
  const cached = wildcardRouteRegexCache.get(source);
  if (cached) return cached;

  const escaped = source.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  const matcher = {
    regex: new RegExp('^' + escaped + '$'),
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
  let best = null;
  const candidates = [];
  for (const item of modelRoutes) {
    if (!item || item.enabled === false) continue;
    const score = routeMatchScore(item.from, model);
    if (score < 0) continue;

    if (!best || score > best.score) {
      best = { route: item, score };
      candidates.length = 0;
      candidates.push(item);
    } else if (score === best.score) {
      candidates.push(item);
    }
  }

  if (!best) return { profile: activeProfile, route: null };

  // Load balancing: if multiple routes have the same best score, pick one randomly
  const selectedRoute = candidates.length > 1
    ? candidates[Math.floor(Math.random() * candidates.length)]
    : best.route;

  const profile = profiles.find((item) => item.id === selectedRoute.profileId) || activeProfile;
  return { profile, route: selectedRoute };
}

function isGeminiProfile(profile) {
  return profile && profile.protocol === 'gemini';
}

function isOpenAIProfile(profile) {
  return !profile
    || !profile.protocol
    || profile.protocol === 'openai'
    || profile.protocol === 'openai-chat'
    || profile.protocol === 'openai-responses';
}

function shouldConvertResponsesToOpenAIChat(profile) {
  if (!profile) return false;
  return profile.forceChatCompletions === true
    || profile.supportsResponses === false
    || profile.responsesMode === 'chat'
    || profile.responsesEndpoint === 'chat'
    || profile.protocol === 'openai-chat';
}

function isClaudeProfile(profile) {
  return profile && profile.protocol === 'claude';
}

function isClaudeMessagesPath(pathname) {
  return pathname === '/v1/messages' || pathname.indexOf('/v1/messages?') === 0 || pathname === '/messages' || pathname.indexOf('/messages?') === 0;
}

function shouldConvertClaudeMessagesToOpenAI(clientReq, profile, pathname) {
  return isOpenAIProfile(profile) && isClaudeMessagesPath(pathname) && Boolean(clientReq.headers['anthropic-version'] || clientReq.headers['anthropic-beta']);
}

function isOpenAIChatCompletionsPath(pathname) {
  return pathname === '/v1/chat/completions' || pathname.indexOf('/v1/chat/completions?') === 0 || pathname === '/chat/completions' || pathname.indexOf('/chat/completions?') === 0;
}

function isOpenAIResponsesPath(pathname) {
  return pathname === '/v1/responses' || pathname.indexOf('/v1/responses?') === 0 || pathname === '/responses' || pathname.indexOf('/responses?') === 0;
}

function prepareRequestBuffer(buffer, encoding, activeProfile, resolveRouteForModel) {
  if (encoding) return { buffer, model: '-', routed: false, rewriteTo: '-', profile: activeProfile, route: null };

  try {
    const parsed = JSON.parse(buffer.toString('utf8'));
    const model = parsed && parsed.model ? String(parsed.model) : '-';
    const resolved = resolveRouteForModel(model);
    if (resolved.route) {
      if (resolved.route.to && resolved.route.to !== '*') parsed.model = resolved.route.to;
      return { buffer: Buffer.from(JSON.stringify(parsed)), model, routed: true, rewriteTo: parsed.model, profile: resolved.profile, route: resolved.route };
    }
    return { buffer, model, routed: false, rewriteTo: '-', profile: resolved.profile, route: null };
  } catch (err) {
    return { buffer, model: '-', routed: false, rewriteTo: '-', profile: activeProfile, route: null };
  }
}

function logModelMapping(kind, method, upstreamPath, prepared, logProxyEvent) {
  const protocol = prepared.profile.protocol || 'openai';
  const profileName = prepared.profile.name || prepared.profile.id || 'default';
  const requestedModel = prepared.model || '-';
  const routeFrom = prepared.route && prepared.route.from ? String(prepared.route.from) : null;
  const sourceModel = routeFrom && (routeFrom === '*' || routeFrom.toLowerCase() === 'default') ? 'default' : requestedModel;
  const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : requestedModel;
  console.log('route mapping [' + kind + '] ' + method + ' ' + upstreamPath + ' source=' + sourceModel + ' -> protocol=' + protocol + ' profile=' + prepared.profile.id + ' (' + profileName + ') target=' + targetModel + ' requested=' + requestedModel + ' url=' + prepared.profile.targetUrl);

  logProxyEvent('route', {
    method,
    path: upstreamPath,
    sourceModel,
    targetModel,
    requestedModel,
    protocol,
    profileId: prepared.profile.id,
    profileName,
    estimatedContextTokens: prepared.estimatedContextTokens || 0
  });
}

module.exports = {
  parseTargetUrl,
  routeMatchScore,
  resolveRoute,
  isGeminiProfile,
  isOpenAIProfile,
  isClaudeProfile,
  shouldConvertResponsesToOpenAIChat,
  isClaudeMessagesPath,
  shouldConvertClaudeMessagesToOpenAI,
  isOpenAIChatCompletionsPath,
  isOpenAIResponsesPath,
  prepareRequestBuffer,
  logModelMapping,
};
