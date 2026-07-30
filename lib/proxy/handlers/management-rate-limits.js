const https = require('https');
const { URL } = require('url');

const { officialLoginProvider } = require('../auth-mode');
const {
  buildGoogleOfficialAvailableModelsRequest,
  buildGoogleOfficialLoadCodeAssistRequest,
  buildGoogleOfficialRetrieveUserQuotaRequest,
  formatGoogleOfficialAvailableModels,
  formatGoogleOfficialUserQuota,
} = require('../google-official');
const { readTextBodyFromResponse } = require('../management-utils');
const { formatRateLimits, readLatestCodexLocalRateLimits } = require('../rate-limits');

function profileIdFromRateLimitRequest(clientReq) {
  const urlObj = new URL(clientReq.url, 'http://localhost');
  return (
    String(urlObj.searchParams.get('profileId') || 'openai-official').trim() || 'openai-official'
  );
}

function createManagementRateLimitHandlers({
  sendJson,
  makeRequest,
  resolveOfficialCredentials,
  getProfilesSnapshot,
  decryptKey,
  httpsRequest = https.request,
  globalHttpsAgent,
  readLatestLocalRateLimits = readLatestCodexLocalRateLimits,
} = {}) {
  if (typeof sendJson !== 'function') {
    throw new TypeError('createManagementRateLimitHandlers requires sendJson');
  }
  if (typeof makeRequest !== 'function') {
    throw new TypeError('createManagementRateLimitHandlers requires makeRequest');
  }
  if (typeof resolveOfficialCredentials !== 'function') {
    throw new TypeError('createManagementRateLimitHandlers requires resolveOfficialCredentials');
  }
  if (typeof getProfilesSnapshot !== 'function') {
    throw new TypeError('createManagementRateLimitHandlers requires getProfilesSnapshot');
  }
  if (typeof decryptKey !== 'function') {
    throw new TypeError('createManagementRateLimitHandlers requires decryptKey');
  }

  function sendCodexLocalRateLimitsOrError(clientRes, error) {
    const local = readLatestLocalRateLimits();
    clientRes.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
    });
    if (local.ok) {
      clientRes.end(JSON.stringify({ ...local, warning: error || undefined }));
    } else {
      clientRes.end(JSON.stringify({ ok: false, limits: [], error: error || local.error }));
    }
  }

  async function handleGoogleRateLimits(clientRes, apiKey, resolved) {
    let projectId =
      resolved.profile.projectId ||
      resolved.profile.managedProjectId ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GOOGLE_CLOUD_PROJECT_ID ||
      '';
    if (!projectId) {
      const loadProbe = buildGoogleOfficialLoadCodeAssistRequest(apiKey);
      const loadRes = await makeRequest(
        loadProbe.fullUrl,
        { method: loadProbe.method, headers: loadProbe.headers },
        loadProbe.requestBody
      );
      if (loadRes.statusCode >= 200 && loadRes.statusCode < 300) {
        try {
          const loaded = JSON.parse(loadRes.body);
          projectId =
            loaded.cloudaicompanionProject ||
            (loaded.currentTier && loaded.currentTier.cloudaicompanionProject) ||
            '';
        } catch (err) {}
      }
    }

    const availableReq = buildGoogleOfficialAvailableModelsRequest(apiKey, projectId);
    const availableRes = await makeRequest(
      availableReq.fullUrl,
      { method: availableReq.method, headers: availableReq.headers },
      availableReq.requestBody
    );
    if (availableRes.statusCode >= 200 && availableRes.statusCode < 300) {
      let parsed = {};
      try {
        parsed = JSON.parse(availableRes.body);
      } catch (err) {}
      sendJson(clientRes, 200, {
        ok: true,
        limits: formatGoogleOfficialAvailableModels(parsed),
        source: 'fetchAvailableModels',
        projectId: projectId || undefined,
      });
      return;
    }

    const quotaReq = buildGoogleOfficialRetrieveUserQuotaRequest(apiKey, projectId);
    const quotaRes = await makeRequest(
      quotaReq.fullUrl,
      { method: quotaReq.method, headers: quotaReq.headers },
      quotaReq.requestBody
    );
    if (quotaRes.statusCode >= 200 && quotaRes.statusCode < 300) {
      let parsed = {};
      try {
        parsed = JSON.parse(quotaRes.body);
      } catch (err) {}
      sendJson(clientRes, 200, {
        ok: true,
        limits: formatGoogleOfficialUserQuota(parsed),
        source: 'retrieveUserQuota',
        projectId: projectId || undefined,
      });
      return;
    }

    sendJson(clientRes, 200, {
      ok: false,
      limits: [],
      source: 'fetchAvailableModels',
      error: `Google 官方限额同步失败 HTTP ${availableRes.statusCode}: ${availableRes.body || quotaRes.body || '无响应'}`,
    });
  }

  function handleOpenAIRateLimits(clientRes, apiKey) {
    const targetUrl = 'https://chatgpt.com/backend-api/rate_limits';
    const targetUrlObj = new URL(targetUrl);
    const req = httpsRequest(
      {
        hostname: targetUrlObj.hostname,
        port: 443,
        path: targetUrlObj.pathname + targetUrlObj.search,
        method: 'GET',
        headers: {
          authorization: 'Bearer ' + apiKey,
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          accept: 'application/json',
        },
        timeout: 5000,
        agent: globalHttpsAgent,
      },
      (res) => {
        readTextBodyFromResponse(
          res,
          (bodyErr, dataStr) => {
            try {
              if (bodyErr) {
                sendCodexLocalRateLimitsOrError(
                  clientRes,
                  `OpenAI 后端限额接口响应过大或读取失败: ${bodyErr.message}`
                );
                return;
              }
              if (res.statusCode !== 200) {
                sendCodexLocalRateLimitsOrError(
                  clientRes,
                  `OpenAI 后端限额接口 HTTP ${res.statusCode}: ${dataStr || '无法获取真实限额'}`
                );
                return;
              }
              const formatted = formatRateLimits(JSON.parse(dataStr));
              if (!formatted.length) {
                sendCodexLocalRateLimitsOrError(
                  clientRes,
                  'OpenAI 后端限额接口未返回可用窗口数据。'
                );
                return;
              }
              sendJson(clientRes, 200, {
                ok: true,
                limits: formatted,
                source: 'chatgpt-rate-limits',
              });
            } catch (err) {
              sendCodexLocalRateLimitsOrError(
                clientRes,
                '解析 OpenAI 后端限额失败: ' + err.message
              );
            }
          },
          { maxBytes: 512 * 1024 }
        );
      }
    );

    req.on('timeout', () => {
      req.destroy();
    });

    req.on('error', (err) => {
      sendCodexLocalRateLimitsOrError(clientRes, '同步 OpenAI 后端限额失败: ' + err.message);
    });

    req.end();
  }

  async function handleLocalRateLimitsRequest(clientReq, clientRes) {
    try {
      const profileId = profileIdFromRateLimitRequest(clientReq);
      const profiles = getProfilesSnapshot();
      const profile = Array.isArray(profiles)
        ? profiles.find((item) => item.id === profileId)
        : null;
      if (!profile) {
        sendJson(clientRes, 400, { ok: false, error: '找不到 Profile' });
        return;
      }

      const finalProfile = { ...profile };
      let foundApiKey = finalProfile.apiKey;
      if (
        foundApiKey &&
        (foundApiKey.startsWith('hpm-enc:') ||
          foundApiKey.startsWith('hpm-dpapi:') ||
          foundApiKey.startsWith('hpm-aes-v2:'))
      ) {
        foundApiKey = decryptKey(foundApiKey);
      }
      finalProfile.apiKey = foundApiKey;

      const resolved = await resolveOfficialCredentials({ profile: finalProfile });
      const apiKey = resolved.profile.apiKey;

      if (!apiKey) {
        if (
          profileId === 'openai-official' ||
          officialLoginProvider(resolved.profile) === 'openai'
        ) {
          sendCodexLocalRateLimitsOrError(
            clientRes,
            '未检测到 OpenAI 官方登录凭证，已尝试读取 Codex 本地限额。'
          );
        } else {
          sendJson(clientRes, 200, {
            ok: false,
            limits: [],
            error: '未检测到官方登录凭证，无法同步真实限额。',
          });
        }
        return;
      }

      if (profileId === 'google-official') {
        await handleGoogleRateLimits(clientRes, apiKey, resolved);
        return;
      }

      handleOpenAIRateLimits(clientRes, apiKey);
    } catch (err) {
      sendJson(clientRes, 500, { ok: false, error: err.message });
    }
  }

  return {
    handleLocalRateLimitsRequest,
    sendCodexLocalRateLimitsOrError,
  };
}

module.exports = {
  createManagementRateLimitHandlers,
  profileIdFromRateLimitRequest,
};
