const net = require('net');
const { MAX_ROUTING_PATTERN_CHARS, compileSafeRoutingPattern } = require('./safe-routing-pattern');
const { isPublicIpAddress } = require('./external-ingress-probe');

function validateConfig(config, options = {}) {
  const errors = [];
  const warnings = [];

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { valid: false, errors: ['config must be an object'], warnings };
  }

  if (!config.activeProfile) errors.push('Missing activeProfile');

  const profileIds = new Set();
  if (!Array.isArray(config.profiles)) {
    errors.push('profiles must be an array');
  } else {
    if (config.profiles.length === 0) errors.push('profiles must contain at least one profile');
    if (config.profiles.length > 64) errors.push('profiles must contain at most 64 profiles');
    config.profiles.forEach((p, i) => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        errors.push(`Profile [${i}] must be an object`);
        return;
      }
      if (!p.id) errors.push(`Profile [${i}] is missing id`);
      else if (!isSafeIdentifier(p.id)) errors.push(`Profile [${i}] has invalid id`);
      if (p.id && profileIds.has(p.id)) errors.push(`Profile [${p.id}] is duplicated`);
      if (p.id) profileIds.add(p.id);
      if (!p.protocol) errors.push(`Profile [${p.id || i}] is missing protocol`);
      else if (!['openai', 'gemini', 'claude', 'trae', 'workbuddy'].includes(String(p.protocol))) {
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
          if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
            if (
              p.allowInsecureHttpUpstream !== true &&
              options.allowLegacyInsecureHttpUpstream !== true
            ) {
              errors.push(
                `Profile [${p.id || i}] non-loopback HTTP upstream requires allowInsecureHttpUpstream=true`
              );
            } else {
              warnings.push(
                `Profile [${p.id || i}] allows a non-loopback HTTP upstream; credentials may be exposed in transit`
              );
            }
          }
        } catch (err) {}
      }
      if (p.name != null && String(p.name).length > 256)
        errors.push(`Profile [${p.id || i}] name is too long`);
      if (p.apiKey != null && String(p.apiKey).length > 4096)
        errors.push(`Profile [${p.id || i}] apiKey is too long`);
      if (p.apiKey != null && /[\r\n]/.test(String(p.apiKey)))
        errors.push(`Profile [${p.id || i}] apiKey is invalid`);
      validateOptionalBoolean(
        p.retryUnsafeRequests,
        `Profile [${p.id || i}].retryUnsafeRequests`,
        errors
      );
      validateOptionalBoolean(
        p.allowInsecureHttpUpstream,
        `Profile [${p.id || i}].allowInsecureHttpUpstream`,
        errors
      );
    });
    if (config.activeProfile && !profileIds.has(config.activeProfile)) {
      errors.push(`activeProfile [${config.activeProfile}] does not match any profile`);
    }
  }

  validateServerConfig(config.localServer, 'localServer', errors);
  if (config.entryServers != null && !Array.isArray(config.entryServers)) {
    errors.push('entryServers must be an array');
  } else if (Array.isArray(config.entryServers)) {
    if (config.entryServers.length > 32) {
      errors.push('entryServers must contain at most 32 servers');
    }
    config.entryServers.forEach((entry, i) =>
      validateServerConfig(entry, `entryServers[${i}]`, errors)
    );
  }

  validateModelRoutes(config.modelRoutes, profileIds, errors);
  validateClaudeDesktopConfig(config.claudeDesktop, profileIds, errors);
  validateAppSettings(config.appSettings, errors);
  validateDiagnosticsConfig(config.diagnostics, errors);
  validateProtocolOptions(config.protocolOptions, errors);
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateOptionalBoolean(value, label, errors) {
  if (value != null && typeof value !== 'boolean') {
    errors.push(`${label} must be a boolean`);
  }
}

function validateBoundedString(value, label, errors, maxLength, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) errors.push(`${label} is required`);
    return;
  }
  if (typeof value !== 'string') {
    errors.push(`${label} must be a string`);
    return;
  }
  if (value.length > maxLength) errors.push(`${label} is too long`);
  if (/[\r\n]/.test(value)) errors.push(`${label} must not contain line breaks`);
}

function validateHttpUrl(value, label, errors) {
  if (value == null || value === '') return;
  if (typeof value !== 'string' || value.length > 2048 || !isHttpUrl(value)) {
    errors.push(`${label} must be a valid http(s) URL`);
    return;
  }
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) errors.push(`${label} must not include credentials`);
  } catch (error) {}
}

