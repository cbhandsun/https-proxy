function validateConfig(config) {
  const errors = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['config must be an object'] };
  }

  if (!config.activeProfile) errors.push('Missing activeProfile');

  if (!Array.isArray(config.profiles)) {
    errors.push('profiles must be an array');
  } else {
    const ids = new Set();
    config.profiles.forEach((p, i) => {
      if (!p.id) errors.push(`Profile [${i}] is missing id`);
      if (p.id && ids.has(p.id)) errors.push(`Profile [${p.id}] is duplicated`);
      if (p.id) ids.add(p.id);
      if (!p.protocol) errors.push(`Profile [${p.id || i}] is missing protocol`);
      else if (!['openai', 'gemini', 'claude', 'trae'].includes(String(p.protocol))) {
        errors.push(`Profile [${p.id || i}] has unsupported protocol`);
      }
      if (p.targetUrl && !isHttpUrl(p.targetUrl)) {
        errors.push(`Profile [${p.id || i}] has invalid targetUrl`);
      }
    });
    if (config.activeProfile && !ids.has(config.activeProfile)) {
      errors.push(`activeProfile [${config.activeProfile}] does not match any profile`);
    }
  }

  validateServerConfig(config.localServer, 'localServer', errors);
  if (Array.isArray(config.entryServers)) {
    config.entryServers.forEach((entry, i) =>
      validateServerConfig(entry, `entryServers[${i}]`, errors)
    );
  }

  validateMcpHubConfig(config.mcpHub, errors);

  return {
    valid: errors.length === 0,
    errors,
  };
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

function isSafeIdentifier(value) {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(String(value || ''));
}

function validateOptionalNumber(
  value,
  label,
  errors,
  { min = 0, max = Number.MAX_SAFE_INTEGER } = {}
) {
  if (value == null || value === '') return;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
    errors.push(`${label} must be between ${min} and ${max}`);
  }
}

function validateMcpHubConfig(mcpHub, errors = [], label = 'mcpHub') {
  if (!mcpHub) return { valid: errors.length === 0, errors };
  if (!Array.isArray(mcpHub.servers)) errors.push(`${label}.servers must be an array`);
  if (!Array.isArray(mcpHub.routing)) errors.push(`${label}.routing must be an array`);
  if (!Array.isArray(mcpHub.servers) || !Array.isArray(mcpHub.routing)) {
    return { valid: errors.length === 0, errors };
  }

  if (mcpHub.servers.length > 32) errors.push(`${label}.servers must contain at most 32 servers`);
  if (mcpHub.routing.length > 256) errors.push(`${label}.routing must contain at most 256 routes`);

  const serverIds = new Set();
  mcpHub.servers.forEach((server, i) => {
    if (!server || typeof server !== 'object') {
      errors.push(`${label}.servers[${i}] must be an object`);
      return;
    }
    const serverLabel = `${label}.servers[${i}]`;
    if (server.id != null && server.id !== '') {
      const id = String(server.id);
      if (!isSafeIdentifier(id)) errors.push(`${serverLabel}.id is invalid`);
      if (serverIds.has(id)) errors.push(`${serverLabel}.id is duplicated`);
      serverIds.add(id);
    }
    if (!server.url || !isHttpUrl(server.url)) {
      errors.push(`${serverLabel}.url must be http(s)`);
    } else {
      try {
        const parsed = new URL(String(server.url));
        if (parsed.username || parsed.password) {
          errors.push(`${serverLabel}.url must not include credentials`);
        }
      } catch (err) {}
    }
    if (
      server.prefix != null &&
      server.prefix !== '' &&
      !/^[A-Za-z0-9_]{1,64}$/.test(String(server.prefix))
    ) {
      errors.push(`${serverLabel}.prefix is invalid`);
    }
    validateOptionalNumber(server.timeoutMs, `${serverLabel}.timeoutMs`, errors, {
      min: 50,
      max: 120000,
    });
    validateOptionalNumber(server.cacheMs, `${serverLabel}.cacheMs`, errors, {
      min: 0,
      max: 3600000,
    });
    validateOptionalNumber(server.failureCacheMs, `${serverLabel}.failureCacheMs`, errors, {
      min: 0,
      max: 3600000,
    });
    validateOptionalNumber(server.maxRetries, `${serverLabel}.maxRetries`, errors, {
      min: 0,
      max: 10,
    });
    validateOptionalNumber(server.retryDelayMs, `${serverLabel}.retryDelayMs`, errors, {
      min: 0,
      max: 60000,
    });
  });

  mcpHub.routing.forEach((route, i) => {
    if (!route || typeof route !== 'object') {
      errors.push(`${label}.routing[${i}] must be an object`);
      return;
    }
    const routeLabel = `${label}.routing[${i}]`;
    const serverId = String(route.serverId || '');
    if (!serverId) {
      errors.push(`${routeLabel}.serverId is required`);
    } else if (!serverIds.has(serverId)) {
      errors.push(`${routeLabel}.serverId does not match any server`);
    }
    if (!route.toolName && !route.pattern) {
      errors.push(`${routeLabel}.toolName or pattern is required`);
    }
    if (
      route.toolName != null &&
      route.toolName !== '' &&
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(String(route.toolName))
    ) {
      errors.push(`${routeLabel}.toolName is invalid`);
    }
    if (route.pattern != null && route.pattern !== '') {
      const pattern = String(route.pattern);
      if (pattern.length > 256) errors.push(`${routeLabel}.pattern is too long`);
      try {
        new RegExp(pattern);
      } catch (err) {
        errors.push(`${routeLabel}.pattern is invalid`);
      }
    }
  });

  return { valid: errors.length === 0, errors };
}

function validateServerConfig(server, label, errors) {
  if (!server) return;
  if (server.host && /[\s/\\]/.test(String(server.host))) {
    errors.push(`${label}.host is invalid`);
  }
  const portValue = server.listenPort == null ? server.port : server.listenPort;
  if (portValue != null) {
    const port = Number(portValue);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      errors.push(`${label}.listenPort must be between 1 and 65535`);
    }
  }
  if (server.basePath && !String(server.basePath).startsWith('/')) {
    errors.push(`${label}.basePath must start with /`);
  }
}

module.exports = { validateConfig, validateMcpHubConfig };
