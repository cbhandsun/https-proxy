const { DEFAULT_CONFIG } = require('./config');

function parseTargetUrl(value) {
  const parsed = new URL(value || DEFAULT_CONFIG.profiles[0].targetUrl);
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, ''),
  };
}

function routeMatchScore(pattern, model) {
  if (!pattern || !model) return -1;
  const source = String(pattern).trim();
  const target = String(model).trim();
  if (!source) return -1;
  if (source === target) return 10000 + source.length;
  if (source === '*' || source.toLowerCase() === 'default') return 1;
  if (!source.includes('*')) return -1;
  const escaped = source.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + escaped + '$').test(target) ? 1000 + source.replace(/\*/g, '').length : -1;
}

function resolveRoute(model, modelRoutes, profiles, activeProfile) {
  let best = null;
  for (const item of modelRoutes) {
    if (!item || item.enabled === false) continue;
    const score = routeMatchScore(item.from, model);
    if (score < 0) continue;
    if (!best || score > best.score) best = { route: item, score };
  }
  if (!best) return { profile: activeProfile, route: null };
  const profile = profiles.find((item) => item.id === best.route.profileId) || activeProfile;
  return { profile, route: best.route };
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
    profileName
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
