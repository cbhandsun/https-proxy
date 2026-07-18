const { URL } = require('url');

const { isGoogleOfficialLoginToken } = require('../google-official');
const { parseBoundedInteger, readJsonBodyFromRequest } = require('../management-utils');
const { getModelsUrl } = require('../model-list');

const DEFAULT_LATENCY_TIMEOUT_MS = 8000;
const MIN_LATENCY_TIMEOUT_MS = 250;
const MAX_LATENCY_TIMEOUT_MS = 30000;

function latencyRequestBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  return body;
}

function createManagementLatencyHandlers({
  sendJson,
  requestWithProxy,
  resolveOfficialCredentials,
  resolveConfiguredProfile,
} = {}) {
  if (typeof sendJson !== 'function') {
    throw new TypeError('createManagementLatencyHandlers requires sendJson');
  }
  if (typeof requestWithProxy !== 'function') {
    throw new TypeError('createManagementLatencyHandlers requires requestWithProxy');
  }
  if (typeof resolveOfficialCredentials !== 'function') {
    throw new TypeError('createManagementLatencyHandlers requires resolveOfficialCredentials');
  }
  if (typeof resolveConfiguredProfile !== 'function') {
    throw new TypeError('createManagementLatencyHandlers requires resolveConfiguredProfile');
  }

  function handleLocalLatencyRequest(clientReq, clientRes) {
    readJsonBodyFromRequest(clientReq, async (bodyErr, body) => {
      if (bodyErr) {
        sendJson(clientRes, 400, { error: bodyErr.message });
        return;
      }
      try {
        const payload = latencyRequestBody(body);
        let { protocol, targetUrl, apiKey } = payload;
        const { id, profileId } = payload;
        const timeoutMs = parseBoundedInteger(
          payload.timeoutMs,
          DEFAULT_LATENCY_TIMEOUT_MS,
          MIN_LATENCY_TIMEOUT_MS,
          MAX_LATENCY_TIMEOUT_MS
        );
        if (!targetUrl || !protocol) {
          throw new Error('targetUrl and protocol are required');
        }

        const lookupId = id || profileId;
        const finalProfile = resolveConfiguredProfile(
          { id: lookupId, protocol, targetUrl, apiKey },
          lookupId
        );

        const resolved = await resolveOfficialCredentials({ profile: finalProfile });
        protocol = resolved.profile.protocol || protocol;
        targetUrl = resolved.profile.targetUrl || targetUrl;
        apiKey = resolved.profile.apiKey;

        const url = getModelsUrl(targetUrl, protocol);
        const urlObj = new URL(url);
        const headers = { accept: 'application/json' };
        if (apiKey) {
          if (protocol === 'claude') headers['x-api-key'] = apiKey;
          else if (protocol === 'gemini') {
            if (isGoogleOfficialLoginToken(apiKey)) headers.authorization = 'Bearer ' + apiKey;
            else headers['x-goog-api-key'] = apiKey;
          } else {
            headers.authorization = 'Bearer ' + apiKey;
          }
        }

        const startTime = Date.now();
        const targetFullUrl =
          urlObj.protocol + '//' + urlObj.host + urlObj.pathname + urlObj.search;
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          sendJson(clientRes, 200, result);
        };
        const req = requestWithProxy(
          targetFullUrl,
          { method: 'GET', headers, timeout: timeoutMs },
          (res) => {
            const latency = Date.now() - startTime;
            res.resume();
            finish({ ok: true, latency });
          }
        );

        req.on('error', (err) => {
          finish({ ok: false, error: err.message });
        });
        req.end();
      } catch (err) {
        sendJson(clientRes, 400, { error: err.message });
      }
    });
  }

  return {
    handleLocalLatencyRequest,
  };
}

module.exports = {
  DEFAULT_LATENCY_TIMEOUT_MS,
  createManagementLatencyHandlers,
  latencyRequestBody,
};
