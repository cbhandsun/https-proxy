const { officialLoginProvider } = require('../auth-mode');
const { selectTianxiErrorMessage, sanitizeTianxiErrorText } = require('../tianxi-error-message');
const { safeTraeDiagnosticError, sanitizeTraeDiagnosticUrl } = require('../trae-error-contract');
const { readJsonBodyFromRequest } = require('../management-utils');
const {
  isOpenAIOfficialCodexTarget,
  normalizeOpenAIOfficialCodexModelName,
  openAIOfficialCodexModelSupport,
} = require('../openai-official');
const {
  buildProfileAuthProbeRequest,
  evaluateClaudeProfileAuthResponse,
  evaluateGeminiProfileAuthResponse,
  evaluateOpenAIProfileAuthResponse,
} = require('../profile-auth');
const {
  getTraeOfficialBridgeUrl,
  normalizeTraeOfficialModelName,
  queryTraeStateRows,
  traeOfficialModelSupport,
} = require('../trae-official');
const {
  inspectTianxiCredentialExpiry,
  readLatestAgentCoreHeader,
} = require('../tianxi-agentcore-local');
const { createTianxiBridgeRuntime } = require('../tianxi-bridge-runtime');
const { buildTianxiCredentialState } = require('../tianxi-native-runtime');
const { getTianxiOfficialBridgeUrl } = require('../tianxi-official');
const {
  normalizeWorkBuddyOfficialModelName,
  workBuddyOfficialModelSupport,
} = require('../workbuddy-official');

function profileRequestBody(body) {
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

function compactDiagnosticText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
}

function sanitizeTianxiDiagnosticText(value) {
  return sanitizeTianxiErrorText(compactDiagnosticText(value))
    .replace(/sat-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-token]')
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\b/g, '[redacted-token]')
    .replace(/(bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted-token]');
}

function tianxiFrameStatus(frame) {
  const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
  return String(data.status || frame.status || '').toUpperCase();
}

function tianxiFrameError(frame, status) {
  const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
  const rawMessage = selectTianxiErrorMessage(data, status || 'Tianxi route failed');
  const message = sanitizeTianxiDiagnosticText(rawMessage);
  if (/Service Account token has expired|service_account_token_expired/i.test(message)) {
    const registryCredentialState =
      data.registry_credential_state && typeof data.registry_credential_state === 'object'
        ? data.registry_credential_state
        : {};
    if (registryCredentialState.refreshPossibleWithLogin === true) {
      return 'Tianxi qoder service account token has expired. The Tianxi registry login cache is still valid, but the native AgentCore plugin has not issued a fresh qoder_token yet; refresh or re-open Tianxi super mode in the native app, then retry this route.';
    }
    const credentialState =
      data.credential_state && typeof data.credential_state === 'object'
        ? data.credential_state
        : {};
    if (credentialState.txExpired === true) {
      return 'Tianxi qoder service account token has expired, and the observed Tianxi login token is also expired. Open or re-login/refresh Tianxi AI once so the native host can issue fresh credentials, then retry this route.';
    }
    return 'Tianxi qoder service account token has expired. The current tac-server route needs a fresh qoder_token from the native Tianxi host before chat or super mode can run.';
  }
  return message;
}

function credentialStateFromTianxiFrames(frames) {
  for (const frame of frames) {
    const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
    if (data.credential_state && typeof data.credential_state === 'object') {
      return {
        qoderExpired:
          typeof data.credential_state.qoderExpired === 'boolean'
            ? data.credential_state.qoderExpired
            : null,
        txExpired:
          typeof data.credential_state.txExpired === 'boolean'
            ? data.credential_state.txExpired
            : null,
        refreshPossibleWithTx:
          typeof data.credential_state.refreshPossibleWithTx === 'boolean'
            ? data.credential_state.refreshPossibleWithTx
            : false,
      };
    }
  }
  return null;
}

