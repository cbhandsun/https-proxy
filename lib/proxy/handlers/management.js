const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const https = require('https');
const http = require('http');
const cp = require('child_process');

const {
  DATA_DIR,
  CONFIG_FILE,
  loadConfig,
  getProfiles,
  encryptKey,
  decryptKey,
} = require('../config');

const {
  getClaudeDesktopStatus,
  claudeDesktopBaseUrl,
  PROXY_PREFIX,
  applyClaudeDesktopConfig,
  restoreClaudeDesktopConfig,
} = require('../claude-desktop');

const {
  isGoogleOfficialLoginToken,
  isOpenAIOfficialLoginToken,
  officialLoginProvider,
  inferOfficialProfileAuthMode,
  configuredAuthMode,
  isRedactedSecret,
  shouldUseChatGPTBackendForOfficialLogin,
} = require('../auth-mode');

const {
  readAntigravityOfficialCredentialState,
} = require('../google-official');

const {
  fetchGoogleOfficialAvailableModels,
  refreshGoogleAccessToken,
  getFreshAntigravityOfficialAccessToken,
  resolveGoogleOfficialLoginPrepared,
} = require('../google-official-runtime');

const {
  buildGoogleOfficialLoadCodeAssistRequest,
  buildGoogleOfficialAvailableModelsRequest,
  buildGoogleOfficialRetrieveUserQuotaRequest,
  formatGoogleOfficialAvailableModels,
  formatGoogleOfficialUserQuota,
  buildGoogleOfficialModelsResponse,
} = require('../google-official');

const {
  isOpenAIOfficialCodexTarget,
  buildOpenAIOfficialCodexModelsResponse,
  openAIOfficialCodexModelSupport,
  normalizeOpenAIOfficialCodexModelName,
} = require('../openai-official');

const {
  queryTraeStateRows,
  traeOfficialModelSupport,
  normalizeTraeOfficialModelName,
  getTraeOfficialBridgeUrl,
  buildTraeOfficialModelsResponse,
  TRAE_OFFICIAL_TARGET_URL,
  readTraeStorageSummary,
} = require('../trae-official');

const {
  getModelsUrl,
  buildModelListRequest,
} = require('../model-list');

const {
  fileSignature,
  readLastLinesOfJsonl,
} = require('../management-utils');

const {
  validateConfig,
} = require('../validator');

const {
  getDiagnosticsConfig,
  GEMINI_SAMPLE_FILE,
  TOOL_AUDIT_FILE,
  RESPONSE_SAMPLE_FILE,
  DIAGNOSTICS_OUTBOUND_SSE_FILE,
  DIAGNOSTICS_REQUEST_TOOLS_FILE,
  PROXY_EVENTS_FILE,
} = require('../diagnostics');

const {
  checkEnvironmentTools,
  startToolInstallJob,
  runToolInstall,
  listInstallJobs,
  clearEnvCaches,
  ENV_CHECK_TOOLS,
} = require('../env-tools');

const {
  getAuditRecords,
  clearAuditRecords,
  getAuditRecordById,
} = require('../audit');

const {
  redactHeaders,
  headersForReplay,
  parseJsonText,
  buildUsageReport,
} = require('../usage-report');

const {
  getUsageSummary,
} = require('../usage');

const {
  readLatestCodexLocalRateLimits,
  formatRateLimits,
} = require('../rate-limits');

const {
  buildProfileAuthProbeRequest,
  evaluateOpenAIProfileAuthResponse,
  evaluateGeminiProfileAuthResponse,
  evaluateClaudeProfileAuthResponse,
} = require('../profile-auth');

const {
  handleLocalPromptsSyncRequest,
  handleLocalPromptsPresetsRequest,
} = require('../prompts-sync');