function validateModelRoutes(modelRoutes, profileIds, errors = [], label = 'modelRoutes') {
  if (modelRoutes == null) return { valid: errors.length === 0, errors };
  if (!Array.isArray(modelRoutes)) {
    errors.push(`${label} must be an array`);
    return { valid: errors.length === 0, errors };
  }
  if (modelRoutes.length > 1024) errors.push(`${label} must contain at most 1024 routes`);

  const allowedClientProtocols = new Set(['claude', 'openai-chat', 'openai-responses']);
  modelRoutes.forEach((route, index) => {
    const routeLabel = `${label}[${index}]`;
    if (!isPlainObject(route)) {
      errors.push(`${routeLabel} must be an object`);
      return;
    }
    validateBoundedString(route.from, `${routeLabel}.from`, errors, 256, { required: true });
    validateBoundedString(route.to, `${routeLabel}.to`, errors, 256);
    validateBoundedString(route.labelOverride, `${routeLabel}.labelOverride`, errors, 256);
    validateBoundedString(route.group, `${routeLabel}.group`, errors, 64);
    if (
      route.group != null &&
      route.group !== '' &&
      (typeof route.group !== 'string' ||
        !/^[\p{L}\p{N}][\p{L}\p{N} .+_-]*$/u.test(route.group.trim()) ||
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(route.group.trim()))
    ) {
      errors.push(`${routeLabel}.group is invalid`);
    }
    validateOptionalBoolean(route.enabled, `${routeLabel}.enabled`, errors);
    validateOptionalBoolean(route.supports1m, `${routeLabel}.supports1m`, errors);

    if (route.profileId != null && route.profileId !== '') {
      if (!isSafeIdentifier(route.profileId)) errors.push(`${routeLabel}.profileId is invalid`);
      else if (profileIds.size > 0 && !profileIds.has(route.profileId)) {
        errors.push(`${routeLabel}.profileId does not match any profile`);
      }
    }
    if (route.clientProtocols != null) {
      if (!Array.isArray(route.clientProtocols)) {
        errors.push(`${routeLabel}.clientProtocols must be an array`);
      } else if (
        route.clientProtocols.length > 3 ||
        route.clientProtocols.some((protocol) => !allowedClientProtocols.has(String(protocol)))
      ) {
        errors.push(`${routeLabel}.clientProtocols contains unsupported protocol`);
      }
    }
  });
  return { valid: errors.length === 0, errors };
}

function validateClaudeDesktopConfig(
  claudeDesktop,
  profileIds,
  errors = [],
  label = 'claudeDesktop'
) {
  if (claudeDesktop == null) return { valid: errors.length === 0, errors };
  if (!isPlainObject(claudeDesktop)) {
    errors.push(`${label} must be an object`);
    return { valid: errors.length === 0, errors };
  }

  validateOptionalBoolean(claudeDesktop.enabled, `${label}.enabled`, errors);
  if (
    claudeDesktop.mode != null &&
    !['proxy', 'direct', 'official'].includes(String(claudeDesktop.mode))
  ) {
    errors.push(`${label}.mode is unsupported`);
  }
  validateBoundedString(claudeDesktop.profileName, `${label}.profileName`, errors, 256);
  validateBoundedString(claudeDesktop.token, `${label}.token`, errors, 4096);
  validateBoundedString(claudeDesktop.directApiKey, `${label}.directApiKey`, errors, 4096);
  validateHttpUrl(claudeDesktop.baseUrl, `${label}.baseUrl`, errors);
  validateHttpUrl(claudeDesktop.directBaseUrl, `${label}.directBaseUrl`, errors);
  if (
    claudeDesktop.traeProcessStyle != null &&
    !['', 'auto', 'text', 'thinking', 'off'].includes(String(claudeDesktop.traeProcessStyle))
  ) {
    errors.push(`${label}.traeProcessStyle is unsupported`);
  }

  if (claudeDesktop.models != null && !Array.isArray(claudeDesktop.models)) {
    errors.push(`${label}.models must be an array`);
  } else if (Array.isArray(claudeDesktop.models)) {
    if (claudeDesktop.models.length > 64) {
      errors.push(`${label}.models must contain at most 64 models`);
    }
    claudeDesktop.models.forEach((model, index) => {
      const modelLabel = `${label}.models[${index}]`;
      if (!isPlainObject(model)) {
        errors.push(`${modelLabel} must be an object`);
        return;
      }
      validateBoundedString(model.routeId, `${modelLabel}.routeId`, errors, 256);
      validateBoundedString(model.from, `${modelLabel}.from`, errors, 256);
      validateBoundedString(model.upstreamModel, `${modelLabel}.upstreamModel`, errors, 256);
      validateBoundedString(model.to, `${modelLabel}.to`, errors, 256);
      validateBoundedString(model.labelOverride, `${modelLabel}.labelOverride`, errors, 256);
      validateOptionalBoolean(model.supports1m, `${modelLabel}.supports1m`, errors);
      validateOptionalBoolean(model.enabled, `${modelLabel}.enabled`, errors);
      if (model.profileId != null && model.profileId !== '') {
        if (!isSafeIdentifier(model.profileId)) errors.push(`${modelLabel}.profileId is invalid`);
        else if (profileIds.size > 0 && !profileIds.has(model.profileId)) {
          errors.push(`${modelLabel}.profileId does not match any profile`);
        }
      }
    });
  }
  return { valid: errors.length === 0, errors };
}

