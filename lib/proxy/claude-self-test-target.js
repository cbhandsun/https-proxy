function appendClaudeMessagesPath(baseUrl) {
  const normalized = String(baseUrl || '').replace(/\/+$/, '');
  if (!normalized) return '';
  return /\/v1$/i.test(normalized) ? normalized + '/messages' : normalized + '/v1/messages';
}

function createClaudeSelfTestTargetResolver(dependencies = {}) {
  const {
    claudeDesktopBaseUrl,
    claudeDesktopProxyPrefix,
    getClaudeDesktopGatewayConfig,
    getClaudeDesktopRoutes,
    getClaudeDesktopTraeProcessStyle,
    getConfig,
    getProfiles,
    isTraeOfficialProfile,
    isTraeOfficialTarget,
  } = dependencies;
  if (typeof getConfig !== 'function' || typeof getProfiles !== 'function') {
    throw new TypeError('createClaudeSelfTestTargetResolver requires runtime getters');
  }

  return function getClaudeDesktopSelfTestTarget() {
    const config = getConfig();
    const profiles = getProfiles();
    const routes = getClaudeDesktopRoutes(config);
    if (!Array.isArray(routes) || routes.length === 0) return null;
    const route =
      routes.find((item) => {
        const profile = profiles.find((candidate) => candidate?.id === item.profileId) || {};
        return isTraeOfficialProfile(profile) || isTraeOfficialTarget(profile.targetUrl);
      }) || routes[0];
    if (!route?.from) return null;

    const gateway = getClaudeDesktopGatewayConfig();
    let baseUrl = '';
    let token = '';
    if (gateway?.isLocalProxy && gateway.baseUrl) {
      baseUrl = gateway.baseUrl;
      token = gateway.token || '';
    } else {
      baseUrl = claudeDesktopBaseUrl(config) + claudeDesktopProxyPrefix;
      token = typeof config?.claudeDesktop?.token === 'string' ? config.claudeDesktop.token : '';
    }

    const endpoint = appendClaudeMessagesPath(baseUrl);
    if (!endpoint) return null;
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (token) headers.Authorization = 'Bearer ' + token;
    const profile = profiles.find((item) => item?.id === route.profileId) || {};
    return {
      source: gateway?.isLocalProxy
        ? 'claude-desktop-gateway'
        : 'configured-claude-desktop-gateway',
      endpoint,
      headers,
      model: route.from,
      expectedStyle: getClaudeDesktopTraeProcessStyle(config),
      route: {
        from: route.from,
        profileId: route.profileId,
        profileProtocol: profile.protocol || '',
        targetUrl: profile.targetUrl || '',
        isTraeOfficial: isTraeOfficialProfile(profile) || isTraeOfficialTarget(profile.targetUrl),
      },
    };
  };
}

module.exports = { appendClaudeMessagesPath, createClaudeSelfTestTargetResolver };