function summarizeTianxiRouteResult(result, model, readHeader) {
  const frames = Array.isArray(result && result.frames) ? result.frames : [];
  const terminalFrame = frames.find((frame) =>
    ['COMPLETED', 'FAILED', 'CANCELED'].includes(tianxiFrameStatus(frame))
  );
  const terminalStatus = terminalFrame ? tianxiFrameStatus(terminalFrame) : '';
  let credentialState = credentialStateFromTianxiFrames(frames);
  if (!credentialState && typeof readHeader === 'function') {
    try {
      const header = readHeader();
      if (header && header.credentials) {
        credentialState = buildTianxiCredentialState(
          inspectTianxiCredentialExpiry(header.credentials)
        );
      }
    } catch (_err) {}
  }
  const source = result && result.mode === 'direct' ? 'tianxi-tac-server' : 'tianxi-bridge';
  const base = {
    authMode: 'official-login',
    source,
    bridgeUrl: result && result.bridgeUrl,
    model,
    frameCount: frames.length,
  };
  if (credentialState) base.credentialState = credentialState;
  if (terminalStatus === 'COMPLETED') {
    return {
      ...base,
      ok: true,
      message: `Tianxi 本机模式可达；模型 ${model} 已完成并返回 ${frames.length} 个事件帧。`,
    };
  }
  if (terminalStatus === 'FAILED' || terminalStatus === 'CANCELED') {
    return {
      ...base,
      ok: false,
      terminalStatus,
      error: tianxiFrameError(terminalFrame, terminalStatus),
    };
  }
  return {
    ...base,
    ok: false,
    terminalStatus: terminalStatus || null,
    error:
      frames.length > 0
        ? `Tianxi 本机模式返回了 ${frames.length} 个事件帧，但没有完成状态。`
        : 'Tianxi 本机模式未返回事件帧。',
  };
}