function validateAppSettings(appSettings, errors = [], label = 'appSettings') {
  if (appSettings == null) return { valid: errors.length === 0, errors };
  if (!isPlainObject(appSettings)) {
    errors.push(`${label} must be an object`);
    return { valid: errors.length === 0, errors };
  }
  for (const key of [
    'autoStartProxy',
    'closeToTray',
    'showTopMenu',
    'showTrayMenu',
    'showWindowOnTrayCommand',
    'stopProxyOnExit',
    'desktopNotifications',
    'disableLocalProxy',
    'verifyUpstreamTls',
    'conversationAuditEnabled',
    'conversationAuditCaptureContent',
    'forceResponseStreaming',
    'forceChatStreaming',
    'upstreamWarmupEnabled',
    'streamDirectRequestBodies',
    'performanceMode',
    'launchOnLogin',
  ]) {
    validateOptionalBoolean(appSettings[key], `${label}.${key}`, errors);
  }
  validateOptionalNumber(
    appSettings.responseStreamingRolloutPercent,
    `${label}.responseStreamingRolloutPercent`,
    errors,
    { min: 0, max: 100 }
  );
  validateOptionalNumber(
    appSettings.upstreamWarmupIntervalMs,
    `${label}.upstreamWarmupIntervalMs`,
    errors,
    { min: 1000, max: 86400000 }
  );
  validateOptionalNumber(
    appSettings.upstreamWarmupMaxTargets,
    `${label}.upstreamWarmupMaxTargets`,
    errors,
    { min: 1, max: 100 }
  );
  validateOptionalNumber(
    appSettings.upstreamWarmupStaggerMs,
    `${label}.upstreamWarmupStaggerMs`,
    errors,
    { min: 0, max: 5000 }
  );
  return { valid: errors.length === 0, errors };
}

function validateDiagnosticsConfig(diagnostics, errors = [], label = 'diagnostics') {
  if (diagnostics == null) return { valid: errors.length === 0, errors };
  if (!isPlainObject(diagnostics)) {
    errors.push(`${label} must be an object`);
    return { valid: errors.length === 0, errors };
  }
  validateOptionalBoolean(diagnostics.enabled, `${label}.enabled`, errors);
  if (diagnostics.externalIngressUrl != null && diagnostics.externalIngressUrl !== '') {
    const urlStr = String(diagnostics.externalIngressUrl);
    try {
      const parsed = new URL(urlStr);
      if (parsed.protocol !== 'https:') {
        errors.push(`${label}.externalIngressUrl must use HTTPS`);
      }
      if (parsed.username || parsed.password) {
        errors.push(`${label}.externalIngressUrl must not include credentials`);
      }
      if (parsed.search || parsed.hash) {
        errors.push(`${label}.externalIngressUrl must not include a query or fragment`);
      }
      if (parsed.port && parsed.port !== '443') {
        errors.push(`${label}.externalIngressUrl must use the standard HTTPS port`);
      }
      if (net.isIP(parsed.hostname) && !isPublicIpAddress(parsed.hostname)) {
        errors.push(`${label}.externalIngressUrl must resolve to a publicly accessible IP address`);
      }
    } catch (e) {
      errors.push(`${label}.externalIngressUrl is invalid`);
    }
  }
  validateOptionalNumber(
    diagnostics.externalIngressTimeoutMs,
    `${label}.externalIngressTimeoutMs`,
    errors,
    { min: 500, max: 60000 }
  );
  return { valid: errors.length === 0, errors };
}

