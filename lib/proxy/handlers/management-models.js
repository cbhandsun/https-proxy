const { isGoogleOfficialLoginToken } = require('../google-official');
const { fetchGoogleOfficialAvailableModels } = require('../google-official-runtime');
const { buildGoogleOfficialModelsResponse } = require('../google-official');
const { buildModelListRequest } = require('../model-list');
const {
  buildOpenAIOfficialCodexModelsResponse,
  isOpenAIOfficialCodexTarget,
} = require('../openai-official');
const { buildTraeOfficialModelsResponse } = require('../trae-official');
const { readJsonBodyFromRequest, readTextBodyFromResponse } = require('../management-utils');

const MODEL_LIST_TIMEOUT_MS = 12000;
const MODEL_LIST_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

function redactModelListRequestUrl(requestUrl) {
  return String(requestUrl || '').replace(/([?&]key=)[^&]+/, '$1[redacted]');
}

function modelEntryName(model) {
  if (typeof model === 'string') return model;
  if (!model || typeof model !== 'object') return '';
  const name = model.slug || model.name || model.id;
  if (name != null) return String(name);
  try {
    return JSON.stringify(model);
  } catch (err) {
    return '';
  }
}

function normalizeModelNames(items, { stripGeminiPrefix = false } = {}) {
  if (!Array.isArray(items)) return [];
  return items
    .map(modelEntryName)
    .filter(Boolean)
    .map((name) => (stripGeminiPrefix ? name.replace(/^models\//, '') : name));
}

function parseModelListResponse(dataStr) {
  const resData = JSON.parse(dataStr);
  if (Array.isArray(resData.models)) {
    return normalizeModelNames(resData.models, { stripGeminiPrefix: true });
  }
  if (Array.isArray(resData.data)) {
    return normalizeModelNames(resData.data);
  }
  if (resData.models && typeof resData.models === 'object') {
    return Object.keys(resData.models);
  }
  return [];
}

function modelListErrorMessage(statusCode, dataStr) {
  try {
    const resData = JSON.parse(dataStr);
    if (resData.error && typeof resData.error === 'object') {
      return resData.error.message || JSON.stringify(resData.error);
    }
    return resData.error || dataStr || `HTTP ${statusCode}`;
  } catch (err) {
    return `HTTP ${statusCode}: ${dataStr || '无法解析的错误响应'}`;
  }
}

function modelsRequestBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  return body;
}

function createManagementModelsHandlers({
  sendJson,
  requestWithProxy,
  resolveOfficialCredentials,
  resolveConfiguredProfile,
  fetchGoogleOfficialAvailableModels: fetchGoogleModels = fetchGoogleOfficialAvailableModels,
  buildTraeOfficialModelsResponse: buildTraeModels = buildTraeOfficialModelsResponse,
}) {
  if (typeof sendJson !== 'function') {
    throw new TypeError('createManagementModelsHandlers requires sendJson');
  }
  if (typeof requestWithProxy !== 'function') {
    throw new TypeError('createManagementModelsHandlers requires requestWithProxy');
  }
  if (typeof resolveOfficialCredentials !== 'function') {
    throw new TypeError('createManagementModelsHandlers requires resolveOfficialCredentials');
  }
  if (typeof resolveConfiguredProfile !== 'function') {
    throw new TypeError('createManagementModelsHandlers requires resolveConfiguredProfile');
  }

  function handleLocalModelsListRequest(clientReq, clientRes) {
    readJsonBodyFromRequest(clientReq, async (bodyErr, body) => {
      if (bodyErr) {
        sendJson(clientRes, 400, { ok: false, error: bodyErr.message });
        return;
      }
      let responded = false;
      let activeReq = null;
      const sendJsonLocal = (payload) => {
        if (responded || clientRes.writableEnded) return;
        responded = true;
        sendJson(clientRes, 200, payload);
      };
      const hardTimeout = setTimeout(() => {
        if (activeReq && typeof activeReq.destroy === 'function') {
          activeReq.destroy(new Error('获取上游模型超时'));
        }
        sendJsonLocal({
          ok: false,
          error: '获取上游模型超时，请检查上游地址、代理网络或官方登录凭证。',
        });
      }, MODEL_LIST_TIMEOUT_MS);

      try {
        const payload = modelsRequestBody(body);
        let { protocol, targetUrl, apiKey } = payload;
        const { id } = payload;
        if (!targetUrl || !protocol) throw new Error('targetUrl and protocol are required');

        const finalProfile = resolveConfiguredProfile({ id, protocol, targetUrl, apiKey }, id);

        const resolved = await resolveOfficialCredentials({ profile: finalProfile });
        protocol = resolved.profile.protocol || protocol;
        targetUrl = resolved.profile.targetUrl || targetUrl;
        apiKey = resolved.profile.apiKey;

        if (resolved.authProvider === 'google' && resolved.authMode === 'official-login') {
          clearTimeout(hardTimeout);
          try {
            const upstreamModels = await fetchGoogleModels(
              apiKey,
              resolved.googleOfficialProjectId
            );
            if (upstreamModels.ok) {
              sendJsonLocal(upstreamModels);
            } else {
              sendJsonLocal({
                ...buildGoogleOfficialModelsResponse(),
                warning: upstreamModels.error,
                source: 'official-model-config-fallback',
              });
            }
          } catch (err) {
            sendJsonLocal({
              ...buildGoogleOfficialModelsResponse(),
              warning: err.message,
              source: 'official-model-config-fallback',
            });
          }
          return;
        }

        if (
          resolved.authProvider === 'openai' &&
          resolved.authMode === 'official-login' &&
          isOpenAIOfficialCodexTarget(targetUrl)
        ) {
          clearTimeout(hardTimeout);
          sendJsonLocal(buildOpenAIOfficialCodexModelsResponse());
          return;
        }

        if (resolved.authProvider === 'trae' && resolved.authMode === 'official-login') {
          clearTimeout(hardTimeout);
          sendJsonLocal(await buildTraeModels());
          return;
        }

        const listRequest = buildModelListRequest(targetUrl, protocol, apiKey);

        const req = requestWithProxy(
          listRequest.requestUrl,
          {
            method: listRequest.method,
            headers: listRequest.headers,
            timeout: 8000,
          },
          (res) => {
            readTextBodyFromResponse(
              res,
              (readErr, dataStr) => {
                clearTimeout(hardTimeout);
                if (readErr) {
                  sendJsonLocal({
                    ok: false,
                    error: '模型列表响应过大或读取失败: ' + readErr.message,
                    requestUrl: redactModelListRequestUrl(listRequest.requestUrl),
                  });
                  return;
                }
                if (res.statusCode !== 200) {
                  sendJsonLocal({
                    ok: false,
                    error: modelListErrorMessage(res.statusCode, dataStr),
                    requestUrl: redactModelListRequestUrl(listRequest.requestUrl),
                  });
                  return;
                }
                try {
                  sendJsonLocal({
                    ok: true,
                    models: parseModelListResponse(dataStr),
                    authMode:
                      resolved.authMode ||
                      (isGoogleOfficialLoginToken(apiKey) ? 'official-login' : 'api-key'),
                    source: 'upstream-api',
                  });
                } catch (err) {
                  sendJsonLocal({ ok: false, error: '解析模型响应失败: ' + err.message });
                }
              },
              { maxBytes: MODEL_LIST_RESPONSE_MAX_BYTES }
            );
          }
        );
        activeReq = req;
        req.on('error', (err) => {
          clearTimeout(hardTimeout);
          sendJsonLocal({ ok: false, error: err.message });
        });
        req.end();
      } catch (err) {
        clearTimeout(hardTimeout);
        sendJsonLocal({ ok: false, error: err.message });
      }
    });
  }

  return {
    handleLocalModelsListRequest,
  };
}

module.exports = {
  MODEL_LIST_RESPONSE_MAX_BYTES,
  MODEL_LIST_TIMEOUT_MS,
  createManagementModelsHandlers,
  modelEntryName,
  modelListErrorMessage,
  modelsRequestBody,
  normalizeModelNames,
  parseModelListResponse,
  redactModelListRequestUrl,
};
