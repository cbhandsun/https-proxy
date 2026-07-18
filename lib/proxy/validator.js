function validateConfig(config) {
  const errors = [];
  const warnings = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['config must be an object'], warnings };
  }

  if (!config.activeProfile) errors.push('Missing activeProfile');

  if (!Array.isArray(config.profiles)) {
    errors.push('profiles must be an array');
  } else {
    if (config.profiles.length === 0) errors.push('profiles must contain at least one profile');
    if (config.profiles.length > 64) errors.push('profiles must contain at most 64 profiles');
    const ids = new Set();
    config.profiles.forEach((p, i) => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        errors.push(`Profile [${i}] must be an object`);
        return;
      }
      if (!p.id) errors.push(`Profile [${i}] is missing id`);
      else if (!isSafeIdentifier(p.id)) errors.push(`Profile [${i}] has invalid id`);
      if (p.id && ids.has(p.id)) errors.push(`Profile [${p.id}] is duplicated`);
      if (p.id) ids.add(p.id);
      if (!p.protocol) errors.push(`Profile [${p.id || i}] is missing protocol`);
      else if (!['openai', 'gemini', 'claude', 'trae'].includes(String(p.protocol))) {
        errors.push(`Profile [${p.id || i}] has unsupported protocol`);
      }
      if (p.targetUrl && !isHttpUrl(p.targetUrl)) {
        errors.push(`Profile [${p.id || i}] has invalid targetUrl`);
      } else if (p.targetUrl) {
        const targetUrl = String(p.targetUrl);
        if (targetUrl.length > 2048) errors.push(`Profile [${p.id || i}] targetUrl is too long`);
        try {
          const parsed = new URL(targetUrl);
          if (parsed.username || parsed.password) {
            errors.push(`Profile [${p.id || i}] targetUrl must not include credentials`);
          }
          if (
            parsed.protocol === 'http:' &&
            !isLoopbackHost(parsed.hostname) &&
            typeof p.apiKey === 'string' &&
            p.apiKey.length > 0
          ) {
            warnings.push(
              `Profile [${p.id || i}] sends credentials to a non-loopback HTTP upstream`
            );
          }
        } catch (err) {}
      }
      if (p.name != null && String(p.name).length > 256)
        errors.push(`Profile [${p.id || i}] name is too long`);
      if (p.apiKey != null && String(p.apiKey).length > 4096)
        errors.push(`Profile [${p.id || i}] apiKey is too long`);
      if (p.apiKey != null && /[\r\n]/.test(String(p.apiKey)))
        errors.push(`Profile [${p.id || i}] apiKey is invalid`);
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
  validateEntryAuthConfig(config.entryAuth, errors);
  const exposedServer = [
    config.localServer,
    ...(Array.isArray(config.entryServers) ? config.entryServers : []),
  ]
    .filter(Boolean)
    .find((server) => server.host && !isLoopbackHost(server.host));
  if (exposedServer && (!config.entryAuth || config.entryAuth.enabled !== true)) {
    errors.push('entryAuth.enabled must be true when a proxy entry listens on a non-loopback host');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function isLoopbackHost(value) {
  const host = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
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
    if (server.bearerToken != null && server.bearerToken !== '') {
      const token = String(server.bearerToken);
      if (token.length > 4096) errors.push(`${serverLabel}.bearerToken is too long`);
      if (/[\r\n]/.test(token)) errors.push(`${serverLabel}.bearerToken is invalid`);
    }
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

function validateEntryAuthConfig(entryAuth, errors = [], label = 'entryAuth') {
  if (!entryAuth) return { valid: errors.length === 0, errors };
  if (typeof entryAuth !== 'object' || Array.isArray(entryAuth)) {
    errors.push(`${label} must be an object`);
    return { valid: errors.length === 0, errors };
  }
  if (entryAuth.enabled != null && typeof entryAuth.enabled !== 'boolean') {
    errors.push(`${label}.enabled must be a boolean`);
  }
  if (!Array.isArray(entryAuth.keys)) {
    errors.push(`${label}.keys must be an array`);
    return { valid: errors.length === 0, errors };
  }
  if (entryAuth.keys.length > 128) errors.push(`${label}.keys must contain at most 128 keys`);
  const ids = new Set();
  entryAuth.keys.forEach((entryKey, index) => {
    const keyLabel = `${label}.keys[${index}]`;
    if (!entryKey || typeof entryKey !== 'object' || Array.isArray(entryKey)) {
      errors.push(`${keyLabel} must be an object`);
      return;
    }
    const id = String(entryKey.id || '');
    if (!id) errors.push(`${keyLabel}.id is required`);
    else if (!isSafeIdentifier(id)) errors.push(`${keyLabel}.id is invalid`);
    else if (ids.has(id)) errors.push(`${keyLabel}.id is duplicated`);
    else ids.add(id);
    if (entryKey.enabled != null && typeof entryKey.enabled !== 'boolean') {
      errors.push(`${keyLabel}.enabled must be a boolean`);
    }
    if (entryKey.key != null && entryKey.key !== '') {
      const keyValue = String(entryKey.key);
      if (keyValue.length > 4096) errors.push(`${keyLabel}.key is too long`);
      if (/[\r\n]/.test(keyValue)) errors.push(`${keyLabel}.key is invalid`);
    }
    if (entryKey.allowedEntryProtocols != null) {
      if (!Array.isArray(entryKey.allowedEntryProtocols)) {
        errors.push(`${keyLabel}.allowedEntryProtocols must be an array`);
      } else {
        const allowed = new Set(['claude', 'openai-responses', 'openai-chat', 'claude-desktop']);
        entryKey.allowedEntryProtocols.forEach((protocol) => {
          if (!allowed.has(String(protocol))) {
            errors.push(`${keyLabel}.allowedEntryProtocols contains unsupported protocol`);
          }
        });
      }
    }
    if (entryKey.allowedEntryPorts != null) {
      if (!Array.isArray(entryKey.allowedEntryPorts)) {
        errors.push(`${keyLabel}.allowedEntryPorts must be an array`);
      } else {
        entryKey.allowedEntryPorts.forEach((portValue) => {
          const port = Number(portValue);
          if (!Number.isInteger(port) || port <= 0 || port > 65535) {
            errors.push(`${keyLabel}.allowedEntryPorts contains invalid port`);
          }
        });
      }
    }
    if (entryKey.allowedProfileIds != null && !Array.isArray(entryKey.allowedProfileIds)) {
      errors.push(`${keyLabel}.allowedProfileIds must be an array`);
    }
  });
  return { valid: errors.length === 0, errors };
}

function validateServerConfig(server, label, errors) {
  if (!server) return;
  if (server.host && /[\s/\\]/.test(String(server.host))) {
    errors.push(`${label}.host is invalid`);
  }
  if (server.host && String(server.host).length > 253) errors.push(`${label}.host is too long`);
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

module.exports = { validateConfig, validateMcpHubConfig, validateEntryAuthConfig, isLoopbackHost };
