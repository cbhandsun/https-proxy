const { officialLoginProvider } = require('../auth-mode');
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

function profileRequestBody(body) {
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
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
    try {
      const res = await makeRequest(bridgeUrl, { method: 'GET', timeout: 1500 }, null);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return {
          ok: true,
          authMode: 'official-login',
          source: 'trae-bridge',
          bridgeUrl,
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
        bridgeUrl,
        error: `Trae bridge 探测失败 HTTP ${res.statusCode}: ${res.body || ''}`,
      };
    } catch (err) {
      return {
        ok: false,
        authMode: 'official-login',
        source: 'trae-bridge',
        bridgeUrl,
        error:
          'Trae bridge extension is not reachable. Install/reload https-proxy-manager-trae-bridge in Trae, then retry.',
        detail: err.message,
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
      if (
        protocol === 'trae' ||
        (authMode === 'official-login' &&
          officialLoginProvider({ protocol, targetUrl, authMode }) === 'trae')
      ) {
        return await testTraeOfficialUpstream(testModel);
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
};