function createManagementProfileHandlers({
  sendJson,
  makeRequest,
  resolveOfficialCredentials,
  resolveConfiguredProfile,
  getProfilesSnapshot,
  queryTraeStateRows: queryTraeStateRowsForTest = queryTraeStateRows,
  traeOfficialModelSupport: traeOfficialModelSupportForTest = traeOfficialModelSupport,
  getTraeOfficialBridgeUrl: getTraeOfficialBridgeUrlForTest = getTraeOfficialBridgeUrl,
  readLatestAgentCoreHeader: readLatestAgentCoreHeaderForTest = readLatestAgentCoreHeader,
  callTianxiOfficialBridge,
}) {
  if (typeof sendJson !== 'function') {
    throw new TypeError('createManagementProfileHandlers requires sendJson');
  }
  if (typeof makeRequest !== 'function') {
    throw new TypeError('createManagementProfileHandlers requires makeRequest');
  }
  if (typeof resolveOfficialCredentials !== 'function') {
    throw new TypeError('createManagementProfileHandlers requires resolveOfficialCredentials');
  }
  if (typeof resolveConfiguredProfile !== 'function') {
    throw new TypeError('createManagementProfileHandlers requires resolveConfiguredProfile');
  }
  if (typeof getProfilesSnapshot !== 'function') {
    throw new TypeError('createManagementProfileHandlers requires getProfilesSnapshot');
  }

  async function testTraeOfficialUpstream(testModel = null) {
    const state = await queryTraeStateRowsForTest();
    if (!state.ok) {
      return {
        ok: false,
        authMode: 'official-login',
        source: 'trae-state-cache',
        error: state.error || 'Trae state cache is not available.',
      };
    }

    let support = null;
    if (testModel) {
      support = traeOfficialModelSupportForTest(testModel, state.rows);
      if (!support.known || !support.supported) {
        return {
          ok: false,
          authMode: 'official-login',
          source: 'trae-state-cache',
          error: `Trae 模型缓存未返回 ${normalizeTraeOfficialModelName(testModel)}，不要按普通 OpenAI 兼容模型路由。`,
        };
      }
    }

    const bridgeUrl = getTraeOfficialBridgeUrlForTest('/health');
    const diagnosticBridgeUrl = sanitizeTraeDiagnosticUrl(bridgeUrl);
    try {
      const res = await makeRequest(bridgeUrl, { method: 'GET', timeout: 1500 }, null);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return {
          ok: true,
          authMode: 'official-login',
          source: 'trae-bridge',
          bridgeUrl: diagnosticBridgeUrl,
          model: support && support.model,
          message: support
            ? `Trae 官方登录桥接可达；本地模型缓存确认 ${support.model} 可用于路由。`
            : 'Trae 官方登录桥接可达。',
        };
      }
      return {
        ok: false,
        authMode: 'official-login',
        source: 'trae-bridge',
        bridgeUrl: diagnosticBridgeUrl,
        error: safeTraeDiagnosticError(null, 'bridge'),
      };
    } catch (err) {
      return {
        ok: false,
        authMode: 'official-login',
        source: 'trae-bridge',
        bridgeUrl: diagnosticBridgeUrl,
        error:
          'Trae bridge extension is not reachable. Install/reload https-proxy-manager-trae-bridge in Trae, then retry.',
        detail: safeTraeDiagnosticError(err, 'bridge'),
      };
    }
  }

  async function testProfileAuthUpstream(
    protocol,
    targetUrl,
    apiKey,
    testModel = null,
    authMode = 'api-key'
  ) {
    try {
      if (protocol === 'tianxi') {
        const bridgeRuntime =
          callTianxiOfficialBridge ||
          createTianxiBridgeRuntime({
            makeRequest,
            getTianxiOfficialBridgeUrl,
          }).callTianxiOfficialBridge;
        const model = String(testModel || 'super').replace(/^tianxi\//i, '') || 'super';
        const result = await bridgeRuntime(
          {
            model,
            input: 'ping',
            stream: false,
            metadata: {
              source: 'https-proxy-manager-route-test',
              tianxi: model ? { agent_id: model } : {},
            },
          },
          {
            id: 'tianxi-official',
            protocol: 'tianxi',
            targetUrl,
            authMode: 'official-login',
            timeoutMs: 90000,
          }
        );
        return summarizeTianxiRouteResult(result, model, readLatestAgentCoreHeaderForTest);
      }

      if (
        protocol === 'trae' ||
        (authMode === 'official-login' &&
          officialLoginProvider({ protocol, targetUrl, authMode }) === 'trae')
      ) {
        return await testTraeOfficialUpstream(testModel);
      }

      if (
        protocol === 'workbuddy' ||
        (authMode === 'official-login' &&
          officialLoginProvider({ protocol, targetUrl, authMode }) === 'workbuddy')
      ) {
        if (testModel) {
          const support = workBuddyOfficialModelSupport(testModel);
          if (support.known && support.supported) {
            return {
              ok: true,
              authMode,
              source: 'workbuddy-product-cache',
              message: `WorkBuddy 官方登录凭证已加载；模型 ${support.model} 可用。`,
            };
          }
          return {
            ok: false,
            authMode,
            source: 'workbuddy-product-cache',
            error: `WorkBuddy 模型 ${normalizeWorkBuddyOfficialModelName(testModel)} 未在官方模型目录中找到。`,
          };
        }
        return {
          ok: true,
          authMode,
          source: 'workbuddy-auth-info',
          message: 'WorkBuddy 官方登录凭据有效。',
        };
      }

      if (
        protocol === 'openai' &&
        authMode === 'official-login' &&
        isOpenAIOfficialCodexTarget(targetUrl) &&
        testModel
      ) {
        const support = openAIOfficialCodexModelSupport(testModel);
        if (support.known && support.supported) {
          return {
            ok: true,
            authMode,
            source: 'codex-model-cache',
            message: `OpenAI 官方登录凭证已加载；Codex 模型缓存确认 ${support.model} 可用于 API。`,
          };
        }
        if (support.known) {
          return {
            ok: false,
            authMode,
            source: 'codex-model-cache',
            error: `Codex 模型 ${support.model} 当前不支持 API 路由。`,
          };
        }
        return {
          ok: false,
          authMode,
          source: 'codex-model-cache',
          error: `Codex 官方模型缓存未返回 ${normalizeOpenAIOfficialCodexModelName(testModel)}，不要按 ChatGPT Web 模型列表路由。`,
        };
      }

      const probe = buildProfileAuthProbeRequest(protocol, targetUrl, apiKey, testModel, authMode);
      if (probe.unsupported) {
        return { ok: false, error: `Unsupported protocol: ${protocol}` };
      }

      if (protocol === 'openai') {
        const res = await makeRequest(
          probe.fullUrl,
          { method: probe.method, headers: probe.headers },
          probe.requestBody
        );
        return evaluateOpenAIProfileAuthResponse(res, { testModel, authMode });
      }
      if (protocol === 'gemini') {
        const res = await makeRequest(
          probe.fullUrl,
          { method: probe.method, headers: probe.headers },
          probe.requestBody
        );
        return evaluateGeminiProfileAuthResponse(res, {
          testModel,
          authMode,
          probeFullUrl: probe.fullUrl,
        });
      }
      if (protocol === 'claude') {
        const res = await makeRequest(
          probe.fullUrl,
          { method: probe.method, headers: probe.headers },
          probe.requestBody
        );
        return evaluateClaudeProfileAuthResponse(res, { testModel });
      }
      return { ok: false, error: `Unsupported protocol: ${protocol}` };
    } catch (err) {
      return { ok: false, error: `Network error: ${err.message}` };
    }
  }

  function handleLocalProfileTestAuthRequest(clientReq, clientRes) {
    readJsonBodyFromRequest(clientReq, async (bodyErr, body) => {
      if (bodyErr) {
        sendJson(clientRes, 400, { ok: false, error: bodyErr.message });
        return;
      }
      try {
        const payload = profileRequestBody(body);
        let { protocol, profileId } = payload;
        const { targetUrl, testModel } = payload;
        profileId = profileId || payload.id;
        let { apiKey } = payload;

        if (!protocol || !targetUrl) {
          throw new Error('protocol and targetUrl are required');
        }

        const finalProfile = resolveConfiguredProfile(
          { id: profileId, protocol, targetUrl, apiKey },
          profileId
        );

        const resolved = await resolveOfficialCredentials({ profile: finalProfile });
        protocol = resolved.profile.protocol || protocol;
        apiKey = resolved.profile.apiKey;
        const finalTargetUrl = resolved.profile.targetUrl || targetUrl;

        const result = await testProfileAuthUpstream(
          protocol,
          finalTargetUrl,
          apiKey,
          testModel,
          resolved.authMode || 'api-key'
        );

        sendJson(clientRes, 200, result);
      } catch (err) {
        sendJson(clientRes, 400, { ok: false, error: err.message });
      }
    });
  }

  function handleLocalRouteTestRequest(clientReq, clientRes) {
    readJsonBodyFromRequest(clientReq, async (bodyErr, body) => {
      if (bodyErr) {
        sendJson(clientRes, 400, { ok: false, error: bodyErr.message });
        return;
      }
      try {
        const payload = profileRequestBody(body);
        let { protocol, targetUrl, profileId, apiKey } = payload;
        const testModel = payload.to || payload.targetModel || payload.testModel;
        profileId = profileId || payload.id;
        if (!protocol || !targetUrl) {
          const profile = getProfilesSnapshot().find((item) => item && item.id === profileId);
          if (profile) {
            protocol = protocol || profile.protocol;
            targetUrl = targetUrl || profile.targetUrl;
            apiKey = apiKey || profile.apiKey;
          }
        }
        if (!protocol || !targetUrl) {
          sendJson(clientRes, 400, { ok: false, error: 'protocol and targetUrl are required' });
          return;
        }
        const finalProfile = resolveConfiguredProfile(
          { id: profileId, protocol, targetUrl, apiKey },
          profileId
        );
        const resolved = await resolveOfficialCredentials({ profile: finalProfile });
        const result = await testProfileAuthUpstream(
          resolved.profile.protocol || protocol,
          resolved.profile.targetUrl || targetUrl,
          resolved.profile.apiKey,
          testModel,
          resolved.authMode || 'api-key'
        );
        sendJson(clientRes, 200, result);
      } catch (err) {
        sendJson(clientRes, 500, { ok: false, error: err.message });
      }
    });
  }

  return {
    handleLocalProfileTestAuthRequest,
    handleLocalRouteTestRequest,
    testProfileAuthUpstream,
    testTraeOfficialUpstream,
  };
}

module.exports = {
  createManagementProfileHandlers,
  profileRequestBody,
  summarizeTianxiRouteResult,
};