function validateProtocolOptions(protocolOptions, errors = [], label = 'protocolOptions') {
  if (protocolOptions == null) return { valid: errors.length === 0, errors };
  if (!isPlainObject(protocolOptions)) {
    errors.push(`${label} must be an object`);
    return { valid: errors.length === 0, errors };
  }
  if (
    protocolOptions.thinkingPolicy != null &&
    !['drop', 'placeholder', 'inject', 'passthrough'].includes(
      String(protocolOptions.thinkingPolicy)
    )
  ) {
    errors.push(`${label}.thinkingPolicy is unsupported`);
  }
  if (
    protocolOptions.contextWindowPolicy != null &&
    !['overflow-drop-oldest', 'disabled', 'none'].includes(
      String(protocolOptions.contextWindowPolicy)
    )
  ) {
    errors.push(`${label}.contextWindowPolicy is unsupported`);
  }
  validateOptionalBoolean(
    protocolOptions.preserveClaudeMessageShape,
    `${label}.preserveClaudeMessageShape`,
    errors
  );
  validateOptionalBoolean(protocolOptions.stableToolUseIds, `${label}.stableToolUseIds`, errors);
  validateOptionalNumber(protocolOptions.maxContextTokens, `${label}.maxContextTokens`, errors, {
    min: 0,
    max: 10_000_000,
  });
  validateOptionalNumber(protocolOptions.maxSseBufferChars, `${label}.maxSseBufferChars`, errors, {
    min: 1,
    max: 4 * 1024 * 1024,
  });
  validateOptionalNumber(
    protocolOptions.openaiToGeminiMaxToolResults,
    `${label}.openaiToGeminiMaxToolResults`,
    errors,
    { min: 0, max: 10_000 }
  );
  return { valid: errors.length === 0, errors };
}

function validateMcpHubConfig(mcpHub, errors = [], label = 'mcpHub') {
  if (!mcpHub) return { valid: errors.length === 0, errors };
  if (!isPlainObject(mcpHub)) {
    errors.push(`${label} must be an object`);
    return { valid: errors.length === 0, errors };
  }
  if (!Array.isArray(mcpHub.servers)) errors.push(`${label}.servers must be an array`);
  if (!Array.isArray(mcpHub.routing)) errors.push(`${label}.routing must be an array`);
  if (!Array.isArray(mcpHub.servers) || !Array.isArray(mcpHub.routing)) {
    return { valid: errors.length === 0, errors };
  }

  if (mcpHub.servers.length > 32) errors.push(`${label}.servers must contain at most 32 servers`);
  if (mcpHub.routing.length > 256) errors.push(`${label}.routing must contain at most 256 routes`);

  const serverIds = new Set();
  mcpHub.servers.forEach((server, i) => {
    if (!isPlainObject(server)) {
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
    if (!server.url || String(server.url).length > 2048 || !isHttpUrl(server.url)) {
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
      const compiled = compileSafeRoutingPattern(pattern);
      if (!compiled.ok) {
        const detail =
          pattern.length > MAX_ROUTING_PATTERN_CHARS ? 'pattern is too long' : compiled.error;
        errors.push(`${routeLabel}.${detail}`);
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
  if (entryAuth.allowedOrigins != null) {
    if (!Array.isArray(entryAuth.allowedOrigins)) {
      errors.push(`${label}.allowedOrigins must be an array`);
    } else {
      if (entryAuth.allowedOrigins.length > 32) {
        errors.push(`${label}.allowedOrigins must contain at most 32 origins`);
      }
      const origins = new Set();
      entryAuth.allowedOrigins.forEach((origin, index) => {
        const originLabel = `${label}.allowedOrigins[${index}]`;
        if (typeof origin !== 'string' || origin.length > 2048) {
          errors.push(`${originLabel} is invalid`);
          return;
        }
        try {
          const parsed = new URL(origin);
          if (
            !['http:', 'https:'].includes(parsed.protocol) ||
            parsed.origin !== origin ||
            origins.has(origin)
          ) {
            errors.push(`${originLabel} is invalid`);
          } else {
            origins.add(origin);
          }
        } catch (error) {
          errors.push(`${originLabel} is invalid`);
        }
      });
    }
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
  if (!isPlainObject(server)) {
    errors.push(`${label} must be an object`);
    return;
  }
  validateOptionalBoolean(server.enabled, `${label}.enabled`, errors);
  validateOptionalBoolean(server.tls, `${label}.tls`, errors);
  validateBoundedString(server.name, `${label}.name`, errors, 256);
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
  if (server.managementPort != null) {
    const managementPort = Number(server.managementPort);
    if (!Number.isInteger(managementPort) || managementPort <= 0 || managementPort > 65535) {
      errors.push(`${label}.managementPort must be between 1 and 65535`);
    }
  }
  if (server.basePath && !String(server.basePath).startsWith('/')) {
    errors.push(`${label}.basePath must start with /`);
  }
  if (server.basePath && String(server.basePath).length > 1024) {
    errors.push(`${label}.basePath is too long`);
  }
  if (
    server.protocol != null &&
    !['claude', 'claude-desktop', 'openai-chat', 'openai-responses'].includes(
      String(server.protocol)
    )
  ) {
    errors.push(`${label}.protocol is unsupported`);
  }
}

module.exports = {
  validateConfig,
  validateModelRoutes,
  validateClaudeDesktopConfig,
  validateAppSettings,
  validateDiagnosticsConfig,
  validateProtocolOptions,
  validateMcpHubConfig,
  validateEntryAuthConfig,
  isLoopbackHost,
};