function createManagementHandlers(deps) {
  const {
    CONFIG,
    PROFILES,
    ACTIVE_PROFILE,
    LOCAL_SERVER,
    MODEL_ROUTES,
    ENTRY_SERVERS,
    APP_ID,
    PACKAGE_VERSION,
    PORT,
    CLI_SESSIONS,
    PROTOCOL_OPTIONS,
    reloadProxyConfig,
    makeRequest,
    requestWithProxy,
    logProxyEvent,
    logRequestEnd,
    resolveOfficialCredentials,
    resolveConfiguredProfile,
    handleLocalCertStatusRequest,
    handleLocalCertTrustRequest,
    handleLocalCertUntrustRequest,
    handleLocalTraeStatusRequest,
    handleLocalTraeBridgeStatusRequest,
    handleLocalAntigravityCliStatusRequest,
    handleLocalAntigravityCliApplyRequest,
    handleLocalAntigravityCliRestoreRequest,
    handleLocalClaudeCodeStatusRequest,
    handleLocalClaudeCodeApplyRequest,
    handleLocalClaudeCodeRestoreRequest,
    handleLocalCodexStatusRequest,
    handleLocalCodexApplyRequest,
    handleLocalCodexRestoreRequest,
    handleLocalCodexSwitchRequest,
    handleLocalCodexApiLoginRequest,
    handleLocalCodexOfficialLoginRequest,
    handleLocalCodexAuthBackupRequest,
    handleLocalCodexDesktopStatusRequest,
    handleLocalCodexDesktopApplyRequest,
    handleLocalCodexDesktopRestoreRequest,
    handleLocalCodexDesktopSwitchRequest,
    handleLocalCodexDesktopApiLoginRequest,
    handleLocalCodexDesktopOfficialLoginRequest,
    handleLocalCodexDesktopAuthBackupRequest,
    handleLocalGeminiCliStatusRequest,
    handleLocalGeminiCliApplyRequest,
    handleLocalGeminiCliRestoreRequest,
    globalHttpsAgent,
    queryTraeStateRows: queryTraeStateRowsForTest = queryTraeStateRows,
    traeOfficialModelSupport: traeOfficialModelSupportForTest = traeOfficialModelSupport,
    getTraeOfficialBridgeUrl: getTraeOfficialBridgeUrlForTest = getTraeOfficialBridgeUrl,
  } = deps;

  let localEventsResponseCache = { key: '', body: '' };
  let localLogResponseCache = { key: '', body: '' };
  let localDiagnosticsResponseCache = { key: '', body: '' };

  // Helper to send JSON responses
  function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify(data));
  }

  function handleLocalLatencyRequest(clientReq, clientRes) {
    const chunks = [];
    clientReq.on('data', chunk => chunks.push(chunk));
    clientReq.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        let { protocol, targetUrl, apiKey, id, profileId } = body;
        if (!targetUrl || !protocol) {
          throw new Error('targetUrl and protocol are required');
        }

        const lookupId = id || profileId;
        let finalProfile = resolveConfiguredProfile({ id: lookupId, protocol, targetUrl, apiKey }, lookupId);

        const resolved = await resolveOfficialCredentials({ profile: finalProfile });
        protocol = resolved.profile.protocol || protocol;
        targetUrl = resolved.profile.targetUrl || targetUrl;
        apiKey = resolved.profile.apiKey;

        const url = getModelsUrl(targetUrl, protocol);
        const urlObj = new URL(url);
        const headers = { 'accept': 'application/json' };
        if (apiKey) {
          if (protocol === 'claude') headers['x-api-key'] = apiKey;
          else if (protocol === 'gemini') {
            if (isGoogleOfficialLoginToken(apiKey)) headers['authorization'] = 'Bearer ' + apiKey;
            else headers['x-goog-api-key'] = apiKey;
          }
          else headers['authorization'] = 'Bearer ' + apiKey;
        }

        const startTime = Date.now();
        const targetFullUrl = urlObj.protocol + '//' + urlObj.host + urlObj.pathname + urlObj.search;
        const req = requestWithProxy(targetFullUrl, { method: 'GET', headers }, (res) => {
          const latency = Date.now() - startTime;
          res.resume();
          sendJson(clientRes, 200, { ok: true, latency });
        });

        req.on('error', (err) => {
          sendJson(clientRes, 200, { ok: false, error: err.message });
        });

      } catch (err) {
        sendJson(clientRes, 400, { error: err.message });
      }
    });
  }

  function expectedClaudeDesktopBaseUrl(config) {
    const desktop = config && config.claudeDesktop ? config.claudeDesktop : {};
    const mode = desktop.mode || 'proxy';
    if (mode === 'proxy') return claudeDesktopBaseUrl(config) + PROXY_PREFIX;
    if (mode === 'direct') return desktop.directBaseUrl || '';
    return '';
  }

  function decorateClaudeDesktopStatus(status, config) {
    const desktop = config && config.claudeDesktop ? config.claudeDesktop : {};
    const expectedBaseUrl = expectedClaudeDesktopBaseUrl(config);
    const actualBaseUrl = status.actualBaseUrl || status.gatewayUrl || '';
    return {
      ...status,
      desiredMode: desktop.mode || 'proxy',
      expectedBaseUrl,
      actualBaseUrl,
      profilePath: status.profilePath || status.configPath,
      configured: status.configured === true,
      matchesExpected: expectedBaseUrl ? actualBaseUrl === expectedBaseUrl : !actualBaseUrl,
    };
  }

  function handleLocalClaudeDesktopStatusRequest(clientReq, clientRes) {
    try {
      sendJson(clientRes, 200, { ok: true, ...decorateClaudeDesktopStatus(getClaudeDesktopStatus(), currentConfigSnapshot()) });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalClaudeDesktopApplyRequest(clientReq, clientRes) {
    try {
      const config = currentConfigSnapshot();
      const result = applyClaudeDesktopConfig(config, CONFIG_FILE, decryptKey);
      sendJson(clientRes, 200, { ok: true, ...result, ...decorateClaudeDesktopStatus(getClaudeDesktopStatus(), config) });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalClaudeDesktopRestoreRequest(clientReq, clientRes) {
    try {
      const config = currentConfigSnapshot();
      restoreClaudeDesktopConfig(config, CONFIG_FILE);
      sendJson(clientRes, 200, { ok: true, ...decorateClaudeDesktopStatus(getClaudeDesktopStatus(), config) });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalCliCredentialsRequest(clientReq, clientRes) {
    try {
      const parsedUrl = new URL(clientReq.url, 'http://localhost');
      const type = parsedUrl.searchParams.get('type') || '';

      if (type === 'google') {
        const credsPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
        if (fs.existsSync(credsPath)) {
          const content = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
          sendJson(clientRes, 200, {
            ok: true,
            token: content.access_token || '',
            expiry: content.expiry_date || 0,
            hasRefreshToken: !!content.refresh_token
          });
          return;
        }
      } else if (type === 'antigravity' || type === 'agy') {
        const agyCreds = readAntigravityOfficialCredentialState();
        if (agyCreds && agyCreds.content) {
          const sendAgyCreds = (token) => {
            sendJson(clientRes, 200, {
              ok: true,
              token: token || agyCreds.content.access_token || '',
              expiry: agyCreds.content.expiry_date || 0,
              hasRefreshToken: !!agyCreds.content.refresh_token,
              source: agyCreds.source
            });
          };
          if (agyCreds.content.refresh_token) {
            refreshGoogleAccessToken(null, agyCreds.content)
              .then(sendAgyCreds)
              .catch(() => sendAgyCreds(agyCreds.content.access_token || ''));
          } else {
            sendAgyCreds(agyCreds.content.access_token || '');
          }
          return;
        }
      } else if (type === 'codex' || type === 'openai') {
        const authPath = path.join(os.homedir(), '.codex', 'auth.json');
        if (fs.existsSync(authPath)) {
          const content = JSON.parse(fs.readFileSync(authPath, 'utf8'));
          const token = (content.tokens && content.tokens.access_token) || content.OPENAI_API_KEY || '';
          sendJson(clientRes, 200, {
            ok: true,
            token: token,
            hasRefreshToken: !!(content.tokens && content.tokens.refresh_token)
          });
          return;
        }
      }

      sendJson(clientRes, 404, { ok: false, error: '未找到本地凭据文件' });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  async function handleLocalRateLimitsRequest(clientReq, clientRes) {
    try {
      const urlObj = new URL(clientReq.url, 'http://localhost');
      const profileId = urlObj.searchParams.get('profileId') || 'openai-official';

      const profiles = currentProfilesSnapshot();
      const profile = Array.isArray(profiles) ? profiles.find(p => p.id === profileId) : null;
      if (!profile) {
        sendJson(clientRes, 400, { ok: false, error: '找不到 Profile' });
        return;
      }

      let finalProfile = { ...profile };
      let foundApiKey = finalProfile.apiKey;
      if (foundApiKey && (foundApiKey.startsWith('hpm-enc:') || foundApiKey.startsWith('hpm-dpapi:'))) {
        foundApiKey = decryptKey(foundApiKey);
      }
      finalProfile.apiKey = foundApiKey;

      const resolved = await resolveOfficialCredentials({ profile: finalProfile });
      let apiKey = resolved.profile.apiKey;

      if (!apiKey) {
        if (profileId === 'openai-official' || officialLoginProvider(resolved.profile) === 'openai') {
          sendCodexLocalRateLimitsOrError(clientRes, '未检测到 OpenAI 官方登录凭证，已尝试读取 Codex 本地限额。');
        } else {
          sendJson(clientRes, 200, { ok: false, limits: [], error: '未检测到官方登录凭证，无法同步真实限额。' });
        }
        return;
      }

      if (profileId === 'google-official') {
        let projectId = resolved.profile.projectId || resolved.profile.managedProjectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || '';
        if (!projectId) {
          const loadProbe = buildGoogleOfficialLoadCodeAssistRequest(apiKey);
          const loadRes = await makeRequest(loadProbe.fullUrl, { method: loadProbe.method, headers: loadProbe.headers }, loadProbe.requestBody);
          if (loadRes.statusCode >= 200 && loadRes.statusCode < 300) {
            try {
              const loaded = JSON.parse(loadRes.body);
              projectId = loaded.cloudaicompanionProject || (loaded.currentTier && loaded.currentTier.cloudaicompanionProject) || '';
            } catch (e) {}
          }
        }

        const availableReq = buildGoogleOfficialAvailableModelsRequest(apiKey, projectId);
        const availableRes = await makeRequest(availableReq.fullUrl, { method: availableReq.method, headers: availableReq.headers }, availableReq.requestBody);
        if (availableRes.statusCode >= 200 && availableRes.statusCode < 300) {
          let parsed = {};
          try { parsed = JSON.parse(availableRes.body); } catch (e) {}
          const limits = formatGoogleOfficialAvailableModels(parsed);
          sendJson(clientRes, 200, { ok: true, limits, source: 'fetchAvailableModels', projectId: projectId || undefined });
          return;
        }

        const quotaReq = buildGoogleOfficialRetrieveUserQuotaRequest(apiKey, projectId);
        const quotaRes = await makeRequest(quotaReq.fullUrl, { method: quotaReq.method, headers: quotaReq.headers }, quotaReq.requestBody);
        if (quotaRes.statusCode >= 200 && quotaRes.statusCode < 300) {
          let parsed = {};
          try { parsed = JSON.parse(quotaRes.body); } catch (e) {}
          const limits = formatGoogleOfficialUserQuota(parsed);
          sendJson(clientRes, 200, { ok: true, limits, source: 'retrieveUserQuota', projectId: projectId || undefined });
          return;
        }

        sendJson(clientRes, 200, {
          ok: false,
          limits: [],
          source: 'fetchAvailableModels',
          error: `Google 官方限额同步失败 HTTP ${availableRes.statusCode}: ${availableRes.body || quotaRes.body || '无响应'}`
        });
        return;
      }

      const targetUrl = 'https://chatgpt.com/backend-api/rate_limits';
      const targetUrlObj = new URL(targetUrl);

      const headers = {
        'authorization': 'Bearer ' + apiKey,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'accept': 'application/json',
      };

      const req = https.request({
        hostname: targetUrlObj.hostname,
        port: 443,
        path: targetUrlObj.pathname + targetUrlObj.search,
        method: 'GET',
        headers,
        timeout: 5000,
        agent: globalHttpsAgent,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const dataStr = Buffer.concat(chunks).toString('utf8');
          try {
            if (res.statusCode !== 200) {
              console.warn(`[RateLimits] Fetch official rate limits failed with status ${res.statusCode}.`);
              sendCodexLocalRateLimitsOrError(clientRes, `OpenAI 后端限额接口 HTTP ${res.statusCode}: ${dataStr || '无法获取真实限额'}`);
              return;
            }
            const data = JSON.parse(dataStr);
            const formatted = formatRateLimits(data);
            if (!formatted.length) {
              sendCodexLocalRateLimitsOrError(clientRes, 'OpenAI 后端限额接口未返回可用窗口数据。');
              return;
            }
            sendJson(clientRes, 200, { ok: true, limits: formatted, source: 'chatgpt-rate-limits' });
          } catch (err) {
            console.warn(`[RateLimits] Parse limits data failed: ${err.message}.`);
            sendCodexLocalRateLimitsOrError(clientRes, '解析 OpenAI 后端限额失败: ' + err.message);
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
      });

      req.on('error', (err) => {
        console.warn(`[RateLimits] Request failed: ${err.message}.`);
        sendCodexLocalRateLimitsOrError(clientRes, '同步 OpenAI 后端限额失败: ' + err.message);
      });

      req.end();
    } catch (err) {
      sendJson(clientRes, 500, { ok: false, error: err.message });
    }
  }

  function sendCodexLocalRateLimitsOrError(clientRes, error) {
    const local = readLatestCodexLocalRateLimits();
    clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    if (local.ok) {
      clientRes.end(JSON.stringify({ ...local, warning: error || undefined }));
    } else {
      clientRes.end(JSON.stringify({ ok: false, limits: [], error: error || local.error }));
    }
  }

  function handleLocalEventsRequest(clientReq, clientRes) {
    try {
      const eventsFile = path.join(DATA_DIR, 'proxy-events.jsonl');
      const parsedUrl = new URL(clientReq.url, `http://${clientReq.headers.host || 'localhost'}`);
      const limit = Math.min(1000, Math.max(1, Number(parsedUrl.searchParams.get('limit') || 200)));
      const after = parsedUrl.searchParams.get('after');
      const afterTime = after ? Date.parse(after) : NaN;
      const readLimit = Number.isFinite(afterTime) ? Math.min(5000, limit * 5) : limit;
      const cacheKey = [eventsFile, fileSignature(eventsFile), limit, after || '', readLimit].join('|');
      if (cacheKey === localEventsResponseCache.key) {
        clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        clientRes.end(localEventsResponseCache.body);
        return;
      }
      let events = readLastLinesOfJsonl(eventsFile, readLimit, 512 * 1024);
      if (Number.isFinite(afterTime)) {
        events = events.filter((event) => Date.parse(event.time || '') > afterTime).slice(-limit);
      } else {
        events = events.slice(-limit);
      }
      const body = JSON.stringify(events);
      localEventsResponseCache = { key: cacheKey, body };
      clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(body);
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalEventsClearRequest(clientReq, clientRes) {
    try {
      const eventsFile = path.join(DATA_DIR, 'proxy-events.jsonl');
      if (fs.existsSync(eventsFile)) {
        fs.writeFileSync(eventsFile, '', 'utf8');
      }
      localEventsResponseCache = { key: '', body: '' };
      localDiagnosticsResponseCache = { key: '', body: '' };
      sendJson(clientRes, 200, { ok: true });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalGetConfigRequest(clientReq, clientRes) {
    try {
      const rawConfig = loadConfig();
      const cloned = JSON.parse(JSON.stringify(rawConfig));
      if (cloned && Array.isArray(cloned.profiles)) {
        for (const profile of cloned.profiles) {
          if (profile && profile.apiKey) {
            profile.apiKey = '[redacted]';
          }
        }
      }
      if (cloned && cloned.claudeDesktop && cloned.claudeDesktop.directApiKey) {
        cloned.claudeDesktop.directApiKey = '[redacted]';
      }
      sendJson(clientRes, 200, cloned);
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalSaveConfigRequest(clientReq, clientRes) {
    const chunks = [];
    clientReq.on('data', chunk => chunks.push(chunk));
    clientReq.on('end', () => {
      try {
        const newConfig = JSON.parse(Buffer.concat(chunks).toString('utf8'));

        const validation = validateConfig(newConfig);
        if (!validation.valid) {
          sendJson(clientRes, 400, { error: 'Invalid configuration: ' + validation.errors.join(', ') });
          return;
        }

        let currentRaw = {};
        try {
          if (fs.existsSync(CONFIG_FILE)) {
            currentRaw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
          }
        } catch (e) {}

        if (newConfig && Array.isArray(newConfig.profiles)) {
          for (const profile of newConfig.profiles) {
            if (!profile) continue;
            const currentProfile = (currentRaw.profiles || []).find(p => p && p.id === profile.id);
            if (profile.apiKey === '[redacted]' || profile.apiKey === '***') {
              profile.apiKey = currentProfile ? currentProfile.apiKey : '';
            }
            if (profile.apiKey && !profile.apiKey.startsWith('hpm-enc:') && !profile.apiKey.startsWith('hpm-dpapi:')) {
              profile.apiKey = encryptKey(profile.apiKey);
            }
          }
        }

        if (newConfig && newConfig.claudeDesktop) {
          if (newConfig.claudeDesktop.directApiKey === '[redacted]' || newConfig.claudeDesktop.directApiKey === '***') {
            newConfig.claudeDesktop.directApiKey = (currentRaw.claudeDesktop && currentRaw.claudeDesktop.directApiKey) || '';
          }
          if (newConfig.claudeDesktop.directApiKey && !newConfig.claudeDesktop.directApiKey.startsWith('hpm-enc:') && !newConfig.claudeDesktop.directApiKey.startsWith('hpm-dpapi:')) {
            newConfig.claudeDesktop.directApiKey = encryptKey(newConfig.claudeDesktop.directApiKey);
          }
        }

        fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2), 'utf8');
        reloadProxyConfig();
        sendJson(clientRes, 200, { ok: true });
      } catch (err) {
        sendJson(clientRes, 400, { error: err.message });
      }
    });
  }

  function handleLocalSetActiveRequest(clientReq, clientRes) {
    const chunks = [];
    clientReq.on('data', chunk => chunks.push(chunk));
    clientReq.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const profileId = String(body.profileId || body.id || '').trim();
        if (!profileId) {
          sendJson(clientRes, 400, { ok: false, error: 'profileId is required' });
          return;
        }

        let rawConfig = {};
        if (fs.existsSync(CONFIG_FILE)) {
          rawConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        } else {
          rawConfig = JSON.parse(JSON.stringify(loadConfig()));
        }

        const profiles = Array.isArray(rawConfig.profiles) ? rawConfig.profiles : [];
        if (!profiles.some((profile) => profile && profile.id === profileId)) {
          sendJson(clientRes, 404, { ok: false, error: 'Profile not found: ' + profileId });
          return;
        }

        rawConfig.activeProfile = profileId;
        const validation = validateConfig(rawConfig);
        if (!validation.valid) {
          sendJson(clientRes, 400, { ok: false, error: 'Invalid configuration: ' + validation.errors.join(', ') });
          return;
        }

        fs.writeFileSync(CONFIG_FILE, JSON.stringify(rawConfig, null, 2), 'utf8');
        reloadProxyConfig();
        sendJson(clientRes, 200, { ok: true, activeProfile: profileId });
      } catch (err) {
        sendJson(clientRes, 400, { ok: false, error: err.message });
      }
    });
  }

  function handleLocalHealthRequest(clientReq, clientRes) {
    const config = currentConfigSnapshot() || {};
    const entryServers = currentEntryServersSnapshot();
    sendJson(clientRes, 200, {
      ok: true,
      appId: APP_ID,
      version: PACKAGE_VERSION,
      status: 'running',
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      ports: {
        management: parseInt(process.env.MGMT_PORT || (config.localServer && config.localServer.managementPort) || (PORT + 100), 10),
        entries: (Array.isArray(entryServers) ? entryServers : []).map((entry) => ({
          protocol: entry.protocol,
          host: entry.host,
          listenPort: entry.listenPort,
          basePath: entry.basePath,
          tls: entry.tls !== false,
        })),
      },
    });
  }

  function handleLocalDiagnosticsGetRequest(clientReq, clientRes) {
    try {
      const config = getDiagnosticsConfig();

      const filesMeta = [
        { label: 'Gemini采样', path: GEMINI_SAMPLE_FILE },
        { label: '工具审计', path: TOOL_AUDIT_FILE },
        { label: '响应采样', path: RESPONSE_SAMPLE_FILE },
        { label: '出站SSE', path: DIAGNOSTICS_OUTBOUND_SSE_FILE },
        { label: '请求工具', path: DIAGNOSTICS_REQUEST_TOOLS_FILE },
        { label: '代理事件', path: PROXY_EVENTS_FILE }
      ];

      const cacheKey = [
        JSON.stringify(config),
        ...filesMeta.map((item) => `${item.path}:${fileSignature(item.path)}`)
      ].join('|');
      if (cacheKey === localDiagnosticsResponseCache.key) {
        clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        clientRes.end(localDiagnosticsResponseCache.body);
        return;
      }

      const files = filesMeta.map(item => {
        const exists = fs.existsSync(item.path);
        const bytes = exists ? fs.statSync(item.path).size : 0;
        return { label: item.label, exists, bytes };
      });

      const output = getFormattedDiagnosticsOutput();

      const body = JSON.stringify({
        ok: true,
        status: {
          config,
          files
        },
        output
      });
      localDiagnosticsResponseCache = { key: cacheKey, body };

      clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(body);
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalDiagnosticsClearRequest(clientReq, clientRes) {
    try {
      const filesToClear = [
        GEMINI_SAMPLE_FILE,
        TOOL_AUDIT_FILE,
        RESPONSE_SAMPLE_FILE,
        DIAGNOSTICS_OUTBOUND_SSE_FILE,
        DIAGNOSTICS_REQUEST_TOOLS_FILE,
        PROXY_EVENTS_FILE
      ];

      for (const file of filesToClear) {
        if (fs.existsSync(file)) {
          fs.writeFileSync(file, '', 'utf8');
        }
      }
      localEventsResponseCache = { key: '', body: '' };
      localDiagnosticsResponseCache = { key: '', body: '' };

      sendJson(clientRes, 200, { ok: true });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalModelsListRequest(clientReq, clientRes) {
    const chunks = [];
    clientReq.on('data', chunk => chunks.push(chunk));
    clientReq.on('end', async () => {
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
        sendJsonLocal({ ok: false, error: '获取上游模型超时，请检查上游地址、代理网络或官方登录凭证。' });
      }, 12000);

      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        let { id, protocol, targetUrl, apiKey } = body;
        if (!targetUrl || !protocol) throw new Error('targetUrl and protocol are required');

        let finalProfile = resolveConfiguredProfile({ id, protocol, targetUrl, apiKey }, id);

        const resolved = await resolveOfficialCredentials({ profile: finalProfile });
        protocol = resolved.profile.protocol || protocol;
        targetUrl = resolved.profile.targetUrl || targetUrl;
        apiKey = resolved.profile.apiKey;

        if (resolved.authProvider === 'google' && resolved.authMode === 'official-login') {
          clearTimeout(hardTimeout);
          try {
            const upstreamModels = await fetchGoogleOfficialAvailableModels(apiKey, resolved.googleOfficialProjectId);
            if (upstreamModels.ok) {
              sendJsonLocal(upstreamModels);
            } else {
              sendJsonLocal({
                ...buildGoogleOfficialModelsResponse(),
                warning: upstreamModels.error,
                source: 'official-model-config-fallback'
              });
            }
          } catch (err) {
            sendJsonLocal({
              ...buildGoogleOfficialModelsResponse(),
              warning: err.message,
              source: 'official-model-config-fallback'
            });
          }
          return;
        }

        if (resolved.authProvider === 'openai' && resolved.authMode === 'official-login' && isOpenAIOfficialCodexTarget(targetUrl)) {
          clearTimeout(hardTimeout);
          sendJsonLocal(buildOpenAIOfficialCodexModelsResponse());
          return;
        }

        if (resolved.authProvider === 'trae' && resolved.authMode === 'official-login') {
          clearTimeout(hardTimeout);
          sendJsonLocal(await buildTraeOfficialModelsResponse());
          return;
        }

        const listRequest = buildModelListRequest(targetUrl, protocol, apiKey);

        const req = requestWithProxy(listRequest.requestUrl, {
          method: listRequest.method,
          headers: listRequest.headers,
          timeout: 8000
        }, (res) => {
          const resChunks = [];
          res.on('data', c => resChunks.push(c));
          res.on('end', () => {
            clearTimeout(hardTimeout);
            const dataStr = Buffer.concat(resChunks).toString('utf8');
            try {
              const resData = JSON.parse(dataStr);
              if (res.statusCode !== 200) {
                const errMsg = resData.error && typeof resData.error === 'object'
                  ? (resData.error.message || JSON.stringify(resData.error))
                  : (resData.error || dataStr || `HTTP ${res.statusCode}`);
                sendJsonLocal({ ok: false, error: errMsg, requestUrl: listRequest.requestUrl.replace(/([?&]key=)[^&]+/, '$1[redacted]') });
                return;
              }
              let models = [];
              if (Array.isArray(resData.models)) {
                models = resData.models.map(m => {
                  if (typeof m === 'string') return m;
                  return m.slug || m.name || m.id || JSON.stringify(m);
                }).map(name => name.replace(/^models\//, ''));
              } else if (Array.isArray(resData.data)) {
                models = resData.data.map(m => {
                  if (typeof m === 'string') return m;
                  return m.id || m.slug || m.name || JSON.stringify(m);
                });
              } else if (resData.models && typeof resData.models === 'object') {
                models = Object.keys(resData.models);
              }
              sendJsonLocal({ ok: true, models, authMode: resolved.authMode || (isGoogleOfficialLoginToken(apiKey) ? 'official-login' : 'api-key'), source: 'upstream-api' });
            } catch (err) {
              if (res.statusCode !== 200) {
                sendJsonLocal({ ok: false, error: `HTTP ${res.statusCode}: ${dataStr || '无法解析的错误响应'}` });
              } else {
                sendJsonLocal({ ok: false, error: '解析模型响应失败: ' + err.message });
              }
            }
          });
        });
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

  function handleLocalAuditConversationsRequest(clientReq, clientRes) {
    try {
      const url = new URL(clientReq.url, `http://${clientReq.headers.host || 'localhost'}`);
      const limit = Number(url.searchParams.get('limit') || 50);
      const records = getAuditRecords(limit);
      sendJson(clientRes, 200, { ok: true, conversations: records });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalAuditConversationsClearRequest(clientReq, clientRes) {
    try {
      const ok = clearAuditRecords();
      sendJson(clientRes, 200, { ok });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function readJsonBodyFromRequest(clientReq, callback) {
    const chunks = [];
    let bytes = 0;
    clientReq.on('data', (chunk) => {
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        chunks.length = 0;
        clientReq.destroy(new Error('Request body too large'));
      }
    });
    clientReq.on('end', () => {
      try {
        const text = Buffer.concat(chunks, bytes).toString('utf8');
        callback(null, text ? JSON.parse(text) : {});
      } catch (err) {
        callback(err);
      }
    });
    clientReq.on('error', (err) => callback(err));
  }

  function localReplayBaseUrl(record) {
    const localServer = currentLocalServerSnapshot();
    const tls = localServer && localServer.tls === false ? false : true;
    const port = Number(record && record.entryPort) || PORT;
    return `${tls ? 'https' : 'http'}://127.0.0.1:${port}`;
  }

  function handleLocalAuditRetryRequest(clientReq, clientRes) {
    readJsonBodyFromRequest(clientReq, async (bodyErr, payload) => {
      if (bodyErr) {
        sendJson(clientRes, 400, { ok: false, error: bodyErr.message });
        return;
      }
      try {
        const record = getAuditRecordById(payload && payload.id);
        if (!record) {
          sendJson(clientRes, 404, { ok: false, error: '未找到对应审计记录' });
          return;
        }
        if (!record.request || !record.request.body || record.request.truncated) {
          sendJson(clientRes, 400, { ok: false, error: '该请求体为空或已截断，无法安全重试' });
          return;
        }

        const replayHeaders = headersForReplay(record.request.headers);
        replayHeaders['content-type'] = replayHeaders['content-type'] || replayHeaders['Content-Type'] || 'application/json';
        replayHeaders['x-hpm-retry-of'] = record.id;
        const replayBody = record.request.body;
        replayHeaders['content-length'] = Buffer.byteLength(replayBody);
        const replayUrl = localReplayBaseUrl(record) + record.path;
        const response = await makeRequest(replayUrl, {
          method: record.method || 'POST',
          headers: replayHeaders,
          timeout: Number(payload && payload.timeout) || 60000,
        }, replayBody);
        const parsed = parseJsonText(response.body);
        sendJson(clientRes, 200, {
          ok: response.statusCode >= 200 && response.statusCode < 300,
          statusCode: response.statusCode,
          headers: redactHeaders(response.headers || {}),
          body: parsed || response.body,
          bodyText: parsed ? '' : response.body,
        });
      } catch (err) {
        sendJson(clientRes, 500, { ok: false, error: err.message });
      }
    });
  }

  function handleLocalUsageReportRequest(clientReq, clientRes) {
    try {
      const url = new URL(clientReq.url, `http://${clientReq.headers.host || 'localhost'}`);
      const limit = Number(url.searchParams.get('limit') || 300);
      const after = url.searchParams.get('after') || '';
      let records = getAuditRecords(limit);
      if (after) {
        const afterTime = Date.parse(after);
        if (Number.isFinite(afterTime)) {
          records = records.filter((record) => Date.parse(record.time || '') >= afterTime);
        }
      }
      const report = buildUsageReport(records, currentConfigSnapshot());
      sendJson(clientRes, 200, report);
    } catch (err) {
      sendJson(clientRes, 500, { ok: false, error: err.message });
    }
  }

  async function testTraeOfficialUpstream(testModel = null) {
    const state = await queryTraeStateRowsForTest();
    if (!state.ok) {
      return {
        ok: false,
        authMode: 'official-login',
        source: 'trae-state-cache',
        error: state.error || 'Trae state cache is not available.'
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
          error: `Trae 模型缓存未返回 ${normalizeTraeOfficialModelName(testModel)}，不要按普通 OpenAI 兼容模型路由。`
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
            : 'Trae 官方登录桥接可达。'
        };
      }
      return {
        ok: false,
        authMode: 'official-login',
        source: 'trae-bridge',
        bridgeUrl,
        error: `Trae bridge 探测失败 HTTP ${res.statusCode}: ${res.body || ''}`
      };
    } catch (err) {
      return {
        ok: false,
        authMode: 'official-login',
        source: 'trae-bridge',
        bridgeUrl,
        error: 'Trae bridge extension is not reachable. Install/reload https-proxy-manager-trae-bridge in Trae, then retry.',
        detail: err.message
      };
    }
  }

  async function testProfileAuthUpstream(protocol, targetUrl, apiKey, testModel = null, authMode = 'api-key') {
    try {
      if (protocol === 'trae' || (authMode === 'official-login' && officialLoginProvider({ protocol, targetUrl, authMode }) === 'trae')) {
        return await testTraeOfficialUpstream(testModel);
      }

      if (protocol === 'openai' && authMode === 'official-login' && isOpenAIOfficialCodexTarget(targetUrl) && testModel) {
        const support = openAIOfficialCodexModelSupport(testModel);
        if (support.known && support.supported) {
          return {
            ok: true,
            authMode,
            source: 'codex-model-cache',
            message: `OpenAI 官方登录凭证已加载；Codex 模型缓存确认 ${support.model} 可用于 API。`
          };
        }
        if (support.known) {
          return {
            ok: false,
            authMode,
            source: 'codex-model-cache',
            error: `Codex 模型 ${support.model} 当前不支持 API 路由。`
          };
        }
        return {
          ok: false,
          authMode,
          source: 'codex-model-cache',
          error: `Codex 官方模型缓存未返回 ${normalizeOpenAIOfficialCodexModelName(testModel)}，不要按 ChatGPT Web 模型列表路由。`
        };
      }

      const probe = buildProfileAuthProbeRequest(protocol, targetUrl, apiKey, testModel, authMode);
      if (probe.unsupported) {
        return { ok: false, error: `Unsupported protocol: ${protocol}` };
      }

      if (protocol === 'openai') {
        const res = await makeRequest(probe.fullUrl, { method: probe.method, headers: probe.headers }, probe.requestBody);
        return evaluateOpenAIProfileAuthResponse(res, { testModel, authMode });
      } else if (protocol === 'gemini') {
        const res = await makeRequest(probe.fullUrl, { method: probe.method, headers: probe.headers }, probe.requestBody);
        return evaluateGeminiProfileAuthResponse(res, { testModel, authMode, probeFullUrl: probe.fullUrl });
      } else if (protocol === 'claude') {
        const res = await makeRequest(probe.fullUrl, { method: probe.method, headers: probe.headers }, probe.requestBody);
        return evaluateClaudeProfileAuthResponse(res, { testModel });
      } else {
        return { ok: false, error: `Unsupported protocol: ${protocol}` };
      }
    } catch (err) {
      return { ok: false, error: `Network error: ${err.message}` };
    }
  }

  function handleLocalProfileTestAuthRequest(clientReq, clientRes) {
    const chunks = [];
    clientReq.on('data', chunk => chunks.push(chunk));
    clientReq.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        let { protocol, targetUrl, profileId, testModel } = body;
        profileId = profileId || body.id;
        let { apiKey } = body;

        if (!protocol || !targetUrl) {
          throw new Error('protocol and targetUrl are required');
        }

        let finalProfile = resolveConfiguredProfile({ id: profileId, protocol, targetUrl, apiKey }, profileId);

        const resolved = await resolveOfficialCredentials({ profile: finalProfile });
        protocol = resolved.profile.protocol || protocol;
        apiKey = resolved.profile.apiKey;
        const finalTargetUrl = resolved.profile.targetUrl || targetUrl;

        const result = await testProfileAuthUpstream(protocol, finalTargetUrl, apiKey, testModel, resolved.authMode || 'api-key');

        sendJson(clientRes, 200, result);
      } catch (err) {
        sendJson(clientRes, 400, { ok: false, error: err.message });
      }
    });
  }

  function readTailText(filePath, maxLines = 300, maxBytes = 256 * 1024) {
    if (!fs.existsSync(filePath)) return '暂无日志记录';
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return '暂无日志记录';

    const safeBytes = Math.min(stat.size, Math.max(8 * 1024, Number(maxBytes || 256 * 1024)));
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(safeBytes);
      fs.readSync(fd, buffer, 0, safeBytes, stat.size - safeBytes);
      const text = buffer.toString('utf8');
      const lines = text.split('\n');
      const safeLines = Math.min(2000, Math.max(1, Number(maxLines || 300)));
      return lines.slice(-safeLines).join('\n');
    } finally {
      fs.closeSync(fd);
    }
  }

  function handleLocalLogRequest(clientReq, clientRes) {
    clientRes.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' });
    const logFile = path.join(DATA_DIR, 'proxy.log');
    const parsedUrl = new URL(clientReq.url, `http://${clientReq.headers.host || 'localhost'}`);
    const full = parsedUrl.searchParams.get('full') === '1';
    if (full && fs.existsSync(logFile)) {
      clientRes.end(fs.readFileSync(logFile, 'utf8'));
      return;
    }
    const maxLines = Number(parsedUrl.searchParams.get('lines') || 300);
    const maxBytes = Number(parsedUrl.searchParams.get('maxBytes') || 256 * 1024);
    const cacheKey = [logFile, fileSignature(logFile), fileSignature(PROXY_EVENTS_FILE), maxLines, maxBytes].join('|');
    if (cacheKey === localLogResponseCache.key) {
      clientRes.end(localLogResponseCache.body);
      return;
    }
    let body = readTailText(logFile, maxLines, maxBytes);
    const recentEvents = formatRecentProxyEventsForLog(30);
    if (recentEvents) {
      body += (body && !body.endsWith('\n') ? '\n' : '') + '\n--- recent proxy events ---\n' + recentEvents;
    }
    localLogResponseCache = { key: cacheKey, body };
    clientRes.end(body);
  }

  function formatRecentProxyEventsForLog(limit) {
    const events = readLastLinesOfJsonl(PROXY_EVENTS_FILE, limit, 256 * 1024);
    if (!events.length) return '';
    return events.map((event) => {
      const time = event.time || '-';
      if (event.kind === 'request_start') {
        return `${time} request_start ${event.method || ''} ${event.path || ''} entry=${event.entryProtocol || '-'}`;
      }
      if (event.kind === 'route') {
        const context = event.estimatedContextTokens ? ` context=${event.estimatedContextTokens}tok` : '';
        return `${time} route ${event.method || ''} ${event.path || ''} ${event.sourceModel || '-'} -> ${event.profileId || '-'}:${event.targetModel || '-'} protocol=${event.protocol || '-'}${context}`;
      }
      if (event.kind === 'request_end') {
        const endpoint = event.upstreamEndpoint ? ` upstream=${event.upstreamEndpoint}` : '';
        return `${time} request_end ${event.method || ''} ${event.path || ''} -> ${event.statusCode || '-'} elapsed=${event.elapsed || 0}ms type=${event.type || '-'}${endpoint}`;
      }
      if (event.kind === 'upstream_error') {
        return `${time} upstream_error ${event.method || ''} ${event.path || ''} -> ${event.code || '-'} model=${event.model || '-'} body=${event.body || ''}`;
      }
      if (event.kind === 'proxy_error') {
        return `${time} proxy_error ${event.method || ''} ${event.path || ''} ${event.code || ''} ${event.error || ''}`;
      }
      return `${time} ${event.kind || 'event'} ${JSON.stringify(event)}`;
    }).join('\n');
  }

  function getFormattedDiagnosticsOutput() {
    const allEvents = [];

    // 1. proxy-events.jsonl (max 100)
    const proxyEvents = readLastLinesOfJsonl(PROXY_EVENTS_FILE, 100);
    for (const item of proxyEvents) {
      const time = item.time || new Date().toISOString();
      let text = '';
      if (item.kind === 'request_start') {
        text = `[Proxy-Request] ${item.method} ${item.path} (clientIp: ${item.clientIp || 'unknown'}, protocol: ${item.entryProtocol || 'unknown'})`;
      } else if (item.kind === 'request_end') {
        text = `[Proxy-Response] ${item.method} ${item.path} -> ${item.statusCode} (elapsed: ${item.elapsed || 0}ms, type: ${(item.extra && item.extra.type) || 'unknown'})`;
      } else if (item.kind === 'upstream_error') {
        text = `[Upstream-Error] ${item.method} ${item.path} -> ${item.code} (model: ${item.model || 'N/A'}, errorBody: ${item.body || ''})`;
      } else if (item.kind === 'proxy_error') {
        text = `[Proxy-Error] ${item.method} ${item.path} (error: ${item.error || 'N/A'})`;
      } else {
        text = `[Event] kind=${item.kind} ${JSON.stringify(item)}`;
      }
      allEvents.push({ time, text });
    }

    // 2. tool-call-audit.jsonl (max 20)
    const toolAudits = readLastLinesOfJsonl(TOOL_AUDIT_FILE, 20);
    for (const item of toolAudits) {
      const time = item.time || new Date().toISOString();
      const text = `[Tool-Audit] tool: ${item.toolName} (source: ${item.source}) - Status: INVALID, Error: ${item.error}`;
      allEvents.push({ time, text });
    }

    // 3. gemini-tool-samples.jsonl (max 20)
    const geminiTools = readLastLinesOfJsonl(GEMINI_SAMPLE_FILE, 20);
    for (const item of geminiTools) {
      const time = item.time || new Date().toISOString();
      const text = `[Gemini-Tool] reason: ${item.reason} - payload: ${JSON.stringify(item.payload)}`;
      allEvents.push({ time, text });
    }

    // 4. diagnostics-outbound-sse.jsonl (max 20)
    const sseSamples = readLastLinesOfJsonl(DIAGNOSTICS_OUTBOUND_SSE_FILE, 20);
    for (const item of sseSamples) {
      const time = item.time || new Date().toISOString();
      const p = item.payload || {};
      const text = `[Outbound-SSE] event: ${p.event} (index: ${p.index}, toolName: ${p.toolName || 'N/A'})`;
      allEvents.push({ time, text });
    }

    // 5. diagnostics-request-tools.jsonl (max 20)
    const requestTools = readLastLinesOfJsonl(DIAGNOSTICS_REQUEST_TOOLS_FILE, 20);
    for (const item of requestTools) {
      const time = item.time || new Date().toISOString();
      const p = item.payload || {};
      const text = `[Request-Tools] model: ${p.model} (messageCount: ${p.messageCount || 0}, uses: ${p.toolUses ? p.toolUses.length : 0}, results: ${p.toolResults ? p.toolResults.length : 0})`;
      allEvents.push({ time, text });
    }

    // 6. Sort chronologically
    allEvents.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

    if (allEvents.length === 0) {
      return '暂无诊断事件。请确保 diagnostics.enabled 在配置文件中开启，并进行了一些代理请求。';
    }

    return allEvents.map(ev => {
      const localTime = new Date(ev.time).toLocaleString();
      return `[${localTime}] ${ev.text}`;
    }).join('\n');
  }

  async function handleLocalEnvCheckRequest(clientReq, clientRes) {
    try {
      const result = await checkEnvironmentTools();
      sendJson(clientRes, 200, { ok: true, ...result });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  async function handleLocalEnvUpgradeRequest(clientReq, clientRes) {
    const chunks = [];
    clientReq.on('data', chunk => chunks.push(chunk));
    clientReq.on('end', async () => {
      try {
        let body = {};
        if (chunks.length > 0) {
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch (e) {}
        }
        const { toolId } = body;
        const toolIds = Array.isArray(body.toolIds) ? body.toolIds.filter(Boolean) : null;
        let targetTools = [];
        if (toolIds && toolIds.length > 0) {
          const allowedIds = new Set(toolIds);
          targetTools = ENV_CHECK_TOOLS.filter(t => allowedIds.has(t.id));
        } else if (toolId) {
          const found = ENV_CHECK_TOOLS.find(t => t.id === toolId);
          if (found) targetTools.push(found);
        } else {
          targetTools = [...ENV_CHECK_TOOLS];
        }

        if (targetTools.length === 0) {
          throw new Error('未找到指定的工具包');
        }

        const results = [];
        for (const tool of targetTools) {
          const job = startToolInstallJob(tool);
          results.push({
            id: tool.id,
            name: tool.name,
            ok: job.status !== 'failed',
            jobId: job.jobId,
            status: job.status,
            error: job.error || null,
            startedAt: job.startedAt,
            endedAt: job.endedAt || null,
            installCommand: job.installCommand,
            usesIrm: job.usesIrm,
            lastLine: job.lastLine || '',
            outputTail: (job.output || '').slice(-2000)
          });
        }

        clearEnvCaches();
        sendJson(clientRes, 200, { ok: true, results });
      } catch (err) {
        sendJson(clientRes, 500, { error: err.message });
      }
    });
  }

  function handleLocalEnvInstallJobsRequest(clientReq, clientRes) {
    try {
      const reqUrl = new URL(clientReq.url, `http://${clientReq.headers.host || 'localhost'}`);
      const ids = (reqUrl.searchParams.get('ids') || '').split(',').map(id => id.trim()).filter(Boolean);
      const jobs = listInstallJobs(ids);
      sendJson(clientRes, 200, { ok: true, jobs });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalSelectDirectoryRequest(clientReq, clientRes) {
    try {
      const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "$code = { Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = '选择工作目录'; $dialog.ShowNewFolderButton = $true; if ($dialog.ShowDialog() -eq 'OK') { $dialog.SelectedPath } }; $thread = [PowerShell]::Create().AddScript($code); $thread.Runspace.ApartmentState = 'STA'; $result = $thread.BeginInvoke(); while (-not $result.IsCompleted) { Start-Sleep -Milliseconds 100 }; $thread.EndInvoke($result)"`;

      cp.exec(cmd, (err, stdout, stderr) => {
        if (err) {
          sendJson(clientRes, 500, { error: err.message });
          return;
        }
        const selectedPath = stdout.trim();
        sendJson(clientRes, 200, { ok: true, path: selectedPath });
      });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  async function handleLocalCliLaunchRequest(clientReq, clientRes) {
    const chunks = [];
    clientReq.on('data', chunk => chunks.push(chunk));
    clientReq.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const { toolId, model, cwd, envs, terminal, upgrade, customArgs } = body;

        if (!toolId) throw new Error('toolId is required');

        const foundTool = ENV_CHECK_TOOLS.find(t => t.id === toolId);
        if (!foundTool) throw new Error('Unknown tool: ' + toolId);

        if (upgrade) {
          await new Promise((resolve) => {
            runToolInstall(foundTool).then((res) => {
              if (!res.ok) {
                console.error(`[cli-launch] Failed to upgrade ${foundTool.name}:`, res.error);
              }
              resolve();
            }).catch((err) => {
              console.error(`[cli-launch] Failed to upgrade ${foundTool.name}:`, err.message);
              resolve();
            });
          });
        }

        const sessionToken = 'hpm-session-' + Math.random().toString(36).substring(2, 10);
        CLI_SESSIONS.set(sessionToken, {
          toolId,
          toolName: foundTool.name,
          modelOverride: model,
          customArgs: customArgs || '',
          createdAt: Date.now(),
          lastUsedAt: 0,
          requestCount: 0
        });

        let proxyUrl = 'https://localhost:3443';
        const entries = currentEntryServersSnapshot();
        const httpsEntry = entries.find(e => e.protocol === 'claude' || e.protocol === 'openai');
        if (httpsEntry) {
          proxyUrl = `${httpsEntry.tls === false ? 'http' : 'https'}://localhost:${httpsEntry.listenPort}`;
        } else {
          const localServer = currentLocalServerSnapshot();
          if (localServer) proxyUrl = `${localServer.tls === false ? 'http' : 'https'}://localhost:${PORT}`;
        }

        const customEnvs = {};
        if (envs && typeof envs === 'string') {
          const lines = envs.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const idx = trimmed.indexOf('=');
            if (idx > 0) {
              const k = trimmed.substring(0, idx).trim();
              const v = trimmed.substring(idx + 1).trim();
              if (k) customEnvs[k] = v;
            }
          }
        }

        const injectedEnvs = {
          'ANTHROPIC_BASE_URL': proxyUrl,
          'ANTHROPIC_API_KEY': sessionToken,
          'ANTHROPIC_AUTH_TOKEN': sessionToken,
          'OPENAI_BASE_URL': proxyUrl + '/v1',
          'OPENAI_API_KEY': sessionToken,
          'GEMINI_API_BASE': proxyUrl + '/v1',
          'GEMINI_API_KEY': sessionToken,
          'GOOGLE_GEMINI_BASE_URL': proxyUrl + '/v1',
          'DEEPSEEK_API_KEY': sessionToken,
          ...customEnvs
        };
        if (toolId === 'claude-code') {
          delete injectedEnvs['ANTHROPIC_AUTH_TOKEN'];
        }

        const workDir = cwd ? path.resolve(cwd) : process.cwd();
        let cliCommand = foundTool.command;
        if (customArgs && typeof customArgs === 'string' && customArgs.trim()) {
          cliCommand += ' ' + customArgs.trim();
        }

        let launchCmd = '';
        if (terminal === 'PowerShell' || terminal === 'powershell') {
          const envSetStatements = Object.keys(injectedEnvs)
            .map(k => {
              const val = injectedEnvs[k] || '';
              return `$env:${k}='${val.replace(/'/g, "''")}'`;
            })
            .join('; ');
          launchCmd = `start powershell -NoExit -Command "Set-Location -Path '${workDir.replace(/'/g, "''")}'; $Host.UI.RawUI.WindowTitle='Claude Code (${model || 'default'})'; ${envSetStatements}; ${cliCommand}"`;
        } else {
          const envSetStatements = Object.keys(injectedEnvs)
            .map(k => `set ${k}=${injectedEnvs[k] || ''}`)
            .join(' && ');
          launchCmd = `cmd /c start cmd /k "title Claude Code (${model || 'default'}) && cd /d ${workDir} && ${envSetStatements} && ${cliCommand}"`;
        }

        console.log(`[cli-launch] Launching ${foundTool.name} via ${terminal} in ${workDir} with args: ${customArgs || 'none'}`);
        cp.exec(launchCmd, { cwd: workDir }, (err) => {
          if (err) {
            console.error(`[cli-launch] Exec error:`, err.message);
          }
        });

        sendJson(clientRes, 200, { ok: true, sessionToken });
      } catch (err) {
        sendJson(clientRes, 500, { error: err.message });
      }
    });
  }

  function handleLocalCliSessionsRequest(clientReq, clientRes) {
    try {
      const list = [];
      for (const [token, session] of CLI_SESSIONS.entries()) {
        list.push({
          sessionToken: token,
          toolId: session.toolId,
          toolName: session.toolName || session.toolId,
          modelOverride: session.modelOverride,
          customArgs: session.customArgs || '',
          createdAt: session.createdAt,
          lastUsedAt: session.lastUsedAt || 0,
          requestCount: session.requestCount || 0
        });
      }
      sendJson(clientRes, 200, { ok: true, sessions: list });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalCliSessionDeleteRequest(clientReq, clientRes) {
    const chunks = [];
    clientReq.on('data', chunk => chunks.push(chunk));
    clientReq.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const { sessionToken } = body;
        if (!sessionToken) throw new Error('sessionToken is required');

        const deleted = CLI_SESSIONS.delete(sessionToken);
        sendJson(clientRes, 200, { ok: true, deleted });
      } catch (err) {
        sendJson(clientRes, 500, { error: err.message });
      }
    });
  }

  function currentConfigSnapshot() {
    return typeof CONFIG === 'function' ? CONFIG() : CONFIG;
  }

  function currentProfilesSnapshot() {
    return typeof PROFILES === 'function' ? PROFILES() : PROFILES;
  }

  function currentLocalServerSnapshot() {
    return typeof LOCAL_SERVER === 'function' ? LOCAL_SERVER() : LOCAL_SERVER;
  }

  function currentEntryServersSnapshot() {
    const entries = typeof ENTRY_SERVERS === 'function' ? ENTRY_SERVERS() : ENTRY_SERVERS;
    return Array.isArray(entries) ? entries : [];
  }

  function readRawConfigSnapshot() {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
    return JSON.parse(JSON.stringify(currentConfigSnapshot() || {}));
  }

  function writeRawConfigSnapshot(nextConfig) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(nextConfig, null, 2), 'utf8');
    reloadProxyConfig();
  }

  function handleLocalRouteTestRequest(clientReq, clientRes) {
    readJsonBodyFromRequest(clientReq, async (bodyErr, body) => {
      if (bodyErr) {
        sendJson(clientRes, 400, { ok: false, error: bodyErr.message });
        return;
      }
      try {
        let { protocol, targetUrl, profileId, apiKey } = body || {};
        const testModel = body && (body.to || body.targetModel || body.testModel);
        profileId = profileId || (body && body.id);
        if (!protocol || !targetUrl) {
          const profile = currentProfilesSnapshot().find((item) => item && item.id === profileId);
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
        const finalProfile = resolveConfiguredProfile({ id: profileId, protocol, targetUrl, apiKey }, profileId);
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

  function handleLocalUsageSummaryRequest(clientReq, clientRes) {
    try {
      sendJson(clientRes, 200, { ok: true, summary: getUsageSummary() });
    } catch (err) {
      sendJson(clientRes, 500, { ok: false, error: err.message });
    }
  }

  function handleLocalPromptsPresetsGetRequest(clientReq, clientRes) {
    handleLocalPromptsPresetsRequest(clientReq, clientRes, currentConfigSnapshot() || {}, writeRawConfigSnapshot);
  }

  function handleLocalPromptsPresetsSaveRequest(clientReq, clientRes) {
    handleLocalPromptsPresetsRequest(clientReq, clientRes, readRawConfigSnapshot(), writeRawConfigSnapshot);
  }

  function handleLocalPromptsPresetsApplyRequest(clientReq, clientRes) {
    handleLocalPromptsPresetsRequest(clientReq, clientRes, currentConfigSnapshot() || {}, writeRawConfigSnapshot);
  }

  function handleLocalMcpHubGetRequest(clientReq, clientRes) {
    try {
      const config = currentConfigSnapshot() || {};
      sendJson(clientRes, 200, { ok: true, mcpHub: config.mcpHub || { servers: [], routing: [] } });
    } catch (err) {
      sendJson(clientRes, 500, { ok: false, error: err.message });
    }
  }

  function handleLocalMcpHubSaveRequest(clientReq, clientRes) {
    readJsonBodyFromRequest(clientReq, (bodyErr, body) => {
      if (bodyErr) {
        sendJson(clientRes, 400, { ok: false, error: bodyErr.message });
        return;
      }
      try {
        const mcpHubConfig = body && body.mcpHub;
        if (!mcpHubConfig || !Array.isArray(mcpHubConfig.servers) || !Array.isArray(mcpHubConfig.routing)) {
          sendJson(clientRes, 400, { ok: false, error: 'mcpHub.servers and mcpHub.routing are required arrays' });
          return;
        }
        const rawConfig = readRawConfigSnapshot();
        rawConfig.mcpHub = {
          servers: mcpHubConfig.servers,
          routing: mcpHubConfig.routing,
        };
        writeRawConfigSnapshot(rawConfig);
        sendJson(clientRes, 200, { ok: true });
      } catch (err) {
        sendJson(clientRes, 500, { ok: false, error: err.message });
      }
    });
  }

  function handleLocalMcpHubLogsRequest(clientReq, clientRes) {
    try {
      const logFile = path.join(DATA_DIR, 'mcp-execution.jsonl');
      const parsedUrl = new URL(clientReq.url, `http://${clientReq.headers.host || 'localhost'}`);
      const maxLines = Number(parsedUrl.searchParams.get('lines') || 200);
      sendJson(clientRes, 200, { ok: true, logs: readTailText(logFile, maxLines, 256 * 1024) });
    } catch (err) {
      sendJson(clientRes, 500, { ok: false, error: err.message });
    }
  }

  return {
    handleLocalLatencyRequest,
    handleLocalClaudeDesktopStatusRequest,
    handleLocalClaudeDesktopApplyRequest,
    handleLocalClaudeDesktopRestoreRequest,
    handleLocalCliCredentialsRequest,
    handleLocalRateLimitsRequest,
    handleLocalEventsRequest,
    handleLocalEventsClearRequest,
    handleLocalGetConfigRequest,
    handleLocalSaveConfigRequest,
    handleLocalSetActiveRequest,
    handleLocalLogRequest,
    handleLocalEnvCheckRequest,
    handleLocalEnvUpgradeRequest,
    handleLocalEnvInstallJobsRequest,
    handleLocalSelectDirectoryRequest,
    handleLocalCliLaunchRequest,
    handleLocalCliSessionsRequest,
    handleLocalCliSessionDeleteRequest,
    handleLocalHealthRequest,
    handleLocalDiagnosticsGetRequest,
    handleLocalDiagnosticsClearRequest,
    handleLocalCertStatusRequest,
    handleLocalCertTrustRequest,
    handleLocalCertUntrustRequest,
    handleLocalTraeStatusRequest,
    handleLocalTraeBridgeStatusRequest,
    handleLocalAntigravityCliStatusRequest,
    handleLocalAntigravityCliApplyRequest,
    handleLocalAntigravityCliRestoreRequest,
    handleLocalClaudeCodeStatusRequest,
    handleLocalClaudeCodeApplyRequest,
    handleLocalClaudeCodeRestoreRequest,
    handleLocalCodexStatusRequest,
    handleLocalCodexApplyRequest,
    handleLocalCodexRestoreRequest,
    handleLocalCodexSwitchRequest,
    handleLocalCodexApiLoginRequest,
    handleLocalCodexOfficialLoginRequest,
    handleLocalCodexAuthBackupRequest,
    handleLocalCodexDesktopStatusRequest,
    handleLocalCodexDesktopApplyRequest,
    handleLocalCodexDesktopRestoreRequest,
    handleLocalCodexDesktopSwitchRequest,
    handleLocalCodexDesktopApiLoginRequest,
    handleLocalCodexDesktopOfficialLoginRequest,
    handleLocalCodexDesktopAuthBackupRequest,
    handleLocalGeminiCliStatusRequest,
    handleLocalGeminiCliApplyRequest,
    handleLocalGeminiCliRestoreRequest,
    handleLocalModelsListRequest,
    handleLocalRouteTestRequest,
    handleLocalAuditConversationsRequest,
    handleLocalAuditConversationsClearRequest,
    handleLocalAuditRetryRequest,
    handleLocalUsageReportRequest,
    handleLocalProfileTestAuthRequest,
    handleLocalUsageSummaryRequest,
    handleLocalPromptsSyncRequest,
    handleLocalPromptsPresetsGetRequest,
    handleLocalPromptsPresetsSaveRequest,
    handleLocalPromptsPresetsApplyRequest,
    handleLocalMcpHubGetRequest,
    handleLocalMcpHubSaveRequest,
    handleLocalMcpHubLogsRequest,
    sendCodexLocalRateLimitsOrError,
  };
}

module.exports = { createManagementHandlers };
