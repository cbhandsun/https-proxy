const fs = require('fs');

const {
  CONFIG_FILE,
  loadConfig,
  encryptConfigSecretsForStorage,
  encryptKey,
} = require('../config');
const { readJsonBodyFromRequest, writeJsonFileAtomically } = require('../management-utils');
const { validateConfig } = require('../validator');

function redactConfigSecrets(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactConfigSecrets);
  const cloned = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      /^(apiKey|directApiKey|key|token|secret|authorization|password|refreshToken|accessToken|idToken)$/i.test(
        key
      )
    ) {
      cloned[key] = child ? '[redacted]' : child;
    } else {
      cloned[key] = redactConfigSecrets(child);
    }
  }
  return cloned;
}

function requireConfigObjectBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'JSON body must be an object' };
  }
  return { ok: true, body };
}

function createManagementConfigHandlers({
  sendJson,
  reloadProxyConfig,
  configFile = CONFIG_FILE,
  loadConfigFn = loadConfig,
  encryptConfigForStorage = encryptConfigSecretsForStorage,
} = {}) {
  if (typeof sendJson !== 'function') throw new Error('sendJson is required');
  if (typeof reloadProxyConfig !== 'function') throw new Error('reloadProxyConfig is required');

  function writeConfigFileAtomically(nextConfig) {
    writeJsonFileAtomically(configFile, encryptConfigForStorage(nextConfig));
  }

  function handleLocalGetConfigRequest(clientReq, clientRes) {
    try {
      const rawConfig = loadConfigFn();
      const cloned = redactConfigSecrets(JSON.parse(JSON.stringify(rawConfig)));
      sendJson(clientRes, 200, cloned);
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalEntryAuthKeyRevealRequest(clientReq, clientRes) {
    readJsonBodyFromRequest(clientReq, (bodyErr, body) => {
      if (bodyErr) {
        sendJson(clientRes, 400, { ok: false, error: bodyErr.message });
        return;
      }
      try {
        const bodyResult = requireConfigObjectBody(body);
        if (!bodyResult.ok) {
          sendJson(clientRes, 400, { ok: false, error: bodyResult.error });
          return;
        }
        const keyId = String(body.keyId || body.id || '').trim();
        if (!keyId) {
          sendJson(clientRes, 400, { ok: false, error: 'keyId is required' });
          return;
        }
        const config = loadConfigFn();
        const keys =
          config && config.entryAuth && Array.isArray(config.entryAuth.keys)
            ? config.entryAuth.keys
            : [];
        const entryKey = keys.find((item) => item && String(item.id || '').trim() === keyId);
        if (!entryKey || typeof entryKey.key !== 'string' || !entryKey.key) {
          sendJson(clientRes, 404, { ok: false, error: 'Entry key not found' });
          return;
        }
        sendJson(clientRes, 200, { ok: true, keyId, key: entryKey.key });
      } catch (err) {
        sendJson(clientRes, 500, { ok: false, error: err.message });
      }
    });
  }

  function handleLocalSaveConfigRequest(clientReq, clientRes) {
    readJsonBodyFromRequest(clientReq, (bodyErr, newConfig) => {
      if (bodyErr) {
        sendJson(clientRes, 400, { error: bodyErr.message });
        return;
      }
      try {
        const bodyResult = requireConfigObjectBody(newConfig);
        if (!bodyResult.ok) {
          sendJson(clientRes, 400, { error: bodyResult.error });
          return;
        }

        const validation = validateConfig(newConfig);
        if (!validation.valid) {
          sendJson(clientRes, 400, {
            error: 'Invalid configuration: ' + validation.errors.join(', '),
          });
          return;
        }

        let currentRaw = {};
        try {
          if (fs.existsSync(configFile)) {
            currentRaw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
          }
        } catch (err) {}

        if (newConfig && Array.isArray(newConfig.profiles)) {
          for (const profile of newConfig.profiles) {
            if (!profile) continue;
            const currentProfile = (currentRaw.profiles || []).find(
              (item) => item && item.id === profile.id
            );
            if (profile.apiKey === '[redacted]' || profile.apiKey === '***') {
              profile.apiKey = currentProfile ? currentProfile.apiKey : '';
            }
            if (
              profile.apiKey &&
              !profile.apiKey.startsWith('hpm-enc:') &&
              !profile.apiKey.startsWith('hpm-dpapi:')
            ) {
              profile.apiKey = encryptKey(profile.apiKey);
            }
          }
        }

        if (newConfig && newConfig.claudeDesktop) {
          if (
            newConfig.claudeDesktop.token === '[redacted]' ||
            newConfig.claudeDesktop.token === '***'
          ) {
            newConfig.claudeDesktop.token =
              (currentRaw.claudeDesktop && currentRaw.claudeDesktop.token) || '';
          }
          if (
            newConfig.claudeDesktop.directApiKey === '[redacted]' ||
            newConfig.claudeDesktop.directApiKey === '***'
          ) {
            newConfig.claudeDesktop.directApiKey =
              (currentRaw.claudeDesktop && currentRaw.claudeDesktop.directApiKey) || '';
          }
        }

        if (newConfig && newConfig.mcpHub && Array.isArray(newConfig.mcpHub.servers)) {
          const currentServers =
            currentRaw.mcpHub && Array.isArray(currentRaw.mcpHub.servers)
              ? currentRaw.mcpHub.servers
              : [];
          for (const server of newConfig.mcpHub.servers) {
            if (!server) continue;
            const currentServer = currentServers.find((item) => item && item.id === server.id);
            if (server.bearerToken === '[redacted]' || server.bearerToken === '***') {
              server.bearerToken = currentServer ? currentServer.bearerToken || '' : '';
            }
          }
        }

        if (newConfig && newConfig.entryAuth && Array.isArray(newConfig.entryAuth.keys)) {
          const currentKeys =
            currentRaw.entryAuth && Array.isArray(currentRaw.entryAuth.keys)
              ? currentRaw.entryAuth.keys
              : [];
          for (const entryKey of newConfig.entryAuth.keys) {
            if (!entryKey) continue;
            const currentKey = currentKeys.find((item) => item && item.id === entryKey.id);
            if (entryKey.key === '[redacted]' || entryKey.key === '***') {
              entryKey.key = currentKey ? currentKey.key || '' : '';
            }
          }
        }

        writeConfigFileAtomically(newConfig);
        reloadProxyConfig();
        sendJson(clientRes, 200, {
          ok: true,
          ...((validation.warnings || []).length > 0 ? { warnings: validation.warnings } : {}),
        });
      } catch (err) {
        sendJson(clientRes, 400, { error: err.message });
      }
    });
  }

  function handleLocalSetActiveRequest(clientReq, clientRes) {
    readJsonBodyFromRequest(clientReq, (bodyErr, body) => {
      if (bodyErr) {
        sendJson(clientRes, 400, { ok: false, error: bodyErr.message });
        return;
      }
      try {
        const bodyResult = requireConfigObjectBody(body);
        if (!bodyResult.ok) {
          sendJson(clientRes, 400, { ok: false, error: bodyResult.error });
          return;
        }

        const profileId = String(body.profileId || body.id || '').trim();
        if (!profileId) {
          sendJson(clientRes, 400, { ok: false, error: 'profileId is required' });
          return;
        }

        let rawConfig = {};
        if (fs.existsSync(configFile)) {
          rawConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        } else {
          rawConfig = JSON.parse(JSON.stringify(loadConfigFn()));
        }

        const profiles = Array.isArray(rawConfig.profiles) ? rawConfig.profiles : [];
        if (!profiles.some((profile) => profile && profile.id === profileId)) {
          sendJson(clientRes, 404, { ok: false, error: 'Profile not found: ' + profileId });
          return;
        }

        rawConfig.activeProfile = profileId;
        const validation = validateConfig(rawConfig);
        if (!validation.valid) {
          sendJson(clientRes, 400, {
            ok: false,
            error: 'Invalid configuration: ' + validation.errors.join(', '),
          });
          return;
        }

        writeConfigFileAtomically(rawConfig);
        reloadProxyConfig();
        sendJson(clientRes, 200, { ok: true, activeProfile: profileId });
      } catch (err) {
        sendJson(clientRes, 400, { ok: false, error: err.message });
      }
    });
  }

  return {
    handleLocalGetConfigRequest,
    handleLocalSaveConfigRequest,
    handleLocalSetActiveRequest,
    handleLocalEntryAuthKeyRevealRequest,
    writeConfigFileAtomically,
  };
}

module.exports = {
  createManagementConfigHandlers,
  redactConfigSecrets,
  requireConfigObjectBody,
};
