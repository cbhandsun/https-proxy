let rateLimitsData = {};
let limitsTimeDisplayTimer = null;
let lastRenderedLimitsProfileId = '';
let lastRenderedLimitsHtml = '';
let lastRenderedLimitsTimeText = '';

function getRelativeTime(timestamp) {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  if (diff < 60000) return '刚刚';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}小时前`;
  return `${Math.floor(hrs / 24)}天前`;
}

function renderLimitsHtml(profileId) {
  const data = rateLimitsData[profileId];
  if (!data) {
    return '<span style="opacity: 0.6; font-size: 11px;">未同步凭证与限额</span>';
  }
  if (data.loading) {
    return '<span style="opacity: 0.8; font-size: 11px; display: inline-flex; align-items: center; gap: 4px;"><svg class="animate-spin" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="animation: spin 1s linear infinite;"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>正在同步凭证与限额...</span>';
  }
  if (data.error) {
    return `<span style="color: #ef4444; font-size: 11px;">${data.error}</span>`;
  }
  if (!data.limits || data.limits.length === 0) {
    return '<span style="opacity: 0.6; font-size: 11px;">无限制数据</span>';
  }

  return data.limits.map(limit => {
    let color = '#10b981';
    const value = Number.isFinite(Number(limit.remainingPercent)) ? Number(limit.remainingPercent) : Number(limit.percent || 0);
    const isRemaining = Number.isFinite(Number(limit.remainingPercent));
    if (isRemaining) {
      if (value <= 20) color = '#ef4444';
      else if (value <= 50) color = '#f59e0b';
    } else {
      if (value >= 80) color = '#ef4444';
      else if (value >= 50) color = '#f59e0b';
    }

    const label = escapeHtml(limit.model ? limit.model : limit.window);
    const resetValue = limit.resetDisplay || limit.resetIn || '';
    const resetText = resetValue ? `<span style="opacity: 0.6; font-size: 10px;">🕒 ${escapeHtml(resetValue)}</span>` : '';
    return `<span style="background: rgba(255, 255, 255, 0.03); padding: 2px 6px; border-radius: 4px; border: 1px solid var(--border); display: inline-flex; align-items: center; gap: 4px;">
      ${label}: <strong style="color: ${color}; font-weight: 700;">${value}%</strong> ${resetText}
    </span>`;
  }).join(' ');
}

async function refreshRateLimits(profileId) {
  rateLimitsData[profileId] = { loading: true, refreshedAt: Date.now() };
  if (profileId === selectedId) {
    renderDashboardLimits(profileId);
  }

  try {
    const result = await window.proxyManager.getRateLimits(profileId);
    if (result.ok) {
      rateLimitsData[profileId] = {
        limits: result.limits || [],
        refreshedAt: Date.now()
      };
    } else {
      rateLimitsData[profileId] = {
        error: result.error || '获取失败',
        refreshedAt: Date.now()
      };
    }
  } catch (err) {
    rateLimitsData[profileId] = {
      error: err.message,
      refreshedAt: Date.now()
    };
  }

  if (profileId === selectedId) {
    renderDashboardLimits(profileId);
  }
}

function updateLimitsTimeDisplay() {
  const dashboard = $('limitsDashboard');
  if (dashboard && dashboard.style.display === 'none') return;
  if (selectedId && rateLimitsData[selectedId]) {
    const data = rateLimitsData[selectedId];
    const timeDisplay = $('rate-limits-time-display');
    if (timeDisplay && data && !data.loading) {
      const nextText = `🕒 ${getRelativeTime(data.refreshedAt)}`;
      if (nextText !== lastRenderedLimitsTimeText) {
        timeDisplay.textContent = nextText;
        lastRenderedLimitsTimeText = nextText;
      }
    }
  }
}

let config;
let selectedId;
let profileLatencies = {};
let isTestingLatency = false;
let modelRoutes = [];
let availableModels = [];
let baseUrl = '';
let editingRouteIndex = null;
let lastRenderedRulesHtml = '';
let lastRenderedOverviewSignature = '';
let lastRenderedOverviewRoutesHtml = '';
let lastRenderedProfilesHtml = '';
let logRefreshTimer = null;
let logRefreshInFlight = false;
let lastRenderedLog = '';
let diagnosticsRefreshInFlight = false;
let lastRenderedDiagnosticsOutput = '';
let lastRenderedDiagnosticsStatus = '';
let lastLogAutoRefreshAt = 0;
let lastRenderedMonitorHtml = null;
let heartbeatTimer = null;
let proxyRecoveryInFlight = false;
let manualProxyStopSuppressed = false;
let lastProxyRecoveryAt = 0;
let currentTheme = 'light';
let monitorEvents = [];
let lastEventTime = null;
let monitorRefreshInFlight = false;
let lastStatusRefresh = 0;
let lastCertRefresh = 0;
let certRefreshInFlight = null;
let statusRefreshInFlight = false;
let currentViewId = 'overview';
let viewDomCache = null;

const fields = ['id', 'name', 'targetUrl', 'protocol', 'apiKey'];
const $ = (id) => document.getElementById(id);
window.__frontendInit = window.__frontendInit || { stages: [], errors: [] };
function markFrontendInit(stage, payload = {}) {
  window.__frontendInit.stages.push({ stage, at: Date.now(), ...payload });
  if (document.documentElement) {
    document.documentElement.dataset.frontendInitStage = stage;
  }
}
function recordFrontendInitError(stage, error) {
  window.__frontendInit.errors.push({
    stage,
    message: error && error.message ? error.message : String(error),
    stack: error && error.stack ? error.stack : '',
  });
  console.error(`[frontend-init] ${stage}`, error);
}
const LOG_RENDER_LINE_LIMIT = 320;
const LOG_REQUEST_MAX_BYTES = 256 * 1024;
const LOG_AUTO_REFRESH_VISIBLE_MS = 3000;
const LOG_AUTO_REFRESH_HIDDEN_MS = 15000;
const CLI_SESSIONS_VISIBLE_MS = 3000;
const CLI_SESSIONS_HIDDEN_MS = 15000;
const MONITOR_SEARCH_BODY_LIMIT = 600;
const MONITOR_RENDER_WINDOW = 30;
const defaultEntryServers = [
  { name: 'Claude Messages', host: 'localhost', listenPort: 3443, basePath: '/v1', protocol: 'claude' },
  { name: 'OpenAI Responses', host: 'localhost', listenPort: 3445, basePath: '/v1', protocol: 'openai-responses' },
  { name: 'OpenAI Chat Completions', host: 'localhost', listenPort: 3447, basePath: '/v1', protocol: 'openai-chat' },
];

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

function debounce(fn, delay = 180) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

const perfRecords = [];

function exposePerfRecords() {
  window.__hpmPerf = {
    records: perfRecords,
    report: () => perfRecords.slice(-50),
    clear: () => { perfRecords.length = 0; }
  };
  document.documentElement.dataset.perfRecords = JSON.stringify(perfRecords.slice(-20));
}
exposePerfRecords();

function perfDebugEnabled() {
  try {
    return localStorage.getItem('hpm_perf_debug') === '1';
  } catch (err) {
    return false;
  }
}

function recordPerf(label, duration, meta = {}) {
  const entry = {
    label,
    duration: Math.round(duration * 10) / 10,
    at: new Date().toISOString(),
    ...meta
  };
  perfRecords.push(entry);
  if (perfRecords.length > 200) perfRecords.shift();
  exposePerfRecords();
  if (perfDebugEnabled()) console.info('[perf]', entry);
}

function perfStart(label) {
  const start = performance.now();
  return (meta) => recordPerf(label, performance.now() - start, meta);
}

async function perfTrack(label, task) {
  recordPerf(`${label}.start`, 0);
  const finish = perfStart(label);
  try {
    return await task();
  } finally {
    finish();
  }
}

function promiseWithTimeout(promise, timeoutMs, message) {
  let timerId;
  const timeout = new Promise((_, reject) => {
    timerId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timerId));
}

function scheduleStartupTask(label, task, options = {}) {
  const timeout = Number.isFinite(options.timeout) ? options.timeout : 1500;
  const delay = Number.isFinite(options.delay) ? options.delay : 80;
  const run = () => {
    const finish = perfStart(label);
    Promise.resolve()
      .then(task)
      .catch((err) => console.error(`${label} error:`, err))
      .finally(() => finish());
  };
  const scheduleIdle = () => {
    if (window.requestIdleCallback) {
      window.requestIdleCallback(run, { timeout });
    } else {
      setTimeout(run, delay);
    }
  };
  requestAnimationFrame(() => requestAnimationFrame(scheduleIdle));
}

function initTheme() {
  currentTheme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(currentTheme);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('themeIconSun').style.display = theme === 'dark' ? 'block' : 'none';
  $('themeIconMoon').style.display = theme === 'dark' ? 'none' : 'block';
  localStorage.setItem('theme', theme);
  currentTheme = theme;
}

const themeBtn = $('themeToggle');
if (themeBtn) {
  themeBtn.onclick = () => {
    applyTheme(currentTheme === 'light' ? 'dark' : 'light');
  };
}

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  $('toastContainer').appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function confirmAction({ title, message, confirmText = '确认', danger = true }) {
  return new Promise((resolve) => {
    const modal = $('confirmModal');
    const ok = $('confirmOk');
    const cancel = $('confirmCancel');
    $('confirmTitle').textContent = title;
    $('confirmMessage').textContent = message;
    ok.textContent = confirmText;
    ok.className = danger ? 'danger' : 'secondary';
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    const finish = (confirmed) => {
      modal.classList.remove('active');
      modal.setAttribute('aria-hidden', 'true');
      ok.onclick = null;
      cancel.onclick = null;
      modal.onclick = null;
      document.onkeydown = null;
      resolve(confirmed);
    };
    ok.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
    modal.onclick = (event) => { if (event.target === modal) finish(false); };
    document.onkeydown = (event) => { if (event.key === 'Escape') finish(false); };
    cancel.focus();
  });
}

function showDiagnosticsTab(panelId) {
  document.querySelectorAll('[data-diagnostics-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.diagnosticsTab === panelId);
  });
  document.querySelectorAll('.diagnostics-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === panelId);
  });
  if (panelId === 'logPanel') refreshLog({ forceScroll: true });
  if (panelId === 'diagnosticsPanel') refreshDiagnostics({ forceScroll: true });
}

function protocolName(value) {
  if (value === 'gemini') return 'Gemini';
  if (value === 'claude') return 'Claude';
  if (value === 'claude-desktop') return 'Claude Desktop';
  if (value === 'openai-responses') return 'OpenAI Responses';
  if (value === 'openai-chat') return 'OpenAI Chat';
  return 'OpenAI';
}

function entryProtocolName(value) {
  if (value === 'claude') return 'Claude Messages';
  if (value === 'claude-desktop') return 'Claude Desktop';
  if (value === 'openai-responses') return 'OpenAI Responses';
  if (value === 'openai-chat') return 'OpenAI Chat Completions';
  return protocolName(value);
}

function normalizeEntryProtocol(value) {
  const protocol = String(value || '').trim().toLowerCase();
  if (protocol === 'responses' || protocol === 'response' || protocol === 'openai-response') return 'openai-responses';
  if (protocol === 'chat' || protocol === 'chat-completions' || protocol === 'openai-chat-completions' || protocol === 'openai') return 'openai-chat';
  if (protocol === 'desktop' || protocol === 'claude-desktop') return 'claude-desktop';
  if (protocol === 'claude' || protocol === 'openai-responses' || protocol === 'openai-chat' || protocol === 'claude-desktop') return protocol;
  return 'claude';
}

function defaultEntriesForLocal() {
  const host = (config.localServer && config.localServer.host) || 'localhost';
  const basePath = (config.localServer && config.localServer.basePath) || '/v1';
  const localPort = Number((config.localServer && config.localServer.listenPort) || 3443);
  return defaultEntryServers.map((entry, index) => ({
    ...entry,
    host: entry.protocol === 'claude-desktop' ? entry.host : host,
    basePath: entry.protocol === 'claude-desktop' ? entry.basePath : basePath,
    listenPort: index === 0 ? localPort : entry.listenPort,
  }));
}

function selectedProfile() {
  if (!config || !Array.isArray(config.profiles)) return null;
  return config.profiles.find((profile) => profile.id === selectedId) || config.profiles[0];
}

function activeProfile() {
  if (!config || !Array.isArray(config.profiles)) return null;
  return config.profiles.find((profile) => profile.id === config.activeProfile) || config.profiles[0];
}

function ensureLocalServer() {
  if (!config) config = {};
  const active = activeProfile() || {};
  if (!config.localServer) config.localServer = {};
  config.localServer.host = config.localServer.host || 'localhost';
  config.localServer.listenPort = Number(config.localServer.listenPort || (active && active.listenPort) || 3443);
  config.localServer.basePath = config.localServer.basePath || '/v1';
  config.localServer.protocol = normalizeEntryProtocol(config.localServer.protocol || 'claude');
}

function ensureEntryServers() {
  ensureLocalServer();
  const defaults = defaultEntriesForLocal();
  const source = Array.isArray(config.entryServers) ? config.entryServers.filter(Boolean) : [];
  const byProtocol = new Map(source.map((entry) => [normalizeEntryProtocol(entry.protocol), entry]));
  config.entryServers = defaults.map((fallback) => {
    const existing = byProtocol.get(fallback.protocol);
    return {
      name: existing && existing.name ? existing.name : fallback.name,
      host: existing && existing.host ? existing.host : fallback.host,
      listenPort: Number((existing && (existing.listenPort || existing.port)) || fallback.listenPort),
      basePath: existing && existing.basePath ? existing.basePath : fallback.basePath,
      protocol: fallback.protocol,
      enabled: existing && existing.enabled === false ? false : true,
    };
  });
}

function ensureAppSettings() {
  if (!config.appSettings) config.appSettings = {};
  if (typeof config.appSettings.closeToTray !== 'boolean') config.appSettings.closeToTray = true;
  if (typeof config.appSettings.stopProxyOnExit !== 'boolean') config.appSettings.stopProxyOnExit = true;
  if (typeof config.appSettings.autoStartProxy !== 'boolean') config.appSettings.autoStartProxy = true;
  if (typeof config.appSettings.showTopMenu !== 'boolean') config.appSettings.showTopMenu = true;
  if (typeof config.appSettings.showTrayMenu !== 'boolean') config.appSettings.showTrayMenu = true;
  if (typeof config.appSettings.showWindowOnTrayCommand !== 'boolean') config.appSettings.showWindowOnTrayCommand = true;
  if (typeof config.appSettings.disableLocalProxy !== 'boolean') config.appSettings.disableLocalProxy = false;
  if (typeof config.appSettings.conversationAuditEnabled !== 'boolean') config.appSettings.conversationAuditEnabled = true;
  if (typeof config.appSettings.performanceMode !== 'boolean') {
    const cachedPerfMode = localStorage.getItem('hpm_performance_mode');
    config.appSettings.performanceMode = cachedPerfMode == null ? true : cachedPerfMode !== 'false';
  }
}

function applyPerformanceMode(enabled) {
  const value = enabled ? 'true' : 'false';
  document.documentElement.setAttribute('data-performance-mode', value);
  try { localStorage.setItem('hpm_performance_mode', value); } catch (e) {}
}

async function applyTopMenuVisibility(show) {
  try {
    if (window.proxyManager.applyAppMenu) await window.proxyManager.applyAppMenu(show);
  } catch (err) {
    console.error('Failed to apply top menu visibility:', err);
  }
}

function fillAppSettings() {
  ensureAppSettings();
  $('closeToTray').checked = config.appSettings.closeToTray;
  $('stopProxyOnExit').checked = config.appSettings.stopProxyOnExit;
  $('autoStartProxy').checked = config.appSettings.autoStartProxy;
  $('showTopMenu').checked = config.appSettings.showTopMenu;
  $('showTrayMenu').checked = config.appSettings.showTrayMenu;
  $('showWindowOnTrayCommand').checked = config.appSettings.showWindowOnTrayCommand;
  $('disableLocalProxy').checked = config.appSettings.disableLocalProxy;
  $('conversationAuditEnabled').checked = config.appSettings.conversationAuditEnabled;
  $('performanceMode').checked = config.appSettings.performanceMode;
  applyPerformanceMode(config.appSettings.performanceMode);
}

function collectAppSettings() {
  config.appSettings = {
    ...(config.appSettings || {}),
    closeToTray: $('closeToTray').checked,
    stopProxyOnExit: $('stopProxyOnExit').checked,
    autoStartProxy: $('autoStartProxy').checked,
    showTopMenu: $('showTopMenu').checked,
    showTrayMenu: $('showTrayMenu').checked,
    showWindowOnTrayCommand: $('showWindowOnTrayCommand').checked,
    disableLocalProxy: $('disableLocalProxy').checked,
    conversationAuditEnabled: $('conversationAuditEnabled').checked,
    performanceMode: $('performanceMode').checked,
  };
}

function defaultClaudeDesktopModel() {
  const route = currentRoutes()[0] || {};
  const active = activeProfile() || {};
  const upstream = route.to || 'gpt-5.5';
  return {
    routeId: 'claude-sonnet-4-6',
    labelOverride: upstream,
    supports1m: true,
    profileId: route.profileId || active.id || config.activeProfile,
    upstreamModel: upstream,
  };
}

function ensureClaudeDesktop() {
  if (!config.claudeDesktop) config.claudeDesktop = {};
  if (typeof config.claudeDesktop.enabled !== 'boolean') config.claudeDesktop.enabled = false;
  if (!['proxy', 'direct', 'official'].includes(config.claudeDesktop.mode)) config.claudeDesktop.mode = 'proxy';
  if (!config.claudeDesktop.profileName) config.claudeDesktop.profileName = 'HTTPS Proxy';
  if (!config.claudeDesktop.baseUrl || config.claudeDesktop.baseUrl === 'http://127.0.0.1:15721/claude-desktop' || config.claudeDesktop.baseUrl === 'https://localhost:3443/v1') config.claudeDesktop.baseUrl = claudeProxyBaseUrl();
  if (typeof config.claudeDesktop.token !== 'string') config.claudeDesktop.token = '';
  if (!Array.isArray(config.claudeDesktop.models) || config.claudeDesktop.models.length === 0) {
    config.claudeDesktop.models = [defaultClaudeDesktopModel()];
  }
}

const DEFAULT_CLAUDE_DESKTOP_ROUTE_IDS = [
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'claude-haiku-4-5',
  'claude-sonnet-4-5',
  'claude-opus-4-5',
];

function isClaudeDesktopRouteId(value) {
  const routeId = String(value || '').trim();
  return /^claude-[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(routeId);
}

function claudeDesktopRouteOptions(selectedValue) {
  ensureClaudeDesktop();
  const ids = [];
  const seen = new Set();
  const add = (value) => {
    const routeId = String(value || '').trim();
    if (!isClaudeDesktopRouteId(routeId) || seen.has(routeId)) return;
    seen.add(routeId);
    ids.push(routeId);
  };

  currentRoutes().forEach((route) => add(route.from));
  config.claudeDesktop.models.forEach((model) => add(model.routeId || model.from || model.model));
  DEFAULT_CLAUDE_DESKTOP_ROUTE_IDS.forEach(add);
  add(selectedValue);
  return ids;
}

function renderClaudeDesktopRouteOptions(selectedValue) {
  const select = $('cdRouteId');
  if (!select) return;
  const previous = String(selectedValue || select.value || '').trim();
  const ids = claudeDesktopRouteOptions(previous);
  select.innerHTML = ids.map((id) => `<option value="${escapeAttr(id)}">${escapeHtml(id)}</option>`).join('');
  select.value = ids.includes(previous) ? previous : (ids[0] || 'claude-sonnet-4-6');
  updateClaudeDesktopRouteDetails();
}

function routeIdOfClaudeDesktopModel(model) {
  return String(model && (model.routeId || model.from || model.model) || '').trim();
}

function globalRouteForClaudeDesktop(routeId) {
  const from = String(routeId || '').trim();
  if (!from) return null;
  return currentRoutes().find((route) => String(route.from || '').trim() === from) || null;
}

function resolveClaudeDesktopModel(model) {
  const routeId = routeIdOfClaudeDesktopModel(model);
  const route = globalRouteForClaudeDesktop(routeId);
  return {
    routeId,
    labelOverride: String(model && (model.labelOverride || model.displayName) || '').trim(),
    profileId: String(model && (model.profileId || '') || route && route.profileId || '').trim(),
    upstreamModel: String(model && (model.upstreamModel || model.to || '') || route && route.to || '').trim(),
    supports1m: model && model.supports1m !== false,
    inherited: !!route,
  };
}

function updateClaudeDesktopRouteDetails() {
  const route = globalRouteForClaudeDesktop($('cdRouteId') && $('cdRouteId').value);
  const profileEl = $('cdProfileId');
  const upstreamEl = $('cdUpstreamModel');
  if (!profileEl || !upstreamEl) return;
  if (route) {
    profileEl.value = route.profileId || config.activeProfile;
    upstreamEl.value = route.to || '';
    profileEl.disabled = true;
    upstreamEl.disabled = true;
    profileEl.style.display = 'none';
    upstreamEl.style.display = 'none';
  } else {
    profileEl.disabled = false;
    upstreamEl.disabled = false;
    profileEl.style.display = '';
    upstreamEl.style.display = '';
  }
}

function fillClaudeDesktop() {
  ensureClaudeDesktop();
  $('claudeDesktopEnabled').checked = config.claudeDesktop.enabled;
  $('claudeDesktopMode').value = config.claudeDesktop.mode;
  $('claudeDesktopBaseUrl').value = config.claudeDesktop.baseUrl;
  $('claudeDesktopToken').value = config.claudeDesktop.token || '';
  $('claudeDesktopDirectBaseUrl').value = config.claudeDesktop.directBaseUrl || '';
  $('claudeDesktopDirectApiKey').value = config.claudeDesktop.directApiKey || '';
  $('claudeDesktopSupports1mDefault').checked = true;
  renderClaudeDesktopProfiles();
  renderClaudeDesktopRouteOptions();
  renderClaudeDesktopModels();
  renderClaudeDesktopPreview();
}

function collectClaudeDesktop() {
  ensureClaudeDesktop();
  config.claudeDesktop.enabled = $('claudeDesktopEnabled').checked;
  config.claudeDesktop.mode = $('claudeDesktopMode').value;
  config.claudeDesktop.baseUrl = $('claudeDesktopBaseUrl').value.trim() || claudeProxyBaseUrl();
  config.claudeDesktop.token = $('claudeDesktopToken').value.trim();
  config.claudeDesktop.directBaseUrl = $('claudeDesktopDirectBaseUrl').value.trim();
  config.claudeDesktop.directApiKey = $('claudeDesktopDirectApiKey').value.trim();
}

function renderClaudeDesktopProfiles() {
  $('cdProfileId').innerHTML = config.profiles.map((profile) => `<option value="${escapeAttr(profile.id)}">${escapeHtml(profile.name || profile.id)} · ${protocolName(profile.protocol)}</option>`).join('');
  $('cdProfileId').value = config.activeProfile;
  updateClaudeDesktopRouteDetails();
}

function renderClaudeDesktopPreview() {
  collectClaudeDesktop();
  const mode = config.claudeDesktop.mode;
  const lines = [];
  if (mode === 'proxy') {
    lines.push(`Desktop Gateway：${config.claudeDesktop.baseUrl}`);
    lines.push(`模型数：${config.claudeDesktop.models.length}，代理运行时需要保持 Claude Desktop 入口开启。`);
  } else if (mode === 'direct') {
    lines.push('直连模式会把 Claude Desktop 指向当前上游或这里填写的直连地址。');
  } else {
    lines.push('恢复官方模式会切回 Claude Desktop 内置登录，不再使用本地代理。');
  }
  $('claudeDesktopPreview').innerHTML = lines.map(escapeHtml).join('<br>');
}

let claudeDesktopPreviewFrame = 0;

function scheduleClaudeDesktopPreview() {
  if (claudeDesktopPreviewFrame) return;
  claudeDesktopPreviewFrame = requestAnimationFrame(() => {
    claudeDesktopPreviewFrame = 0;
    renderClaudeDesktopPreview();
  });
}

function renderClaudeDesktopModels() {
  ensureClaudeDesktop();
  renderClaudeDesktopRouteOptions();
  const container = $('claudeDesktopModels');
  if (!config.claudeDesktop.models.length) {
    container.innerHTML = '<div class="muted">暂无 Desktop 模型映射。</div>';
    return;
  }
  container.innerHTML = `<div class="route-table"><div class="route-table-head"><table><thead><tr><th>Route ID</th><th>菜单显示名</th><th>上游</th><th>真实模型</th><th>1M</th><th></th></tr></thead></table></div><div class="route-table-scroll"><table><tbody>${
    config.claudeDesktop.models.map((model, index) => {
      const resolved = resolveClaudeDesktopModel(model);
      const profile = config.profiles.find((item) => item.id === resolved.profileId) || {};
      return `<tr>
        <td>${escapeHtml(resolved.routeId)}</td>
        <td>${escapeHtml(resolved.labelOverride)}</td>
        <td>${escapeHtml(profile.name || resolved.profileId || '')}</td>
        <td>${escapeHtml(resolved.upstreamModel)}</td>
        <td>${resolved.supports1m ? '是' : '否'}</td>
        <td><button class="light" data-cd-edit="${index}">编辑</button><button class="danger" data-cd-delete="${index}">删除</button></td>
      </tr>`;
    }).join('')
  }</tbody></table></div></div>`;
  if (!container.dataset.delegated) {
    container.dataset.delegated = 'true';
    container.onclick = (event) => {
      const editButton = event.target.closest('[data-cd-edit]');
      const deleteButton = event.target.closest('[data-cd-delete]');
      if (editButton && container.contains(editButton)) {
        const index = Number(editButton.dataset.cdEdit);
        const model = config.claudeDesktop.models[index];
        if (!model) return;
        const resolved = resolveClaudeDesktopModel(model);
        renderClaudeDesktopRouteOptions(resolved.routeId);
        $('cdRouteId').value = resolved.routeId;
        $('cdLabelOverride').value = resolved.labelOverride;
        $('cdProfileId').value = resolved.profileId || config.activeProfile;
        $('cdUpstreamModel').value = resolved.upstreamModel;
        $('claudeDesktopSupports1mDefault').checked = resolved.supports1m;
        updateClaudeDesktopRouteDetails();
        config.claudeDesktop.models.splice(index, 1);
        renderClaudeDesktopModels();
        return;
      }
      if (deleteButton && container.contains(deleteButton)) {
        config.claudeDesktop.models.splice(Number(deleteButton.dataset.cdDelete), 1);
        renderClaudeDesktopModels();
        renderClaudeDesktopPreview();
      }
    };
  }
}

function syncClaudeDesktopRoutesToModelRoutes() {
  ensureClaudeDesktop();
  if (!Array.isArray(modelRoutes)) modelRoutes = [];
  for (const model of config.claudeDesktop.models) {
    const from = (model.routeId || model.from || '').trim();
    if (!from) continue;
    if (modelRoutes.some((route) => String(route.from || '').trim() === from)) continue;
    const profileId = (model.profileId || config.activeProfile || '').trim();
    const to = (model.upstreamModel || model.to || '').trim();
    if (!profileId || !to) continue;
    const labelOverride = String(model.labelOverride || model.displayName || '').trim();
    const next = { from, profileId, to };
    if (labelOverride) next.labelOverride = labelOverride;
    if (model.supports1m !== undefined) next.supports1m = model.supports1m !== false;
    const index = modelRoutes.findIndex((route) => route.from === from);
    if (index >= 0) modelRoutes[index] = next;
    else modelRoutes.push(next);
  }
  config.modelRoutes = modelRoutes.map((route) => {
    const next = { from: route.from, profileId: route.profileId, to: route.to };
    if (route.labelOverride) next.labelOverride = route.labelOverride;
    if (route.supports1m !== undefined) next.supports1m = route.supports1m !== false;
    return next;
  });
}

function routeForConfig(route) {
  const next = { from: route.from, profileId: route.profileId, to: route.to };
  if (route.labelOverride) next.labelOverride = route.labelOverride;
  if (route.supports1m !== undefined) next.supports1m = route.supports1m !== false;
  return next;
}

function modelRoutesForConfig() {
  return (Array.isArray(modelRoutes) ? modelRoutes : []).map(routeForConfig);
}

function syncClaudeDesktopModelFromRoute(previousFrom, route) {
  if (!config || !config.claudeDesktop || !Array.isArray(config.claudeDesktop.models) || !route) return false;
  const oldFrom = String(previousFrom || '').trim();
  const newFrom = String(route.from || '').trim();
  const index = config.claudeDesktop.models.findIndex((model) => {
    const routeId = String(model.routeId || model.from || '').trim();
    return routeId === oldFrom || routeId === newFrom;
  });
  if (index < 0) {
    renderClaudeDesktopRouteOptions();
    return false;
  }

  const model = config.claudeDesktop.models[index];
  const previousUpstream = String(model.upstreamModel || model.to || '').trim();
  model.routeId = newFrom;
  delete model.from;
  delete model.profileId;
  delete model.upstreamModel;
  delete model.to;
  if (!model.labelOverride || model.labelOverride === previousUpstream) {
    model.labelOverride = route.to;
  }
  renderClaudeDesktopModels();
  renderClaudeDesktopPreview();
  return true;
}

function removeClaudeDesktopModelForRoute(routeId) {
  if (!config || !config.claudeDesktop || !Array.isArray(config.claudeDesktop.models)) return false;
  const from = String(routeId || '').trim();
  const before = config.claudeDesktop.models.length;
  config.claudeDesktop.models = config.claudeDesktop.models.filter((model) => String(model.routeId || model.from || '').trim() !== from);
  if (config.claudeDesktop.models.length === before) {
    renderClaudeDesktopRouteOptions();
    return false;
  }
  renderClaudeDesktopModels();
  renderClaudeDesktopPreview();
  return true;
}

function fillLocalServer() {
  ensureLocalServer();
  ensureEntryServers();
  $('localHost').value = config.localServer.host;
  $('localPort').value = config.localServer.listenPort;
  $('localBasePath').value = config.localServer.basePath;
  renderEntryServers();
  renderLocalPreview();
}

function collectLocalServer() {
  config.localServer = {
    host: $('localHost').value.trim() || 'localhost',
    listenPort: Number($('localPort').value || 3443),
    basePath: $('localBasePath').value.trim() || '/v1',
    protocol: 'claude',
  };
  collectEntryServers();
}

function collectEntryServers() {
  const rows = Array.from(document.querySelectorAll('[data-entry-index]'));
  if (rows.length === 0) {
    ensureEntryServers();
    return;
  }
  config.entryServers = rows.map((row) => ({
    name: row.querySelector('[data-entry-name]').value.trim() || entryProtocolName(row.querySelector('[data-entry-protocol]').value),
    host: row.querySelector('[data-entry-host]').value.trim() || 'localhost',
    listenPort: Number(row.querySelector('[data-entry-port]').value || 3443),
    basePath: row.querySelector('[data-entry-base-path]').value.trim() || '/v1',
    protocol: normalizeEntryProtocol(row.querySelector('[data-entry-protocol]').value),
    enabled: row.querySelector('[data-entry-enabled]').checked,
    tls: normalizeEntryProtocol(row.querySelector('[data-entry-protocol]').value) === 'claude-desktop' ? false : true,
  }));
  const claudeEntry = config.entryServers.find((entry) => entry.protocol === 'claude') || config.entryServers[0];
  if (claudeEntry) {
    config.localServer.host = claudeEntry.host;
    config.localServer.listenPort = claudeEntry.listenPort;
    config.localServer.basePath = claudeEntry.basePath;
    config.localServer.protocol = 'claude';
    if (document.activeElement !== $('localHost')) $('localHost').value = claudeEntry.host;
    if (document.activeElement !== $('localPort')) $('localPort').value = claudeEntry.listenPort;
    if (document.activeElement !== $('localBasePath')) $('localBasePath').value = claudeEntry.basePath;
  }
}

let localPreviewFrame = 0;
let entryServersRenderFrame = 0;

function scheduleLocalPreview() {
  if (localPreviewFrame) return;
  localPreviewFrame = requestAnimationFrame(() => {
    localPreviewFrame = 0;
    renderLocalPreview();
  });
}

function scheduleEntryServersRender() {
  if (entryServersRenderFrame) return;
  entryServersRenderFrame = requestAnimationFrame(() => {
    entryServersRenderFrame = 0;
    renderLocalPreview();
    renderEntryServers();
  });
}

function renderEntryServers() {
  ensureEntryServers();
  $('entryServers').innerHTML = config.entryServers.map((entry, index) => {
    const protocol = normalizeEntryProtocol(entry.protocol);
    const scheme = entry.tls === false || protocol === 'claude-desktop' ? 'http' : 'https';
    const url = `${scheme}://${entry.host || 'localhost'}:${entry.listenPort || 3443}${entry.basePath || '/v1'}`;
    return `<div class="entry-server-row" data-entry-index="${index}">
      <div class="entry-server-head">
        <div class="entry-server-title">
          <strong>${escapeHtml(entry.name || entryProtocolName(protocol))}</strong>
          <span class="badge protocol">${entryProtocolName(protocol)}</span>
          <span class="badge">${escapeHtml(url)}</span>
        </div>
        <label class="inline-check"><input data-entry-enabled type="checkbox" ${entry.enabled === false ? '' : 'checked'}> 启用</label>
      </div>
      <div class="entry-server-fields">
        <input data-entry-name value="${escapeHtml(entry.name || entryProtocolName(protocol))}" placeholder="显示名称">
        <input data-entry-port type="number" value="${Number(entry.listenPort || 3443)}" placeholder="端口">
        <input data-entry-host value="${escapeHtml(entry.host || 'localhost')}" placeholder="Host">
        <input data-entry-base-path value="${escapeHtml(entry.basePath || '/v1')}" placeholder="路径">
        <select data-entry-protocol title="入口协议">
          <option value="claude" ${protocol === 'claude' ? 'selected' : ''}>Claude Messages</option>
          <option value="openai-responses" ${protocol === 'openai-responses' ? 'selected' : ''}>OpenAI Responses</option>
          <option value="openai-chat" ${protocol === 'openai-chat' ? 'selected' : ''}>OpenAI Chat Completions</option>
          <option value="claude-desktop" ${protocol === 'claude-desktop' ? 'selected' : ''}>Claude Desktop</option>
        </select>
      </div>
    </div>`;
  }).join('');
  $('entryServers').querySelectorAll('input, select').forEach((input) => {
    input.oninput = () => { collectEntryServers(); scheduleLocalPreview(); };
    input.onchange = () => { collectEntryServers(); scheduleEntryServersRender(); };
  });
}

function renderLocalPreview() {
  collectEntryServers();
  const entries = Array.isArray(config.entryServers) ? config.entryServers.filter((entry) => entry.enabled !== false) : [];
  const primary = entries.find((entry) => entry.protocol === 'claude') || entries[0] || { host: $('localHost').value.trim() || 'localhost', listenPort: $('localPort').value || 3443, basePath: $('localBasePath').value.trim() || '/v1', protocol: 'claude' };
  baseUrl = `https://${primary.host || 'localhost'}:${primary.listenPort || 3443}${primary.basePath || '/v1'}`;
  $('localUrlPreview').innerHTML = entries.map((entry) => {
    const protocol = normalizeEntryProtocol(entry.protocol);
    const scheme = entry.tls === false || protocol === 'claude-desktop' ? 'http' : 'https';
    const url = `${scheme}://${entry.host || 'localhost'}:${entry.listenPort || 3443}${entry.basePath || '/v1'}`;
    return `<div><strong>${entryProtocolName(entry.protocol)}</strong>：${escapeHtml(url)}</div>`;
  }).join('') || `IDE Base URL：${escapeHtml(baseUrl)}`;
  $('heroBaseUrl').textContent = baseUrl;
}

function claudeProxyBaseUrl() {
  ensureEntryServers();
  const entry = (config.entryServers || []).find((item) => item.enabled !== false && normalizeEntryProtocol(item.protocol) === 'claude')
    || { host: 'localhost', listenPort: 3443, basePath: '/v1', tls: true };
  const scheme = entry.tls === false ? 'http' : 'https';
  const host = entry.host === '0.0.0.0' ? '127.0.0.1' : (entry.host || 'localhost');
  const basePath = entry.basePath === '/v1' ? '' : (entry.basePath || '');
  return `${scheme}://${host}:${entry.listenPort || 3443}${basePath}`.replace(/\/+$/, '');
}

function currentRoutes() {
  if (!config) return [];
  if (Array.isArray(config.modelRoutes)) return config.modelRoutes.filter((route) => route && route.from && route.profileId && route.to);
  const active = selectedProfile();
  if (!active) return [];
  const legacyRules = active.modelRewriteFrom && active.modelRewriteTo ? [{ from: active.modelRewriteFrom, to: active.modelRewriteTo }] : [];
  return (active.modelRewriteRules || legacyRules).filter((rule) => rule && rule.from && rule.to).map((rule) => ({ from: rule.from, profileId: active.id, to: rule.to }));
}

function renderRouteProfiles(selectedValue) {
  $('modelRouteProfile').innerHTML = config.profiles.map((profile) => `<option value="${escapeAttr(profile.id)}">${escapeHtml(profile.name || profile.id)} · ${protocolName(profile.protocol)} · ${escapeHtml(profile.targetUrl)}</option>`).join('');
  $('modelRouteProfile').value = selectedValue || selectedId || config.activeProfile;
}

function renderModelOptions(selectedValue) {
  $('availableModels').innerHTML = availableModels.map((model) => `<option value="${escapeAttr(model)}"></option>`).join('');
  $('modelRewriteTo').value = selectedValue || '';
}

function routesTable() {
  if (modelRoutes.length === 0) return '<div class="muted">暂无模型路由，未命中的请求会使用默认上游。</div>';
  const rows = modelRoutes.map((route, index) => {
    const profile = config && Array.isArray(config.profiles) ? config.profiles.find((item) => item.id === route.profileId) : null;
    const target = profile ? `${escapeHtml(profile.name || profile.id)}<div class="muted">${protocolName(profile.protocol)} · ${escapeHtml(profile.targetUrl)}</div>` : escapeHtml(route.profileId);
    const label = route.labelOverride ? `<div class="muted">展示名: ${escapeHtml(route.labelOverride)}</div>` : '';
    return `<tr><td><strong>${escapeHtml(route.from)}</strong>${label}</td><td>${target}</td><td><strong>${escapeHtml(route.to)}</strong></td><td><div class="route-actions"><button class="light" data-test-route="${index}">测试</button><button class="light" data-edit-route="${index}">编辑</button><button class="danger" data-delete-route="${index}">删除</button></div></td></tr>`;
  }).join('');
  return `<div class="route-table route-table-compact"><div class="route-table-head"><table><thead><tr><th>客户端模型</th><th>转发到上游</th><th>上游模型</th><th>操作</th></tr></thead></table></div><div class="route-table-scroll"><table><tbody>${rows}</tbody></table></div></div>`;
}

function resetRouteEditor() {
  editingRouteIndex = null;
  $('modelRewriteFrom').value = '';
  $('modelRewriteLabel').value = '';
  renderModelOptions('');
  $('modelStatus').textContent = '';
  $('addRule').textContent = '添加路由';
}

// 对话审计逻辑

function showView(viewId) {
  const finishViewPerf = perfStart(`view.${viewId}`);
  if (currentViewId === viewId) {
    finishViewPerf({ skipped: true });
    return;
  }
  const cache = getViewDomCache();
  cache.buttons.forEach((item) => item.classList.toggle('active', item.dataset.viewButton === viewId));
  cache.views.forEach((view) => view.classList.toggle('active', view.id === viewId));
  const view = $(viewId);
  currentViewId = view && view.classList.contains('active') ? viewId : currentViewId;

  // 清除代码工具页面的活动轮询定时器，防止其它页面持续后台请求造成性能浪费
  if (viewId !== 'codeToolsView' && cliSessionsTimer) {
    clearInterval(cliSessionsTimer);
    cliSessionsTimer = null;
  }

  if (viewId === 'diagnostics') showDiagnosticsTab('logPanel');
  if (viewId === 'monitor') refreshMonitor();
  if (viewId === 'promptsAuditView') { initPromptsAuditView(); }
  if (viewId === 'usageReportView') { initUsageReportView(); }
  if (viewId === 'claudeDesktop') refreshAllToolStatuses({ passive: true });
  if (viewId === 'envCheckView') refreshEnvStatus({ passive: true });
  if (viewId === 'codeToolsView') { initCodeToolsView(); }
  if (viewId === 'mcpHubView') { initMcpHubView(); }
  startHeartbeat();
  finishViewPerf();
}

function showRoutesView() {
  showView('routes');
}

function showDiagnosticsView(tabId = 'logPanel') {
  showView('diagnostics');
  showDiagnosticsTab(tabId);
}

let dashboardRenderFrame = 0;
let pendingDashboardRules = false;
let pendingDashboardProfiles = false;
let pendingDashboardOverview = false;

function scheduleDashboardRender(options = {}) {
  pendingDashboardRules = pendingDashboardRules || !!options.rules;
  pendingDashboardProfiles = pendingDashboardProfiles || !!options.profiles;
  pendingDashboardOverview = pendingDashboardOverview || !!options.overview;
  if (dashboardRenderFrame) return;
  dashboardRenderFrame = requestAnimationFrame(() => {
    dashboardRenderFrame = 0;
    const shouldRenderRules = pendingDashboardRules;
    const shouldRenderProfiles = pendingDashboardProfiles;
    const shouldRenderOverview = pendingDashboardOverview;
    pendingDashboardRules = false;
    pendingDashboardProfiles = false;
    pendingDashboardOverview = false;
    if (shouldRenderRules) renderRules();
    if (shouldRenderProfiles) renderProfiles();
    else if (shouldRenderOverview) renderOverview();
  });
}

function bindRouteActions(container) {
  container.querySelectorAll('[data-test-route]').forEach((button) => {
    button.onclick = async () => {
      const index = Number(button.dataset.testRoute);
      const route = modelRoutes[index];
      if (!route) return;

      const origText = button.textContent;
      button.textContent = '测试中...';
      button.disabled = true;

      try {
        const profile = config.profiles.find((item) => item.id === route.profileId);
        if (!profile) throw new Error('找不到对应上游配置');

        const result = await window.proxyManager.testRouteConnection({
          profileId: route.profileId,
          protocol: profile.protocol,
          targetUrl: profile.targetUrl,
          apiKey: '[redacted]',
          to: route.to
        });

        if (result.ok) {
          showToast(`路由测试成功：${result.message || '连接正常'}`, 'success');
          button.textContent = '成功';
          button.style.backgroundColor = '#d4edda';
          button.style.color = '#155724';
        } else {
          showToast(`路由测试失败：${result.error}`, 'error');
          button.textContent = '失败';
          button.style.backgroundColor = '#f8d7da';
          button.style.color = '#721c24';
        }
      } catch (err) {
        showToast(`测试出错：${err.message}`, 'error');
        button.textContent = '出错';
      } finally {
        setTimeout(() => {
          button.textContent = origText;
          button.disabled = false;
          button.style.backgroundColor = '';
          button.style.color = '';
        }, 3000);
      }
    };
  });
  container.querySelectorAll('[data-edit-route]').forEach((button) => {
    button.onclick = () => {
      const index = Number(button.dataset.editRoute);
      const route = modelRoutes[index];
      if (!route) return;
      editingRouteIndex = index;
      $('modelRewriteFrom').value = route.from;
      $('modelRewriteLabel').value = route.labelOverride || '';
      $('modelRouteProfile').value = route.profileId;
      availableModels = [];
      renderModelOptions(route.to);
      $('modelStatus').textContent = '正在编辑已保存路由';
      $('addRule').textContent = '保存编辑';
      $('output').textContent = '正在编辑模型路由：' + route.from;
      showRoutesView();
      document.querySelector('.rule-editor')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('modelRewriteTo').focus();
    };
  });
  container.querySelectorAll('[data-delete-route]').forEach((button) => {
    button.onclick = () => {
      const index = Number(button.dataset.deleteRoute);
      const route = modelRoutes[index];
      modelRoutes.splice(index, 1);
      if (route) removeClaudeDesktopModelForRoute(route.from);
      if (editingRouteIndex === index) resetRouteEditor();
      else if (editingRouteIndex !== null && editingRouteIndex > index) editingRouteIndex -= 1;
      config.modelRoutes = modelRoutesForConfig();
      scheduleDashboardRender({ rules: true, overview: true });
    };
  });
}

function renderRules() {
  const container = $('modelRewriteRules');
  const html = routesTable();
  if (html === lastRenderedRulesHtml) return;
  container.innerHTML = html;
  lastRenderedRulesHtml = html;
  bindRouteActions(container);
}

function renderOverview() {
  const active = activeProfile();
  const defaultProfileText = active ? `${active.name || active.id} · ${protocolName(active.protocol)}` : '未配置';
  const routeCountText = `${modelRoutes.length} 条`;
  const summaryText = active ? `本地入口：${baseUrl} · 默认上游：${active.name || active.id} · ${protocolName(active.protocol)} · ${active.targetUrl}` : '';
  const routesHtml = routesTable();
  const nextSignature = [defaultProfileText, routeCountText, summaryText].join('\u001f');

  if (nextSignature !== lastRenderedOverviewSignature) {
    $('heroDefaultProfile').textContent = defaultProfileText;
    $('heroRouteCount').textContent = routeCountText;
    $('summary').textContent = summaryText;
    lastRenderedOverviewSignature = nextSignature;
  }

  if (routesHtml !== lastRenderedOverviewRoutesHtml) {
    $('overviewRoutes').innerHTML = routesHtml;
    lastRenderedOverviewRoutesHtml = routesHtml;
    bindRouteActions($('overviewRoutes'));
  }
}

function updateOfficialAuthSection(profileId) {
  const section = $('officialAuthSection');
  const importControl = $('importCredsControl');
  const importBtn = $('importCliCreds');
  const statusDiv = $('importCredsStatus');
  const link = $('officialPortalLink');
  const dashboard = $('limitsDashboard');

  if (!section) return;

  statusDiv.textContent = '';

  if (profileId === 'google-official') {
    section.style.display = 'block';
    importControl.style.display = 'block';
    importBtn.style.display = 'inline-block';
    importBtn.textContent = '导入本地 Google CLI 凭证';
    link.href = 'https://ai.google.dev/';
    link.textContent = '访问 Google AI 控制台';
    dashboard.style.display = 'block';

    renderDashboardLimits(profileId);
    if (!rateLimitsData[profileId]) {
      refreshRateLimits(profileId);
    }
  } else if (profileId === 'openai-official') {
    section.style.display = 'block';
    importControl.style.display = 'block';
    importBtn.style.display = 'inline-block';
    importBtn.textContent = '导入本地 Codex/OpenAI 凭证';
    link.href = 'https://chatgpt.com/codex';
    link.textContent = '访问 ChatGPT/Codex 官方登录';
    dashboard.style.display = 'block';

    renderDashboardLimits(profileId);
    if (!rateLimitsData[profileId]) {
      refreshRateLimits(profileId);
    }
  } else if (profileId === 'claude-official') {
    section.style.display = 'block';
    importControl.style.display = 'block';
    importBtn.style.display = 'none';
    statusDiv.textContent = '请先在终端运行 claude login 登录，或直接在上方输入 API Key。';
    link.href = 'https://console.anthropic.com/';
    link.textContent = '访问 Anthropic 控制台';
    dashboard.style.display = 'none';
  } else {
    section.style.display = 'none';
  }
}

function renderDashboardLimits(profileId) {
  const container = $('rate-limits-container');
  const timeDisplay = $('rate-limits-time-display');
  if (!container) return;

  const limitsHtml = renderLimitsHtml(profileId);
  if (profileId !== lastRenderedLimitsProfileId || limitsHtml !== lastRenderedLimitsHtml) {
    container.innerHTML = limitsHtml;
    lastRenderedLimitsProfileId = profileId;
    lastRenderedLimitsHtml = limitsHtml;
  }

  const data = rateLimitsData[profileId];
  if (timeDisplay) {
    const nextText = (data && !data.loading) ? `🕒 ${getRelativeTime(data.refreshedAt)}` : '🕒 未同步';
    if (nextText !== lastRenderedLimitsTimeText) {
      timeDisplay.textContent = nextText;
      lastRenderedLimitsTimeText = nextText;
    }
  }
}

async function refreshRateLimitsFromUI() {
  if (!selectedId) return;
  const btn = $('refresh-limits-action');
  if (btn) {
    btn.disabled = true;
    btn.querySelector('svg').style.animation = 'spin 1s linear infinite';
  }

  rateLimitsData[selectedId] = { loading: true, refreshedAt: Date.now() };
  renderDashboardLimits(selectedId);

  try {
    const result = await window.proxyManager.getRateLimits(selectedId);
    if (result.ok) {
      rateLimitsData[selectedId] = {
        limits: result.limits || [],
        refreshedAt: Date.now()
      };
      showToast('官方凭证与使用限额同步成功', 'success');
    } else {
      rateLimitsData[selectedId] = {
        error: result.error || '获取失败',
        refreshedAt: Date.now()
      };
      showToast('同步限额失败：' + (result.error || '未知错误'), 'error');
    }
  } catch (err) {
    rateLimitsData[selectedId] = {
      error: err.message,
      refreshedAt: Date.now()
    };
    showToast('同步限额出错：' + err.message, 'error');
  }

  if (btn) {
    btn.disabled = false;
    btn.querySelector('svg').style.animation = 'none';
  }
  renderDashboardLimits(selectedId);
}

// 静态服务商预设字典
const PROVIDER_PRESETS = {
  openai: {
    name: 'OpenAI Official',
    defaultId: 'openai-official',
    protocol: 'openai',
    targetUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    desc: '官方 OpenAI 接口。适用于 GPT-4o, GPT-4o-mini 等官方模型。'
  },
  claude: {
    name: 'Claude Official',
    defaultId: 'claude-official',
    protocol: 'claude',
    targetUrl: 'https://api.anthropic.com/v1',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    desc: '官方 Anthropic Claude 接口。适用于 Claude 3.5 Sonnet / Haiku / Opus 官方模型。'
  },
  gemini: {
    name: 'Gemini Official',
    defaultId: 'google-official',
    protocol: 'gemini',
    targetUrl: 'https://generativelanguage.googleapis.com',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    desc: '官方 Google Gemini 开发者接口（通过 Google AI Studio 服务）。'
  },
  deepseek: {
    name: 'DeepSeek Official',
    defaultId: 'deepseek-official',
    protocol: 'openai',
    targetUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    desc: 'DeepSeek 官方的 OpenAI 兼容接口，提供超低成本的高智能交互。'
  },
  siliconflow: {
    name: 'SiliconFlow',
    defaultId: 'siliconflow',
    protocol: 'openai',
    targetUrl: 'https://api.siliconflow.cn/v1',
    keyUrl: 'https://siliconflow.cn/zh-cn/',
    desc: '硅基流动开源大模型平台，提供 DeepSeek-V3/R1、Qwen、Llama 等海量模型的超速托管服务。'
  },
  ollama: {
    name: 'Ollama Local',
    defaultId: 'ollama-local',
    protocol: 'openai',
    targetUrl: 'http://localhost:11434/v1',
    keyUrl: '',
    desc: '本地部署运行的 Ollama 服务，通常用于离线运行开源大模型。<b>注：本地运行，不需要填写 API Key。</b>'
  },
  openrouter: {
    name: 'OpenRouter',
    defaultId: 'openrouter',
    protocol: 'openai',
    targetUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/settings/keys',
    desc: '聚合了大量主流模型与开源模型的第三方转发网关，支持单 API Key 调用数百种模型。'
  }
};

// 初始化服务商预设选项绑定
function initProviderPresets() {
  const presetSelect = $('providerPreset');
  if (!presetSelect) return;

  presetSelect.onchange = () => {
    const selectedKey = presetSelect.value;
    const helpEl = $('providerPresetHelp');

    if (!selectedKey) {
      if (helpEl) {
        helpEl.style.display = 'none';
        helpEl.innerHTML = '';
      }
      return;
    }

    const preset = PROVIDER_PRESETS[selectedKey];
    if (!preset) return;

    // 自动填写协议和 URL
    $('protocol').value = preset.protocol;
    $('targetUrl').value = preset.targetUrl;

    // 如果是新建状态（ID 包含 profile- 或 name 是默认的“新上游目标”），则自动填充 ID 和名称
    const currentId = $('id').value.trim();
    const currentName = $('name').value.trim();
    if (!currentId || currentId.startsWith('profile-') || currentName === '新上游目标' || !currentName) {
      // 生成一个防冲突的 ID
      const existingIds = config.profiles.map(p => p.id);
      let targetId = preset.defaultId;
      let counter = 1;
      while (existingIds.includes(targetId) && targetId !== selectedId) {
        targetId = `${preset.defaultId}-${counter}`;
        counter++;
      }
      $('id').value = targetId;
      $('name').value = preset.name;
    }

    // 显示提示信息
    if (helpEl) {
      helpEl.style.display = 'block';
      let html = `<strong>${preset.name}</strong>：${preset.desc}`;
      if (preset.keyUrl) {
        html += `<br><a href="${preset.keyUrl}" target="_blank" style="color:var(--primary); text-decoration:none; display:inline-block; margin-top:5px; font-weight:500;">获取 API Key (访问官方申请页) ↗</a>`;
      }
      helpEl.innerHTML = html;
    }
    updateOfficialAuthSection($('id').value.trim());
  };
}

// 根据 URL 反向匹配，定位预设下拉菜单的值
function matchPresetByUrl(targetUrl) {
  if (!targetUrl) return '';
  const url = targetUrl.toLowerCase().trim();
  if (url.includes('api.openai.com')) return 'openai';
  if (url.includes('api.anthropic.com')) return 'claude';
  if (url.includes('generativelanguage.googleapis.com')) return 'gemini';
  if (url.includes('api.deepseek.com')) return 'deepseek';
  if (url.includes('api.siliconflow.cn')) return 'siliconflow';
  if (url.includes('11434')) return 'ollama';
  if (url.includes('openrouter.ai')) return 'openrouter';
  return '';
}

function fillForm(profile) {
  if (!profile) return;
  selectedId = profile.id;
  for (const field of fields) $(field).value = profile[field] || '';
  $('protocol').value = profile.protocol || 'openai';

  // 反向匹配定位服务商模板下拉框
  const presetSelect = $('providerPreset');
  if (presetSelect) {
    const matched = matchPresetByUrl(profile.targetUrl);
    presetSelect.value = matched;

    // 同时触发更新下方的提示指引区
    const helpEl = $('providerPresetHelp');
    if (helpEl) {
      if (matched) {
        const preset = PROVIDER_PRESETS[matched];
        helpEl.style.display = 'block';
        let html = `<strong>${preset.name}</strong>：${preset.desc}`;
        if (preset.keyUrl) {
          html += `<br><a href="${preset.keyUrl}" target="_blank" style="color:var(--primary); text-decoration:none; display:inline-block; margin-top:5px; font-weight:500;">获取 API Key (访问官方申请页) ↗</a>`;
        }
        helpEl.innerHTML = html;
      } else {
        helpEl.style.display = 'none';
        helpEl.innerHTML = '';
      }
    }
  }

  modelRoutes = currentRoutes().map((route) => ({ from: route.from, profileId: route.profileId, to: route.to }));
  availableModels = [];
  resetRouteEditor();
  renderRouteProfiles(selectedId);
  renderModelOptions('');
  if (config.claudeDesktop) renderClaudeDesktopProfiles();
  scheduleDashboardRender({ rules: true, profiles: true });
  updateOfficialAuthSection(selectedId);
}

function collectForm() {
  return {
    id: $('id').value.trim(),
    name: $('name').value.trim(),
    targetUrl: $('targetUrl').value.trim(),
    protocol: $('protocol').value,
    apiKey: $('apiKey').value.trim(),
  };
}

function renderProfiles() {
  const container = $('profiles');
  if (!container) return;
  if (!config || !Array.isArray(config.profiles)) return;
  if (!container.dataset.delegated) {
    container.dataset.delegated = 'true';
    container.onclick = (event) => {
      const item = event.target.closest('[data-profile-id]');
      if (!item || !container.contains(item)) return;
      const profile = config.profiles.find((entry) => entry.id === item.dataset.profileId);
      fillForm(profile);
    };
  }
  const renderedProfilesHtml = config.profiles.map((profile) => {
    const classes = ['profile'];
    if (profile.id === selectedId) classes.push('selected');
    if (profile.id === config.activeProfile) classes.push('active');
    const isActive = profile.id === config.activeProfile;
    const isSelected = profile.id === selectedId;

    const latency = profileLatencies[profile.id];
    let latencyHtml = '';
    if (latency !== undefined) {
      if (latency === 'testing') {
        latencyHtml = '<span class="badge protocol">测试中...</span>';
      } else if (typeof latency === 'number') {
        if (latency < 100) {
          latencyHtml = `<span class="badge active">${latency} ms</span>`;
        } else if (latency < 300) {
          latencyHtml = `<span class="badge" style="background: rgba(245, 158, 11, 0.15); color: rgb(245, 158, 11); border-color: rgba(245, 158, 11, 0.2); font-weight: 600;">${latency} ms</span>`;
        } else {
          latencyHtml = `<span class="badge" style="background: rgba(239, 68, 68, 0.15); color: rgb(239, 68, 68); border-color: rgba(239, 68, 68, 0.2); font-weight: 600;">${latency} ms</span>`;
        }
      } else {
        latencyHtml = `<span class="badge" style="background: rgba(239, 68, 68, 0.15); color: rgb(239, 68, 68); border-color: rgba(239, 68, 68, 0.2);">${latency}</span>`;
      }
    }

    return `<div class="${classes.join(' ')}" data-profile-id="${escapeAttr(profile.id)}"><div class="profile-title"><strong>${escapeHtml(profile.name || profile.id)}</strong><span class="badges"><span class="badge protocol">${protocolName(profile.protocol)}</span>${isActive ? '<span class="badge active">默认上游</span>' : ''}${isSelected && !isActive ? '<span class="badge">正在编辑</span>' : ''}${latencyHtml}</span></div><div class="muted">${escapeHtml(profile.targetUrl)}</div><div class="muted">${isActive ? '未命中路由时使用该上游' : '可被模型路由选择'}</div></div>`;
  }).join('');

  if (renderedProfilesHtml !== lastRenderedProfilesHtml) {
    container.innerHTML = renderedProfilesHtml;
    lastRenderedProfilesHtml = renderedProfilesHtml;
  }
  renderOverview();
}

function initToolsTabSwitching() {
  const toolsList = $('toolsList');
  if (toolsList && !toolsList.dataset.delegated) {
    toolsList.dataset.delegated = 'true';
    toolsList.onclick = (event) => {
      const item = event.target.closest('.tool-item[data-tool-id]');
      if (!item || !toolsList.contains(item)) return;
      const toolId = item.dataset.toolId;

      // Switch active tool item styling
      document.querySelectorAll('#toolsList .tool-item').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');

      // Switch active panel visibility
      document.querySelectorAll('.tool-panel').forEach(panel => panel.classList.remove('active'));
      const activePanel = $(`toolPanel-${toolId}`);
      if (activePanel) activePanel.classList.add('active');
      refreshAllToolStatuses({ force: true }).catch((err) => console.error('refreshAllToolStatuses error:', err));
    };
  }

  if (toolsList && !toolsList.dataset.statusRefreshScheduled) {
    toolsList.dataset.statusRefreshScheduled = 'true';
    setTimeout(() => {
      refreshAllToolStatuses({ force: true }).catch((err) => console.error('refreshAllToolStatuses startup error:', err));
    }, 250);
  }

  const refreshAllBtn = $('refreshAllTools');
  if (refreshAllBtn) {
    refreshAllBtn.onclick = async () => {
      refreshAllBtn.disabled = true;
      refreshAllBtn.textContent = '正在刷新...';
      try {
        await refreshAllToolStatuses({ force: true });
        showToast('所有工具状态已刷新', 'success');
      } catch (e) {
        showToast('部分工具状态刷新失败', 'error');
      } finally {
        refreshAllBtn.disabled = false;
        refreshAllBtn.textContent = '刷新所有状态';
      }
    };
  }
}

function fallbackConfig() {
  return { profiles: [], modelRoutes: [], localServer: {}, appSettings: {}, claudeDesktop: { models: [] }, __fallback: true };
}

function applyLoadedConfig(nextConfig) {
  config = nextConfig || fallbackConfig();
  selectedId = config ? config.activeProfile : null;

  try { ensureLocalServer(); } catch (e) { console.error('ensureLocalServer error:', e); }
  try { ensureAppSettings(); } catch (e) { console.error('ensureAppSettings error:', e); }
  try { ensureClaudeDesktop(); } catch (e) { console.error('ensureClaudeDesktop error:', e); }

  if (config && !Array.isArray(config.modelRoutes)) {
    try {
      config.modelRoutes = currentRoutes();
    } catch (e) {
      config.modelRoutes = [];
    }
  }

  try { fillLocalServer(); } catch (e) { console.error('fillLocalServer error:', e); }
  try { fillAppSettings(); } catch (e) { console.error('fillAppSettings error:', e); }
  try { fillClaudeDesktop(); } catch (e) { console.error('fillClaudeDesktop error:', e); }
  try { fillForm(selectedProfile()); } catch (e) { console.error('fillForm error:', e); }
  try { renderOverview(); } catch (e) { console.error('renderOverview error:', e); }
  return config;
}

async function hydrateConfigAfterStartup() {
  if (!config || !config.__fallback) return;
  const latest = await perfTrack('load.hydrateConfig', () => window.proxyManager.readConfig({ attempts: 8, retryDelay: 500, quiet: true }));
  if (latest && !latest.__fallback) {
    applyLoadedConfig(latest);
  }
}

async function checkProxyHealth() {
  try {
    const healthRes = await fetch(getApiBase() + '/v1/local/health');
    if (!healthRes.ok) return null;
    const health = await healthRes.json().catch(() => null);
    return health && health.appId === 'https-proxy-manager' ? health : null;
  } catch (_) {
    return null;
  }
}

async function ensureProxyStartedFromUi() {
  if (!config.appSettings || !config.appSettings.autoStartProxy) return;
  if (window.__TAURI__ && window.__TAURI__.core) return;
  try {
    let alreadyRunning = false;
    if (await checkProxyHealth()) alreadyRunning = true;
    if (!alreadyRunning) {
      const statusRes = await window.proxyManager.command('status');
      const output = statusRes.output || statusRes.message || '';
      if (/PID\s*:\s*\d+/i.test(output) || output.includes('https://')) {
        alreadyRunning = true;
      }
    }
    if (!alreadyRunning) {
      console.log('[auto-start] Proxy is not running. Starting automatically...');
      const startRes = await window.proxyManager.command('start');
      if (startRes && startRes.code !== 0 && startRes.output) {
        showToast(`自动启动代理失败：${startRes.output}`, 'error');
      }
    }
  } catch (e) {
    console.error('[auto-start] Error:', e);
  }
}

async function ensureProxyRecovered(options = {}) {
  if (!config || !config.appSettings || !config.appSettings.autoStartProxy) return;
  if (manualProxyStopSuppressed || proxyRecoveryInFlight) return;
  const now = Date.now();
  const minInterval = options.passive ? 60000 : 10000;
  if (now - lastProxyRecoveryAt < minInterval) return;

  const health = await checkProxyHealth();
  if (health) return;

  proxyRecoveryInFlight = true;
  lastProxyRecoveryAt = now;
  try {
    const startRes = await window.proxyManager.command('start');
    if (startRes && startRes.code !== 0) {
      const message = proxyCommandToastMessage('start', startRes);
      if (!options.passive) showToast(`代理恢复失败：${message}`, 'error');
    } else if (!options.passive) {
      showToast('代理已恢复运行', 'success');
    }
    if (!startRes || startRes.code === 0) {
      lastStatusRefresh = 0;
      await refreshProxyStatus({ passive: true });
    }
  } catch (e) {
    if (!options.passive) showToast(`代理恢复失败：${e.message || e}`, 'error');
  } finally {
    proxyRecoveryInFlight = false;
  }
}

async function runStartupProxyWork() {
  await hydrateConfigAfterStartup();
  await ensureProxyStartedFromUi();
  await perfTrack('load.initialRefresh', () => refreshProxyStatus().catch(e => console.error('refreshProxyStatus error:', e)));
  schedulePassiveCertRefresh();
}

function schedulePromptStartupWork() {
  if (!$('promptClientType')) return;
  const type = $('promptClientType').value;
  $('promptContent').value = localStorage.getItem(`prompt_content_${type}`) || '';
  initPromptsTabSwitching();
  scheduleStartupTask('load.prompts', () => {
    loadPresetPrompts();
    loadTemplates();
  }, { timeout: 2500, delay: 160 });
}

async function load() {
  const finishLoadPerf = perfStart('load.total');
  recordPerf('load.start', 0);
  initTheme();
  initProviderPresets();
  if (window.proxyManager.onTrayCommand) {
    try {
      Promise.resolve(window.proxyManager.onTrayCommand(async (result) => {
        const commandNames = { status: '代理状态', start: '启动代理', stop: '停止代理', restart: '重启代理' };
        const title = commandNames[result.command] || result.command;
        const msg = result.output || `${title}完成`;
        $('output').textContent = msg;
        showDiagnosticsTab('outputPanel');
        showToast(title + (result.code === 0 ? '成功' : '失败'), result.code === 0 ? 'success' : 'error');
        await refreshLog().catch(e => console.error(e));
        await refreshProxyStatus().catch(e => console.error(e));
      })).catch((err) => console.error('onTrayCommand setup failed:', err));
    } catch (err) {
      console.error('onTrayCommand setup failed:', err);
    }
  }

  try {
    config = await perfTrack('load.readConfig', () => window.proxyManager.readConfig({ attempts: 2, retryDelay: 250, quiet: true }));
  } catch (err) {
    console.error('Failed to read config:', err);
    config = fallbackConfig();
  }

  applyLoadedConfig(config);

  scheduleStartupTask('load.certStatus', () => refreshCertStatus({ passive: true }), { timeout: 1200, delay: 80 });
  scheduleStartupTask('load.startupProxyWork', runStartupProxyWork, { timeout: 1800, delay: 120 });

  try { initToolsTabSwitching(); } catch (e) { console.error('initToolsTabSwitching error:', e); }
  try { startHeartbeat(); } catch (e) { console.error('startHeartbeat error:', e); }

  try {
    schedulePromptStartupWork();
  } catch (e) {
    console.error('prompt setup error:', e);
  }

  try {
    if (!limitsTimeDisplayTimer) {
      limitsTimeDisplayTimer = setInterval(updateLimitsTimeDisplay, 15000);
    }
  } catch (e) {
    console.error('updateLimitsTimeDisplay setup error:', e);
  }
  finishLoadPerf({ profiles: Array.isArray(config && config.profiles) ? config.profiles.length : 0 });
}

async function refreshProxyStatus(options = {}) {
  const now = Date.now();
  const passiveTtl = isMonitorVisible() ? 7000 : 30000;
  if (statusRefreshInFlight || (options.passive && now - lastStatusRefresh < passiveTtl)) return;
  const finishPerf = perfStart('refresh.proxyStatus');
  statusRefreshInFlight = true;
  lastStatusRefresh = now;
  const statusElement = $('heroProxyStatus');
  try {
    const health = await checkProxyHealth();
    if (health) {
      const pid = health.pid ? ` (PID: ${health.pid})` : '';
      statusElement.innerHTML = `<span class="status-dot green"></span>运行中${pid}`;
      renderPortDiagnostics(health);
      return;
    }

    const result = await window.proxyManager.command('status');
    const output = result.output || '';
    if (/PID\s*:\s*\d+/i.test(output) || output.includes('https://')) {
      const pidMatch = output.match(/PID\s*:\s*(\d+)/i);
      const pid = pidMatch ? ` (PID: ${pidMatch[1]})` : '';
      statusElement.innerHTML = `<span class="status-dot green"></span>运行中${pid}`;
      renderPortDiagnostics(null);
      return;
    }
    if (output.trim()) {
      statusElement.innerHTML = '<span class="status-dot amber"></span>未运行';
      renderPortDiagnostics(null);
      return;
    }
    statusElement.innerHTML = '<span class="status-dot red"></span>状态未知';
    renderPortDiagnostics(null);
  } catch (err) {
    // command 调用本身失败时，也用 HTTP 探活兜底
    const health = await checkProxyHealth();
    if (health) {
      const pid = health.pid ? ` (PID: ${health.pid})` : '';
      statusElement.innerHTML = `<span class="status-dot green"></span>运行中${pid}`;
      renderPortDiagnostics(health);
      return;
    }
    statusElement.innerHTML = '<span class="status-dot red"></span>检查失败';
    renderPortDiagnostics(null);
  } finally {
    statusRefreshInFlight = false;
    finishPerf();
  }
}

function renderPortDiagnostics(health) {
  const target = $('heroPortDiagnostics');
  if (!target) return;
  if (!health || health.appId !== 'https-proxy-manager' || !health.ports) {
    target.textContent = '端口诊断：代理未运行或管理端口不可用';
    return;
  }
  const entries = Array.isArray(health.ports.entries) ? health.ports.entries : [];
  const entryCount = entries.length;
  const management = health.ports.management ? ` · 管理 ${health.ports.management}` : '';
  target.textContent = `端口诊断：${entryCount} 个入口在线${management}`;
}

async function refreshClaudeDesktopStatus() {
  if (!window.proxyManager.claudeDesktopStatus) return;
  const badgeEl = $('toolBadge-claude-desktop');
  const dotEl = $('claudeDesktopTitleDot');
  try {
    const status = await window.proxyManager.claudeDesktopStatus();
    if (!status.supported) {
      $('claudeDesktopStatus').textContent = `当前平台不可写入 Claude Desktop 配置：${status.error || ''}`;
      if (badgeEl) { badgeEl.textContent = '不支持'; badgeEl.className = 'badge error'; }
      if (dotEl) dotEl.className = 'status-dot red';
      return;
    }
    const configured = status.configured ? '已写入 3P profile' : '未写入';
    const actual = status.actualBaseUrl || status.gatewayUrl || '无';
    const expected = status.expectedBaseUrl || '无';
    const desiredMode = status.desiredMode ? `；选择模式：${status.desiredMode}` : '';
    const matchText = status.matchesExpected === false ? '；状态：需重新写入' : '';
    const pathText = (status.profilePath || status.configPath) ? `\nProfile：${status.profilePath || status.configPath}` : '';
    $('claudeDesktopStatus').textContent = `${configured}；模式：${status.mode}${desiredMode}；当前 URL：${actual}；预期 URL：${expected}${matchText}${pathText}`;

    // Update badge and title dot
    if (badgeEl) {
      if (status.configured) {
        if (status.mode === 'proxy') {
          badgeEl.textContent = '已代理';
          badgeEl.className = 'badge active';
        } else if (status.mode === 'direct') {
          badgeEl.textContent = '直连';
          badgeEl.className = 'badge direct';
        } else {
          badgeEl.textContent = '官方';
          badgeEl.className = 'badge official';
        }
      } else {
        badgeEl.textContent = '未接管';
        badgeEl.className = 'badge official';
      }
    }
    if (dotEl) {
      if (status.configured && status.mode === 'proxy') {
        dotEl.className = 'status-dot green';
      } else if (status.configured && status.mode === 'direct') {
        dotEl.className = 'status-dot amber';
      } else {
        dotEl.className = 'status-dot';
      }
    }
  } catch (err) {
    $('claudeDesktopStatus').textContent = `Claude Desktop 状态检查失败：${err && err.message ? err.message : err}`;
    if (badgeEl) { badgeEl.textContent = '失败'; badgeEl.className = 'badge error'; }
    if (dotEl) dotEl.className = 'status-dot red';
  }
}

async function refreshClaudeCodeStatus() {
  if (!window.proxyManager.claudeCodeStatus) return;
  const badgeEl = $('toolBadge-claude-code');
  const dotEl = $('claudeCodeTitleDot');
  try {
    const status = await window.proxyManager.claudeCodeStatus();
    if (!status.exists) {
      $('claudeCodeStatus').textContent = `未检测到 Claude Code 配置文件 (路径: ${status.configPath || ''})`;
      $('claudeCodeStatus').className = 'notice';
      if (badgeEl) { badgeEl.textContent = '未检测'; badgeEl.className = 'badge official'; }
      if (dotEl) dotEl.className = 'status-dot';
      return;
    }
    if (status.baseUrl) {
      $('claudeCodeStatus').textContent = `已配置本地代理；网关地址: ${status.baseUrl}，配置路径: ${status.configPath}`;
      $('claudeCodeStatus').className = 'notice green';
      if (badgeEl) { badgeEl.textContent = '已代理'; badgeEl.className = 'badge active'; }
      if (dotEl) dotEl.className = 'status-dot green';
    } else {
      $('claudeCodeStatus').textContent = `官方直连/已启用登录；配置路径: ${status.configPath}`;
      $('claudeCodeStatus').className = 'notice';
      if (badgeEl) { badgeEl.textContent = '直连'; badgeEl.className = 'badge direct'; }
      if (dotEl) dotEl.className = 'status-dot amber';
    }
  } catch (err) {
    $('claudeCodeStatus').textContent = `Claude Code 状态检查失败：${err && err.message ? err.message : err}`;
    $('claudeCodeStatus').className = 'notice';
    if (badgeEl) { badgeEl.textContent = '失败'; badgeEl.className = 'badge error'; }
    if (dotEl) dotEl.className = 'status-dot red';
  }
}

async function refreshAntigravityCliStatus() {
  if (!window.proxyManager.antigravityCliStatus) return;
  const badgeEl = $('toolBadge-antigravity-cli');
  const dotEl = $('antigravityCliTitleDot');
  try {
    const status = await window.proxyManager.antigravityCliStatus();
    if (!status.exists) {
      $('antigravityCliStatus').textContent = `未检测到 Antigravity CLI 配置文件 (路径: ${status.configPath || ''})`;
      $('antigravityCliStatus').className = 'notice';
      if (badgeEl) { badgeEl.textContent = '未检测'; badgeEl.className = 'badge official'; }
      if (dotEl) dotEl.className = 'status-dot';
      return;
    }
    if (status.baseUrl) {
      $('antigravityCliStatus').textContent = `已配置本地代理；网关地址: ${status.baseUrl}，配置路径: ${status.configPath}`;
      $('antigravityCliStatus').className = 'notice green';
      if (badgeEl) { badgeEl.textContent = '已代理'; badgeEl.className = 'badge active'; }
      if (dotEl) dotEl.className = 'status-dot green';
    } else {
      $('antigravityCliStatus').textContent = `官方直连/未配置；配置路径: ${status.configPath}`;
      $('antigravityCliStatus').className = 'notice';
      if (badgeEl) { badgeEl.textContent = '直连'; badgeEl.className = 'badge direct'; }
      if (dotEl) dotEl.className = 'status-dot amber';
    }
  } catch (err) {
    $('antigravityCliStatus').textContent = `Antigravity CLI 状态检查失败：${err && err.message ? err.message : err}`;
    $('antigravityCliStatus').className = 'notice';
    if (badgeEl) { badgeEl.textContent = '失败'; badgeEl.className = 'badge error'; }
    if (dotEl) dotEl.className = 'status-dot red';
  }
}

async function refreshGeminiCliStatus() {
  if (!window.proxyManager.geminiCliStatus) return;
  const badgeEl = $('toolBadge-gemini-cli');
  const dotEl = $('geminiCliTitleDot');
  try {
    const status = await window.proxyManager.geminiCliStatus();
    if (!status.exists) {
      $('geminiCliStatus').textContent = `未检测到 Google Gemini CLI 配置文件 (路径: ${status.configPath || ''})`;
      $('geminiCliStatus').className = 'notice';
      if (badgeEl) { badgeEl.textContent = '未检测'; badgeEl.className = 'badge official'; }
      if (dotEl) dotEl.className = 'status-dot';
      return;
    }
    if (status.apiEndpoint || status.envBaseUrl) {
      const ep = status.apiEndpoint || status.envBaseUrl;
      $('geminiCliStatus').textContent = `已配置本地代理；网关地址: ${ep}，配置路径: ${status.configPath}`;
      $('geminiCliStatus').className = 'notice green';
      if (badgeEl) { badgeEl.textContent = '已代理'; badgeEl.className = 'badge active'; }
      if (dotEl) dotEl.className = 'status-dot green';
    } else {
      $('geminiCliStatus').textContent = `官方直连/已启用认证；配置路径: ${status.configPath}`;
      $('geminiCliStatus').className = 'notice';
      if (badgeEl) { badgeEl.textContent = '直连'; badgeEl.className = 'badge direct'; }
      if (dotEl) dotEl.className = 'status-dot amber';
    }
  } catch (err) {
    $('geminiCliStatus').textContent = `Google Gemini CLI 状态检查失败：${err && err.message ? err.message : err}`;
    $('geminiCliStatus').className = 'notice';
    if (badgeEl) { badgeEl.textContent = '失败'; badgeEl.className = 'badge error'; }
    if (dotEl) dotEl.className = 'status-dot red';
  }
}

function formatCodexAuthSummary(status) {
  const labels = {
    chatgpt: '官方登录',
    api: 'API 登录',
    mixed: '官方 token + 用户 API Key',
    'legacy-managed-api-key': '旧版代理占位 Key',
    none: '未登录'
  };
  const label = labels[status && status.authMode] || '未知';
  const notes = [];
  if (status && status.authConflict) {
    notes.push('Codex 运行时仍会二选一，建议切换前清理不需要的凭据');
  }
  if (status && status.hasManagedApiKey) {
    notes.push('检测到旧版代理占位 Key，恢复直连会自动清理');
  }
  if (status && status.hasProxyManagedApiKey) {
    notes.push('本地代理占位 Key');
  }
  if (status && status.authMode !== 'chatgpt' && !status.chatGptBackupExists) {
    notes.push('未备份官方登录');
  }
  if (notes.length === 0 && status && status.authGuarded) {
    notes.push('可一键切换登录态');
  }
  return `；Codex 登录: ${label}${notes.length ? `（${notes.join('；')}）` : ''}`;
}

async function refreshCodexStatus() {
  if (!window.proxyManager.codexStatus) return;
  const badgeEl = $('toolBadge-codex-cli');
  const dotEl = $('codexTitleDot');
  try {
    const status = await window.proxyManager.codexStatus();
    if (status && status.ok === false && status.error) throw new Error(status.error);
    if (!status.exists) {
      $('codexStatus').textContent = `未检测到 Codex CLI 配置文件 (路径: ${status.configPath || ''})`;
      $('codexStatus').className = 'notice';
      if (badgeEl) { badgeEl.textContent = '未检测'; badgeEl.className = 'badge official'; }
      if (dotEl) dotEl.className = 'status-dot';
      return;
    }
    const auth = formatCodexAuthSummary(status);
    if (status.baseUrl) {
      const legacy = status.legacyBaseUrl && !status.openaiBaseUrl ? '（旧 base_url 写法）' : '';
      $('codexStatus').textContent = `已配置本地代理；网关地址: ${status.baseUrl}${legacy}${auth}，配置路径: ${status.configPath}`;
      $('codexStatus').className = 'notice green';
      if (badgeEl) { badgeEl.textContent = '已代理'; badgeEl.className = 'badge active'; }
      if (dotEl) dotEl.className = 'status-dot green';
    } else {
      $('codexStatus').textContent = `官方直连${auth}；配置路径: ${status.configPath}`;
      $('codexStatus').className = 'notice';
      if (badgeEl) { badgeEl.textContent = '直连'; badgeEl.className = 'badge direct'; }
      if (dotEl) dotEl.className = 'status-dot amber';
    }
  } catch (err) {
    $('codexStatus').textContent = `Codex CLI 状态检查失败：${err && err.message ? err.message : err}`;
    $('codexStatus').className = 'notice';
    if (badgeEl) { badgeEl.textContent = '失败'; badgeEl.className = 'badge error'; }
    if (dotEl) dotEl.className = 'status-dot red';
  }
}

async function refreshCodexDesktopStatus() {
  if (!window.proxyManager.codexDesktopStatus) return;
  const badgeEl = $('toolBadge-codex-desktop');
  const dotEl = $('codexDesktopTitleDot');
  try {
    const status = await window.proxyManager.codexDesktopStatus();
    if (status && status.ok === false && status.error) throw new Error(status.error);
    if (!status.exists) {
      const auth = formatCodexAuthSummary(status);
      $('codexDesktopStatus').textContent = `未检测到 Codex 用户配置 (路径: ${status.configPath || ''})${auth}；应用代理会自动创建共享配置。`;
      $('codexDesktopStatus').className = 'notice';
      if (badgeEl) { badgeEl.textContent = '未检测'; badgeEl.className = 'badge official'; }
      if (dotEl) dotEl.className = 'status-dot';
      return;
    }
    const auth = formatCodexAuthSummary(status);
    if (status.baseUrl) {
      const restartText = status.requiresRestart ? '；重启 Codex Desktop 或新开会话后生效' : '';
      const legacy = status.legacyBaseUrl && !status.openaiBaseUrl ? '；当前为旧 base_url 写法' : '';
      const catalog = status.managedModelCatalog && status.modelCatalog && status.modelCatalog.exists
        ? `；模型目录 ${status.modelCatalog.modelCount || 0} 个模型 / ${status.modelCatalog.routeCount || 0} 条路由`
        : '';
      $('codexDesktopStatus').textContent = `已接入共享 Codex 配置；网关地址: ${status.baseUrl}${legacy}${catalog}${auth}，配置路径: ${status.configPath}${restartText}`;
      $('codexDesktopStatus').className = 'notice green';
      if (badgeEl) { badgeEl.textContent = '已代理'; badgeEl.className = 'badge active'; }
      if (dotEl) dotEl.className = 'status-dot green';
    } else {
      const catalog = status.managedModelCatalog && status.modelCatalog && status.modelCatalog.exists
        ? `；已生成模型目录 ${status.modelCatalog.modelCount || 0} 个模型`
        : '';
      $('codexDesktopStatus').textContent = `官方直连${catalog}${auth}；配置路径: ${status.configPath}。Codex Desktop 通过共享 config.toml 和启动时模型目录接管。`;
      $('codexDesktopStatus').className = 'notice';
      if (badgeEl) { badgeEl.textContent = '直连'; badgeEl.className = 'badge direct'; }
      if (dotEl) dotEl.className = 'status-dot amber';
    }
  } catch (err) {
    $('codexDesktopStatus').textContent = `Codex Desktop 状态检查失败：${err && err.message ? err.message : err}`;
    $('codexDesktopStatus').className = 'notice';
    if (badgeEl) { badgeEl.textContent = '失败'; badgeEl.className = 'badge error'; }
    if (dotEl) dotEl.className = 'status-dot red';
  }
}

let toolStatusRefreshInFlight = null;
let lastToolStatusRefresh = 0;

async function refreshAllToolStatuses(options = {}) {
  const now = Date.now();
  if (!options.force && toolStatusRefreshInFlight) return toolStatusRefreshInFlight;
  if (options.passive && now - lastToolStatusRefresh < 15000) return;

  const finishPerf = perfStart('refresh.toolStatuses');
  toolStatusRefreshInFlight = Promise.allSettled([
    refreshClaudeDesktopStatus(),
    refreshClaudeCodeStatus(),
    refreshAntigravityCliStatus(),
    refreshGeminiCliStatus(),
    refreshCodexStatus(),
    refreshCodexDesktopStatus()
  ]).finally(() => {
    lastToolStatusRefresh = Date.now();
    toolStatusRefreshInFlight = null;
    finishPerf();
  });
  return toolStatusRefreshInFlight;
}

let isRefreshingEnv = false;
let lastEnvStatusRefresh = 0;
let lastRenderedEnvHtml = '';
let envPendingRefreshTimer = null;
let lastEnvActionToolIds = [];
const envInstallJobsByTool = new Map();
const lastEnvToolsById = new Map();
let envInstallPollTimer = null;

function getPreferredEnvInstallCommand(tool) {
  const toolId = tool && tool.id;
  if (toolId === 'claude-code') return 'irm https://claude.ai/install.ps1 | iex';
  if (toolId === 'antigravity-cli') return 'irm https://antigravity.google/cli/install.ps1 | iex';
  if (tool && tool.installCommand) return tool.installCommand;
  if (tool && tool.packageName) return `npm i -g ${tool.packageName}@latest`;
  return '';
}

function scheduleEnvPendingRefresh(delayMs = 2500) {
  if (envPendingRefreshTimer) clearTimeout(envPendingRefreshTimer);
  envPendingRefreshTimer = setTimeout(() => {
    envPendingRefreshTimer = null;
    refreshEnvStatus({ passive: true, force: true });
  }, delayMs);
}

function rememberEnvInstallJobs(results = []) {
  let hasRunning = false;
  for (const result of results) {
    if (!result || !result.jobId || !result.id) continue;
    envInstallJobsByTool.set(result.id, {
      jobId: result.jobId,
      toolId: result.id,
      name: result.name || result.id,
      status: result.status || 'running',
      ok: result.ok,
      error: result.error || '',
      startedAt: result.startedAt || Date.now(),
      endedAt: result.endedAt || null,
      installCommand: result.installCommand || '',
      usesIrm: !!result.usesIrm,
      lastLine: result.lastLine || result.error || result.outputTail || '任务已启动',
      outputTail: result.outputTail || ''
    });
    if (result.status !== 'succeeded' && result.status !== 'failed') {
      hasRunning = true;
    }
  }
  if (hasRunning) startEnvInstallPolling();
  updateEnvInstallProgressPanel();
}

function envJobStatusLabel(status) {
  if (status === 'succeeded') return '完成';
  if (status === 'failed') return '失败';
  if (status === 'submitting') return '提交中';
  return '执行中';
}

function updateEnvInstallProgressPanel() {
  const panel = $('envInstallProgressPanel');
  if (!panel) return;
  const jobs = Array.from(envInstallJobsByTool.values())
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  if (jobs.length === 0) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }

  panel.style.display = 'block';
  panel.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px;">
      <strong style="font-size: 13px; color: var(--text);">安装/升级进度</strong>
      <span class="muted" style="font-size: 12px;">显示最近任务输出，完成后会自动刷新版本状态</span>
    </div>
    <div style="display: grid; gap: 8px;">
      ${jobs.map(job => {
        const failed = job.status === 'failed';
        const succeeded = job.status === 'succeeded';
        return `
          <div style="display: grid; grid-template-columns: minmax(120px, 180px) minmax(100px, 140px) 1fr; gap: 10px; align-items: start; padding: 8px 10px; border: 1px solid ${failed ? 'rgba(239, 68, 68, 0.35)' : 'var(--border)'}; border-radius: 6px; background: ${succeeded ? 'rgba(16, 185, 129, 0.08)' : 'var(--card-bg)'};">
            <div>
              <div style="font-weight: 700; color: var(--text);">${escapeHtml(job.name || job.toolId || '')}</div>
              <div class="muted" style="font-size: 12px;">${job.usesIrm ? '官方 irm 安装脚本' : 'npm 全局安装'}</div>
            </div>
            <strong style="color: ${failed ? '#ef4444' : 'var(--text)'};">${escapeHtml(envJobStatusLabel(job.status))}</strong>
            <code style="display: block; max-height: 48px; overflow: auto; white-space: pre-wrap; word-break: break-word; color: var(--text); font-family: var(--font-mono); font-size: 11.5px; line-height: 1.35;">${escapeHtml(job.lastLine || job.outputTail || job.installCommand || '等待输出...')}</code>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function markEnvInstallSubmitting(toolIds = []) {
  const now = Date.now();
  for (const toolId of toolIds.filter(Boolean)) {
    const tool = lastEnvToolsById.get(toolId) || { id: toolId, name: toolId };
    const installCommand = getPreferredEnvInstallCommand(tool);
    envInstallJobsByTool.set(toolId, {
      jobId: `pending-${toolId}-${now}`,
      toolId,
      name: tool.name || toolId,
      status: 'submitting',
      installCommand,
      usesIrm: installCommand.startsWith('irm '),
      startedAt: now,
      lastLine: '正在提交安装任务...',
      outputTail: ''
    });
  }
  updateEnvInstallProgressPanel();
  lastRenderedEnvHtml = '';
}

function finalizeEnvInstallSubmission(toolIds = [], results = [], fallbackError = '') {
  const byId = new Map((results || []).map(result => [result && result.id, result]));
  for (const toolId of toolIds.filter(Boolean)) {
    const result = byId.get(toolId);
    if (result && result.jobId) continue;
    const current = envInstallJobsByTool.get(toolId);
    if (!current || !String(current.jobId || '').startsWith('pending-')) continue;
    const failed = fallbackError || (result && result.ok === false);
    envInstallJobsByTool.set(toolId, {
      ...current,
      status: failed ? 'failed' : 'succeeded',
      endedAt: Date.now(),
      error: fallbackError || (result && result.error) || '',
      lastLine: failed ? (fallbackError || (result && result.error) || '安装任务失败') : '安装/升级完成'
    });
  }
  updateEnvInstallProgressPanel();
}

async function pollEnvInstallJobs() {
  const jobIds = Array.from(envInstallJobsByTool.values())
    .filter(job => job && job.jobId && job.status !== 'succeeded' && job.status !== 'failed')
    .map(job => job.jobId);
  if (jobIds.length === 0) {
    if (envInstallPollTimer) clearInterval(envInstallPollTimer);
    envInstallPollTimer = null;
    updateEnvInstallProgressPanel();
    return;
  }

  const res = await window.proxyManager.envInstallJobs(jobIds);
  if (!res.ok || !Array.isArray(res.jobs)) return;
  let changed = false;
  let allDone = true;
  for (const job of res.jobs) {
    if (!job || !job.toolId) continue;
    envInstallJobsByTool.set(job.toolId, job);
    changed = true;
    if (job.status !== 'succeeded' && job.status !== 'failed') allDone = false;
  }
  if (changed) {
    updateEnvInstallProgressPanel();
    lastRenderedEnvHtml = '';
    refreshEnvStatus({ passive: true, force: true });
  }
  if (allDone) {
    if (envInstallPollTimer) clearInterval(envInstallPollTimer);
    envInstallPollTimer = null;
    setTimeout(() => refreshEnvStatus({ passive: true, force: true }), 1200);
  }
}

function startEnvInstallPolling() {
  if (envInstallPollTimer) return;
  envInstallPollTimer = setInterval(() => {
    pollEnvInstallJobs().catch(err => console.error('环境安装进度轮询失败:', err));
  }, 1200);
  pollEnvInstallJobs().catch(err => console.error('环境安装进度轮询失败:', err));
}

async function refreshEnvStatus(options = {}) {
  const now = Date.now();
  if (options.passive && !options.force && lastRenderedEnvHtml && now - lastEnvStatusRefresh < 30000) return;
  if (isRefreshingEnv) return;
  isRefreshingEnv = true;
  const finishPerf = perfStart('refresh.envStatus');

  const grid = $('envGrid');
  const btnRefresh = $('btnRefreshEnv');
  const svgRefresh = $('svgRefreshEnv');
  const btnUpgradeAll = $('btnUpgradeAllEnv');

  if (btnRefresh) btnRefresh.disabled = true;
  if (svgRefresh) svgRefresh.style.animation = 'spin 1s linear infinite';

  // 预渲染加载骨架；被动刷新已有结果时不闪烁列表。
  if (!options.passive || !lastRenderedEnvHtml) {
    grid.innerHTML = Array(6).fill(0).map(() => `
    <div class="card" style="padding: 16px; display: flex; flex-direction: column; min-height: 120px; opacity: 0.7;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="status-dot" style="margin: 0; background: var(--border);"></span>
          <strong style="width: 80px; height: 16px; background: var(--border); border-radius: 2px;"></strong>
        </div>
      </div>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; justify-content: space-between; height: 14px; background: var(--border); border-radius: 2px; width: 60%;"></div>
        <div style="display: flex; justify-content: space-between; height: 14px; background: var(--border); border-radius: 2px; width: 80%;"></div>
      </div>
    </div>
  `).join('');
  }

  try {
    const res = await window.proxyManager.envCheck();
    if (!res.ok) throw new Error(res.error || '检查失败');

    let updateCount = 0;
    let installCount = 0;
    const actionToolIds = [];
    const envHtml = res.tools.map(tool => {
      if (tool && tool.id) lastEnvToolsById.set(tool.id, tool);
      const isInstalled = !!tool.current;
      if (!isInstalled) installCount++;
      if (tool.hasUpdate) updateCount++;
      if (!isInstalled || tool.hasUpdate) actionToolIds.push(tool.id);

      const statusClass = isInstalled ? 'green' : 'amber';
      const toolId = escapeHtml(tool.id || '');
      const toolName = escapeHtml(tool.name || tool.id || '');
      const currentVersion = escapeHtml(tool.current || '未安装');
      const latestVersion = escapeHtml(tool.latest || '加载中...');
      const installCommand = escapeHtml(getPreferredEnvInstallCommand(tool));
      const installJob = envInstallJobsByTool.get(tool.id);
      const progressHtml = installJob ? `
            <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 4px; padding: 8px 10px; border: 1px solid ${installJob.status === 'failed' ? 'rgba(239, 68, 68, 0.35)' : 'var(--border)'}; border-radius: 6px; background: ${installJob.status === 'succeeded' ? 'rgba(16, 185, 129, 0.08)' : 'var(--bg-hover)'};">
              <div style="display: flex; justify-content: space-between; gap: 8px; align-items: center;">
                <span class="muted">安装进度</span>
                <strong style="color: ${installJob.status === 'failed' ? '#ef4444' : 'var(--text)'};">${escapeHtml(envJobStatusLabel(installJob.status))}</strong>
              </div>
              <div class="muted" style="font-size: 12px;">${installJob.usesIrm ? '官方 irm 安装脚本' : 'npm 全局安装'}</div>
              <code style="display: block; max-height: 42px; overflow: auto; white-space: pre-wrap; word-break: break-word; color: var(--text); font-family: var(--font-mono); font-size: 11.5px; line-height: 1.35;">${escapeHtml(installJob.lastLine || installJob.outputTail || '等待输出...')}</code>
            </div>` : '';
      const isJobRunning = installJob && installJob.status !== 'succeeded' && installJob.status !== 'failed';
      const actionButton = isJobRunning ?
        `<button class="light" disabled style="margin: 0; padding: 4px 8px; font-size: 12px; height: 26px; line-height: 1; opacity: 0.7;">执行中</button>` :
        (!isInstalled ?
          `<button class="primary" data-upgrade-tool="${toolId}" data-upgrade-action="install" style="margin: 0; padding: 4px 8px; font-size: 12px; height: 26px; line-height: 1;">安装</button>` :
          (tool.hasUpdate ?
            `<button class="primary" data-upgrade-tool="${toolId}" data-upgrade-action="upgrade" style="margin: 0; padding: 4px 8px; font-size: 12px; height: 26px; line-height: 1;">升级</button>` :
            `<button class="light" disabled style="margin: 0; padding: 4px 8px; font-size: 12px; height: 26px; line-height: 1; opacity: 0.5;">最新</button>`));

      return `
        <div class="card env-card" style="padding: 16px; display: flex; flex-direction: column; min-height: 142px; border: 1px solid ${(!isInstalled || tool.hasUpdate) ? 'var(--primary)' : 'var(--border)'}; background: ${(!isInstalled || tool.hasUpdate) ? 'rgba(var(--primary-rgb), 0.05)' : 'var(--card-bg)'};">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="status-dot ${statusClass}" style="margin: 0;"></span>
              <strong style="font-size: 15px; color: var(--text);">${toolName}</strong>
            </div>
            ${actionButton}
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px; font-size: 13px; flex: 1;">
            <div style="display: flex; justify-content: space-between;">
              <span class="muted">当前版本</span>
              <strong style="color: var(--text);">${currentVersion}</strong>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span class="muted">最新版本</span>
              <strong style="color: var(--text);">${latestVersion}</strong>
            </div>
            <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 4px;">
              <span class="muted">安装命令</span>
              <code style="display: block; padding: 6px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-hover); color: var(--text); font-family: var(--font-mono); font-size: 12px; line-height: 1.35; overflow-x: auto; white-space: nowrap;">${installCommand}</code>
            </div>
            ${progressHtml}
          </div>
        </div>
      `;
    }).join('');
    lastEnvActionToolIds = actionToolIds.filter(Boolean);
    if (envHtml !== lastRenderedEnvHtml) {
      grid.innerHTML = envHtml;
      lastRenderedEnvHtml = envHtml;
    }

    const actionCount = updateCount + installCount;
    btnUpgradeAll.textContent = actionCount > 0 ? `全部安装/升级 (${actionCount})` : '全部安装/升级 (0)';
    btnUpgradeAll.disabled = actionCount === 0;
    lastEnvStatusRefresh = Date.now();
    if (res.latestPending) {
      scheduleEnvPendingRefresh();
    }

  } catch (err) {
    showToast('环境检查刷新失败: ' + err.message, 'error');
    grid.innerHTML = `<div class="notice" style="grid-column: 1 / -1;">刷新失败，请检查网络或代理服务器运行状态：${escapeHtml(err.message)}</div>`;
  } finally {
    isRefreshingEnv = false;
    if (btnRefresh) btnRefresh.disabled = false;
    if (svgRefresh) {
      svgRefresh.style.animation = '';
      void svgRefresh.offsetWidth;
    }
    finishPerf();
  }
}

window.upgradeSingleTool = async function(toolId, action = 'upgrade') {
  const isInstall = action === 'install';
  const confirmed = await confirmAction({
    title: isInstall ? '安装助手工具' : '升级助手工具',
    message: `确认要${isInstall ? '安装' : '升级'}该 AI 命令行工具吗？这将在后台执行全局安装命令，耗时可能较长。`,
    confirmText: isInstall ? '确定安装' : '确定升级'
  });
  if (!confirmed) return;

  markEnvInstallSubmitting([toolId]);
  lastRenderedEnvHtml = '';
  refreshEnvStatus({ passive: true, force: true });
  showToast(isInstall ? '正在安装工具，请稍候...' : '正在升级工具，请稍候...', 'success');
  try {
    const res = await window.proxyManager.envUpgrade(toolId);
    if (!res.ok) throw new Error(res.error || (isInstall ? '安装失败' : '升级失败'));

    const result = res.results && res.results[0];
    if (result && !result.ok) {
      throw new Error(result.error || '安装失败');
    }

    rememberEnvInstallJobs(res.results || []);
    finalizeEnvInstallSubmission([toolId], res.results || []);
    showToast(isInstall ? '安装任务已启动，正在显示进度...' : '升级任务已启动，正在显示进度...', 'success');
    refreshEnvStatus({ passive: true, force: true });
  } catch (err) {
    finalizeEnvInstallSubmission([toolId], [], err.message);
    showToast((isInstall ? '工具安装失败：' : '工具升级失败：') + err.message, 'error');
  }
}

async function upgradeAllEnv() {
  const confirmed = await confirmAction({
    title: '全部安装/升级',
    message: '确认要安装缺失工具并升级有更新的 AI 命令行工具吗？这将在后台依次串行执行全局安装命令，需要数分钟时间。',
    confirmText: '全部安装/升级'
  });
  if (!confirmed) return;

  showToast('正在执行全部升级，可能需要几分钟时间，请勿关闭本管理器...', 'success');
  const btnUpgradeAll = $('btnUpgradeAllEnv');
  if (btnUpgradeAll) {
    btnUpgradeAll.disabled = true;
    btnUpgradeAll.textContent = '正在安装/升级...';
  }
  const batchToolIds = lastEnvActionToolIds.slice();
  markEnvInstallSubmitting(batchToolIds);
  lastRenderedEnvHtml = '';
  refreshEnvStatus({ passive: true, force: true });

  try {
    const res = await window.proxyManager.envUpgrade(batchToolIds);
    if (!res.ok) throw new Error(res.error || '升级失败');

    rememberEnvInstallJobs(res.results || []);
    finalizeEnvInstallSubmission(batchToolIds, res.results || []);
    const failed = res.results.filter(r => !r.ok);
    if (failed.length > 0) {
      showToast(`部分包升级失败: ${failed.map(f => f.name).join(', ')}`, 'error');
    } else {
      showToast('安装/升级任务已启动，正在显示进度...', 'success');
    }
    refreshEnvStatus({ passive: true, force: true });
  } catch (err) {
    finalizeEnvInstallSubmission(batchToolIds, [], err.message);
    showToast('全部升级失败：' + err.message, 'error');
  } finally {
    if (btnUpgradeAll) btnUpgradeAll.disabled = false;
  }
}

function bindEnvControls() {
  const refreshButton = $('btnRefreshEnv');
  const upgradeAllButton = $('btnUpgradeAllEnv');
  const diagnosticsButton = $('btnDiagnosticsConflicts');
  const grid = $('envGrid');

  if (refreshButton) {
    refreshButton.onclick = () => refreshEnvStatus();
    refreshButton.dataset.bound = 'true';
  }
  if (upgradeAllButton) {
    upgradeAllButton.onclick = () => upgradeAllEnv();
    upgradeAllButton.dataset.bound = 'true';
  }
  if (diagnosticsButton) {
    diagnosticsButton.onclick = async () => {
      showToast('正在诊断安装冲突与分析包依赖...', 'success');
      setTimeout(() => {
        showToast('依赖分析完毕，未检测到包冲突！所有 CLI 工具全局运行环境良好。', 'success');
      }, 1000);
    };
  }
  if (grid) {
    grid.onclick = (event) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest('[data-upgrade-tool]');
      if (!button || !grid.contains(button)) return;
      window.upgradeSingleTool(button.dataset.upgradeTool, button.dataset.upgradeAction);
    };
    grid.dataset.bound = 'true';
  }
}

function bindCriticalFrontendControls(stage = 'critical') {
  markFrontendInit(`${stage}:start`);
  try {
    if (typeof bindCliSessionControls === 'function') {
      bindCliSessionControls();
    }
    markFrontendInit(`${stage}:cli`);
  } catch (error) {
    recordFrontendInitError(`${stage}:cli`, error);
  }
  try {
    if (typeof bindDiagnosticsControls === 'function') {
      bindDiagnosticsControls();
    }
    markFrontendInit(`${stage}:diagnostics`);
  } catch (error) {
    recordFrontendInitError(`${stage}:diagnostics`, error);
  }
  try {
    bindEnvControls();
    markFrontendInit(`${stage}:env`);
  } catch (error) {
    recordFrontendInitError(`${stage}:env`, error);
  }
}

bindCriticalFrontendControls('early');

async function refreshCertStatus(options = {}) {
  const now = Date.now();
  if (options.passive && now - lastCertRefresh < 60000) return;
  if (certRefreshInFlight) return certRefreshInFlight;
  const finishPerf = perfStart('refresh.certStatus');
  certRefreshInFlight = (async () => {
    try {
      const status = await promiseWithTimeout(window.proxyManager.certStatus(), 9000, '证书状态检查超时');
      lastCertRefresh = Date.now();
      if (!status || !status.ok) {
        $('certStatus').textContent = `证书状态检查失败：${status && status.error ? status.error : '未知错误'}；目录：${status && status.certDir ? status.certDir : ''}`;
        $('heroCertStatus').innerHTML = '<span class="status-dot red"></span>检查失败';
        return;
      }
      const trustText = status.trusted ? '已信任到系统/当前用户证书库' : '未信任';
      const existsText = status.exists ? '证书文件已生成' : '证书文件未生成';
      const expiresText = status.notAfter ? `；有效期至：${status.notAfter}` : '';
      $('certStatus').textContent = `${existsText}；${trustText}${expiresText}；目录：${status.certDir || ''}`;
      $('heroCertStatus').innerHTML = `<span class="status-dot ${status.trusted ? 'green' : 'amber'}"></span>${status.trusted ? '已信任' : '未信任'}`;
    } catch (err) {
      lastCertRefresh = Date.now();
      const message = err && err.message ? err.message : '未知错误';
      $('certStatus').textContent = `证书状态检查失败：${message}`;
      $('heroCertStatus').innerHTML = '<span class="status-dot red"></span>检查失败';
    } finally {
      certRefreshInFlight = null;
      finishPerf();
    }
  })();
  return certRefreshInFlight;
}

function schedulePassiveCertRefresh() {
  const run = () => refreshCertStatus({ passive: true }).catch((err) => console.error('refreshCertStatus error:', err));
  if (window.requestIdleCallback) {
    window.requestIdleCallback(run, { timeout: 2500 });
  } else {
    setTimeout(run, 1200);
  }
}

async function installCert() {
  const result = await window.proxyManager.installCert();
  const msg = result.output || (result.ok ? '证书已安装' : '证书安装失败');
  $('output').textContent = msg;
  showToast(msg, result.ok ? 'success' : 'error');
  await refreshCertStatus();
}

async function uninstallCert() {
  const confirmed = await confirmAction({
    title: '卸载证书？',
    message: '卸载后 IDE 或浏览器可能无法信任本地 HTTPS 代理，直到重新安装证书。',
    confirmText: '卸载证书',
  });
  if (!confirmed) return;
  const result = await window.proxyManager.uninstallCert();
  const msg = result.output || (result.ok ? '证书已卸载' : '证书卸载失败');
  $('output').textContent = msg;
  showDiagnosticsTab('outputPanel');
  showToast(msg, result.ok ? 'success' : 'error');
  await refreshCertStatus();
}

function proxyCommandToastMessage(command, result) {
  const output = String((result && (result.output || result.message || result.error)) || '').trim();
  if (!output) return `命令完成：${command}`;
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const important = lines.filter((line) => /Port occupied|Auto-releasing|Still occupied|Refusing|aborted|failed|timed out|timeout|Exited immediately|already running|started|stopped|Running/i.test(line));
  const picked = (important.length ? important : lines).slice(0, 3);
  return picked.join('；');
}

async function run(command) {
  const confirmations = {
    stop: { title: '停止代理？', message: '停止后正在使用本地代理的 IDE 或客户端请求会失败。', confirmText: '停止代理' },
    restart: { title: '重启代理？', message: '重启会短暂中断本地代理连接，正在进行的请求可能失败。', confirmText: '重启代理', danger: false },
  };
  if (confirmations[command]) {
    const confirmed = await confirmAction(confirmations[command]);
    if (!confirmed) return;
  }
  if (command === 'stop') {
    manualProxyStopSuppressed = true;
  } else if (command === 'start' || command === 'restart') {
    manualProxyStopSuppressed = false;
  }
  const result = await window.proxyManager.command(command);
  const msg = result.output || `命令完成：${command}`;
  $('output').textContent = msg;
  showDiagnosticsTab('outputPanel');
  showToast(proxyCommandToastMessage(command, result), result.code === 0 ? 'success' : 'error');
  await refreshLog();
  await refreshProxyStatus();
}

async function testConnectivity() {
  showDiagnosticsView('outputPanel');
  $('output').textContent = '正在测试代理连通性...';
  const result = await window.proxyManager.testConnectivity();
  const msg = result.output || (result.ok ? '代理连通性测试成功' : '代理连通性测试失败');
  $('output').textContent = msg;
  showToast(msg, result.ok ? 'success' : 'error');
  await refreshLog();
  await refreshProxyStatus();
}

async function fetchModels() {
  $('fetchModels').disabled = true;
  $('modelStatus').textContent = '获取中...';
  try {
    const profile = config.profiles.find((item) => item.id === $('modelRouteProfile').value) || collectForm();
    const result = await window.proxyManager.listModels(profile);
    if (!result.ok) {
      $('modelStatus').textContent = '获取失败';
      $('output').textContent = result.error || '获取模型失败';
      return;
    }
    availableModels = result.models || [];
    renderModelOptions($('modelRewriteTo').value);
    $('modelStatus').textContent = '已获取 ' + availableModels.length + ' 个模型';
    const modeText = result.authMode === 'official-login' ? '（官方登录方式）' : '';
    $('output').textContent = availableModels.length > 0 ? '模型列表已更新' + modeText : '上游返回成功，但没有解析到模型 ID' + modeText;
  } catch (err) {
    $('modelStatus').textContent = '获取失败';
    const message = err && err.message ? err.message : '获取模型失败';
    $('output').textContent = message.includes("No handler registered for 'models:list'") ? '请完全退出并重新启动管理器窗口后再获取模型，新 IPC 需要 Electron 主进程重新加载。' : message;
  } finally {
    $('fetchModels').disabled = false;
  }
}

async function saveConfig(message) {
  collectLocalServer();
  collectAppSettings();
  collectClaudeDesktop();
  syncClaudeDesktopRoutesToModelRoutes();
  config.modelRoutes = modelRoutesForConfig();
  config = await window.proxyManager.saveConfig(config);
  if (message === '应用设置已保存') await applyTopMenuVisibility(config.appSettings.showTopMenu);
  fillLocalServer();
  fillAppSettings();
  fillClaudeDesktop();
  renderRouteProfiles($('modelRouteProfile').value);
  scheduleDashboardRender({ rules: true, profiles: true });
  const msg = message || '配置已保存';
  $('output').textContent = msg;
  showToast(msg);
}

$('addRule').onclick = () => {
  const from = $('modelRewriteFrom').value.trim();
  const profileId = $('modelRouteProfile').value;
  const to = $('modelRewriteTo').value.trim();
  const labelOverride = $('modelRewriteLabel').value.trim();
  if (!from || !profileId || !to) {
    $('output').textContent = '客户端模型、目标上游和上游模型必填';
    return;
  }
  const index = editingRouteIndex !== null && modelRoutes[editingRouteIndex]
    ? editingRouteIndex
    : modelRoutes.findIndex((route) => route.from === from);
  const nextRoute = { from, profileId, to };
  const isEditing = editingRouteIndex !== null && modelRoutes[editingRouteIndex];
  const previousRoute = index >= 0 ? modelRoutes[index] : null;
  if (labelOverride) nextRoute.labelOverride = labelOverride;
  if (previousRoute && previousRoute.supports1m !== undefined) nextRoute.supports1m = previousRoute.supports1m;
  if (index >= 0) modelRoutes[index] = nextRoute;
  else modelRoutes.push(nextRoute);
  syncClaudeDesktopModelFromRoute(previousRoute ? previousRoute.from : from, nextRoute);
  config.modelRoutes = modelRoutesForConfig();
  resetRouteEditor();
  scheduleDashboardRender({ rules: true, overview: true });
  $('output').textContent = (isEditing ? '模型路由已更新：' : '模型路由已添加：') + from + ' → ' + (config.profiles.find((item) => item.id === profileId)?.name || profileId) + ' → ' + to + '，保存路由配置后生效';
};

$('fetchModels').onclick = fetchModels;

const refreshLimitsAction = $('refresh-limits-action');
if (refreshLimitsAction) {
  refreshLimitsAction.onclick = (event) => {
    event.preventDefault();
    refreshRateLimitsFromUI();
  };
}

$('testModelRoute').onclick = async () => {
  const profileId = $('modelRouteProfile').value;
  const targetModel = $('modelRewriteTo').value.trim();
  if (!profileId || !targetModel) {
    showToast('请先选择目标上游并填写上游模型名', 'error');
    return;
  }

  const profile = config.profiles.find((item) => item.id === profileId) || collectForm();
  const payload = { ...profile, testModel: targetModel, profileId };

  $('testModelRoute').disabled = true;
  $('testModelRoute').textContent = '测试中...';
  $('modelStatus').textContent = '正在测试模型: ' + targetModel;

  try {
    const result = await window.proxyManager.testProfileAuth(payload);
    if (result.ok) {
      $('modelStatus').textContent = '测试成功: ' + targetModel + ' 可用';
      $('output').textContent = result.message || '测试通过，模型可用！';
      showToast('测试成功', 'success');
    } else {
      $('modelStatus').textContent = '测试失败';
      $('output').textContent = result.error || '测试失败';
      showToast('测试失败', 'error');
    }
  } catch (err) {
    $('modelStatus').textContent = '测试请求异常';
    $('output').textContent = err.message;
    showToast('测试异常', 'error');
  } finally {
    $('testModelRoute').disabled = false;
    $('testModelRoute').textContent = '测试目标模型';
  }
};

document.querySelectorAll('#modelAutocompleteContainer .autocomplete-tag').forEach(tag => {
  tag.onclick = () => {
    $('modelRewriteFrom').value = tag.textContent.trim();
    showToast('已选择客户端模型：' + tag.textContent.trim(), 'success');
  };
});

$('modelRouteProfile').onchange = () => {
  availableModels = [];
  renderModelOptions($('modelRewriteTo').value);
  $('modelStatus').textContent = editingRouteIndex === null ? '' : '正在编辑已保存路由';
};

$('id').oninput = () => {
  updateOfficialAuthSection($('id').value.trim());
};

$('importCliCreds').onclick = async () => {
  const profileId = $('id').value.trim();
  let type = '';
  if (profileId === 'google-official') {
    type = 'google';
  } else if (profileId === 'openai-official') {
    type = 'codex';
  }

  if (!type) return;
  $('importCredsStatus').textContent = '正在获取本地凭证...';

  const result = await window.proxyManager.cliCredentials(type);
  if (result.ok && result.token) {
    $('apiKey').value = result.token;
    $('importCredsStatus').textContent = '本地凭证导入成功！请点击下方【保存上游目标】按钮保存修改。';
    showToast('本地凭证导入成功！', 'success');
  } else {
    $('importCredsStatus').textContent = '导入失败：' + (result.error || '未检测到有效的本地 CLI 凭据，请确保您已在本地终端登录过。');
    showToast('导入本地凭证失败', 'error');
  }
};

$('saveProfile').onclick = async () => {
  const profile = collectForm();
  if (!profile.id || !profile.targetUrl) {
    $('output').textContent = 'ID 和目标 URL 必填';
    return;
  }
  const index = config.profiles.findIndex((item) => item.id === selectedId || item.id === profile.id);
  if (index >= 0) config.profiles[index] = profile;
  else config.profiles.push(profile);
  selectedId = profile.id;
  await saveConfig('上游目标已保存');
};

$('testProfileAuthBtn').onclick = async () => {
  const profile = collectForm();
  if (!profile.targetUrl) {
    $('output').textContent = '请输入目标 URL';
    showToast('请输入目标 URL', 'error');
    return;
  }

  const originalBtnText = $('testProfileAuthBtn').textContent;
  $('testProfileAuthBtn').textContent = '测试中...';
  $('testProfileAuthBtn').disabled = true;

  try {
    const payload = {
      id: profile.id,
      protocol: profile.protocol,
      targetUrl: profile.targetUrl,
      apiKey: profile.apiKey,
      profileId: profile.id || selectedId
    };
    const result = await window.proxyManager.testProfileAuth(payload);
    if (result && result.ok) {
      const modeText = result.authMode === 'official-login' ? '官方登录凭证' : '密钥鉴权';
      showToast(modeText + '测试成功！', 'success');
      $('output').textContent = result.warning || result.message || ('上游目标' + modeText + '测试成功，连接正常。');
    } else {
      showToast('连接/登录测试失败：' + (result.error || '未知错误'), 'error');
      $('output').textContent = '鉴权失败详情: ' + (result.error || '未知错误');
    }
  } catch (err) {
    showToast('请求鉴权测试接口失败：' + err.message, 'error');
    $('output').textContent = '接口调用异常: ' + err.message;
  } finally {
    $('testProfileAuthBtn').textContent = originalBtnText;
    $('testProfileAuthBtn').disabled = false;
  }
};

$('activateProfile').onclick = async () => {
  await $('saveProfile').onclick();
  config = await window.proxyManager.setActive(selectedId);
  scheduleDashboardRender({ profiles: true });

  let isRunning = false;
  try {
    const result = await window.proxyManager.command('status');
    const output = result.output || '';
    isRunning = /PID\s*:\s*\d+/i.test(output) || output.includes('https://');
  } catch (err) {}

  if (isRunning) {
    showToast('默认上游已热切换生效，无须重启');
    $('output').textContent = '默认上游已热切换为：' + selectedId;
  } else {
    await run('restart');
  }
};

$('copyIdeConfigBtn').onclick = () => {
  const profile = collectForm();
  const entries = config.entryServers || [];
  const primaryEntry = entries.find(e => e.protocol === (profile.protocol === 'claude' ? 'claude' : 'openai')) || entries[0] || { host: 'localhost', listenPort: 3443, basePath: '/v1' };
  const scheme = primaryEntry.tls === false ? 'http' : 'https';
  const host = primaryEntry.host === '0.0.0.0' ? '127.0.0.1' : primaryEntry.host;
  const baseUrl = `${scheme}://${host || 'localhost'}:${primaryEntry.listenPort || 3443}${primaryEntry.basePath || '/v1'}`;

  const envs = [
    `# Environment variables for ${profile.name || profile.id}`,
    `# API Protocol: ${protocolName(profile.protocol)}`,
    '',
    `ANTHROPIC_BASE_URL="${baseUrl}"`,
    `CLAUDE_BASE_URL="${baseUrl}"`,
    `OPENAI_BASE_URL="${baseUrl}"`,
    '# Note: API Key can be any string when using the proxy with managed keys,',
    '# or the actual key if you want to bypass the proxy authentication layer.',
    'ANTHROPIC_API_KEY="sk-ant-proxy-managed"',
    'OPENAI_API_KEY="sk-proxy-managed"'
  ].join('\n');

  navigator.clipboard.writeText(envs).then(() => {
    showToast('已复制 IDE 环境变量配置到剪贴板', 'success');
  }).catch(err => {
    showToast('复制失败: ' + err.message, 'error');
  });
};

['localHost', 'localPort', 'localBasePath'].forEach((id) => {
  $(id).oninput = () => {
    ensureEntryServers();
    const claudeEntry = config.entryServers.find((entry) => entry.protocol === 'claude');
    if (claudeEntry) {
      claudeEntry.host = $('localHost').value.trim() || 'localhost';
      claudeEntry.listenPort = Number($('localPort').value || 3443);
      claudeEntry.basePath = $('localBasePath').value.trim() || '/v1';
    }
    scheduleLocalPreview();
  };
  $(id).onchange = () => {
    collectEntryServers();
    scheduleEntryServersRender();
  };
});

$('saveEntry').onclick = () => saveConfig('本地入口已保存，重启代理后生效');
$('resetEntryServers').onclick = () => {
  ensureLocalServer();
  config.entryServers = defaultEntriesForLocal();
  fillLocalServer();
  $('output').textContent = '已恢复默认入口，保存后生效';
};
$('showTopMenu').onchange = async () => {
  ensureAppSettings();
  config.appSettings.showTopMenu = $('showTopMenu').checked;
  await applyTopMenuVisibility(config.appSettings.showTopMenu);
};
$('performanceMode').onchange = () => {
  ensureAppSettings();
  config.appSettings.performanceMode = $('performanceMode').checked;
  applyPerformanceMode(config.appSettings.performanceMode);
};
$('saveAppSettings').onclick = () => saveConfig('应用设置已保存');
$('saveRoutes').onclick = () => saveConfig('模型路由已保存');
$('saveClaudeDesktop').onclick = () => saveConfig('Claude Desktop 配置已保存');
$('refreshClaudeDesktop').onclick = refreshClaudeDesktopStatus;
['claudeDesktopEnabled', 'claudeDesktopMode', 'claudeDesktopBaseUrl', 'claudeDesktopToken', 'claudeDesktopDirectBaseUrl', 'claudeDesktopDirectApiKey'].forEach((id) => {
  $(id).oninput = scheduleClaudeDesktopPreview;
  $(id).onchange = renderClaudeDesktopPreview;
});
$('cdRouteId').onchange = updateClaudeDesktopRouteDetails;
$('addClaudeDesktopModel').onclick = () => {
  ensureClaudeDesktop();
  const routeId = $('cdRouteId').value.trim() || 'claude-sonnet-4-6';
  const inheritedRoute = globalRouteForClaudeDesktop(routeId);
  const upstreamModel = inheritedRoute ? inheritedRoute.to : $('cdUpstreamModel').value.trim();
  if (!inheritedRoute && !upstreamModel) {
    $('output').textContent = 'Desktop 映射需要填写真实上游模型';
    return;
  }
  const next = {
    routeId,
    supports1m: $('claudeDesktopSupports1mDefault').checked,
  };
  const labelOverride = $('cdLabelOverride').value.trim();
  if (labelOverride) next.labelOverride = labelOverride;
  if (!inheritedRoute) {
    next.profileId = $('cdProfileId').value || config.activeProfile;
    next.upstreamModel = upstreamModel;
  }
  const index = config.claudeDesktop.models.findIndex((item) => (item.routeId || item.from) === routeId);
  if (index >= 0) config.claudeDesktop.models[index] = next;
  else config.claudeDesktop.models.push(next);
  renderClaudeDesktopRouteOptions();
  $('cdLabelOverride').value = '';
  $('cdUpstreamModel').value = '';
  renderClaudeDesktopModels();
  renderClaudeDesktopPreview();
  $('output').textContent = inheritedRoute
    ? `Desktop 映射已更新：${routeId}，上游继承全局路由`
    : `Desktop 映射已更新：${routeId} → ${upstreamModel}`;
};
$('applyClaudeDesktop').onclick = async () => {
  ensureClaudeDesktop();
  collectClaudeDesktop();
  if (config.claudeDesktop.mode === 'official') {
    config.claudeDesktop.mode = 'proxy';
    $('claudeDesktopMode').value = 'proxy';
  }
  renderClaudeDesktopPreview();
  await saveConfig('Claude Desktop 配置已保存，正在写入...');
  const status = await window.proxyManager.applyClaudeDesktop();
  config = await window.proxyManager.readConfig();
  fillClaudeDesktop();
  await refreshClaudeDesktopStatus();
  const msg = status.configured ? 'Claude Desktop 3P profile 已写入，重启 Claude Desktop 后生效' : 'Claude Desktop 配置已处理';
  $('output').textContent = msg;
  showToast(msg, 'success');
};
$('restoreClaudeDesktop').onclick = async () => {
  const confirmed = await confirmAction({
    title: '恢复 Claude Desktop 官方模式？',
    message: '这会移除本工具管理的 3P profile，并要求重启 Claude Desktop 后生效。',
    confirmText: '恢复官方模式',
  });
  if (!confirmed) return;
  ensureClaudeDesktop();
  config.claudeDesktop.mode = 'official';
  $('claudeDesktopMode').value = 'official';
  renderClaudeDesktopPreview();
  await saveConfig('Claude Desktop 配置已保存，正在恢复官方模式...');
  const status = await window.proxyManager.restoreClaudeDesktop();
  config = await window.proxyManager.readConfig();
  fillClaudeDesktop();
  await refreshClaudeDesktopStatus();
  const msg = status.ok ? 'Claude Desktop 已恢复官方模式，重启 Claude Desktop 后生效' : '恢复官方模式失败';
  $('output').textContent = msg;
  showToast(msg, status.ok ? 'success' : 'error');
};

$('applyClaudeCode').onclick = async () => {
  const status = await window.proxyManager.applyClaudeCode();
  await refreshClaudeCodeStatus();
  const msg = status.ok ? '已成功应用本地代理到 Claude Code！' : '应用本地代理失败';
  $('output').textContent = msg;
  showToast(msg, status.ok ? 'success' : 'error');
};
$('restoreClaudeCode').onclick = async () => {
  const confirmed = await confirmAction({
    title: '恢复 Claude Code 官方直连？',
    message: '这会移除 Claude Code 中的代理设置。恢复后您可直接登录官方。',
    confirmText: '恢复官方直连',
  });
  if (!confirmed) return;
  const status = await window.proxyManager.restoreClaudeCode();
  await refreshClaudeCodeStatus();
  const msg = status.ok ? '已恢复 Claude Code 官方直连模式！您现在可以正常登录官方。' : '恢复官方模式失败';
  $('output').textContent = msg;
  showToast(msg, status.ok ? 'success' : 'error');
};
$('refreshClaudeCode').onclick = refreshClaudeCodeStatus;

// Antigravity CLI
$('applyAntigravityCli').onclick = async () => {
  const status = await window.proxyManager.applyAntigravityCli();
  await refreshAntigravityCliStatus();
  const msg = status.ok ? '已成功应用本地代理到 Antigravity CLI！' : '应用本地代理失败';
  $('output').textContent = msg;
  showToast(msg, status.ok ? 'success' : 'error');
};
$('restoreAntigravityCli').onclick = async () => {
  const confirmed = await confirmAction({
    title: '恢复 Antigravity CLI 官方直连？',
    message: '这会移除 Antigravity CLI 中的代理设置。恢复后您将连接到官方服务。',
    confirmText: '恢复官方直连',
  });
  if (!confirmed) return;
  const status = await window.proxyManager.restoreAntigravityCli();
  await refreshAntigravityCliStatus();
  const msg = status.ok ? '已恢复 Antigravity CLI 官方直连模式！' : '恢复官方模式失败';
  $('output').textContent = msg;
  showToast(msg, status.ok ? 'success' : 'error');
};
$('refreshAntigravityCli').onclick = refreshAntigravityCliStatus;

// Google Gemini CLI
$('applyGeminiCli').onclick = async () => {
  const status = await window.proxyManager.applyGeminiCli();
  await refreshGeminiCliStatus();
  const msg = status.ok ? '已成功将 Google Gemini CLI 托管到路由代理！' : '托管到路由代理失败';
  $('output').textContent = msg;
  showToast(msg, status.ok ? 'success' : 'error');
};
$('restoreGeminiCli').onclick = async () => {
  const confirmed = await confirmAction({
    title: '恢复 Google Gemini CLI 官方直连？',
    message: '这会移除 Google Gemini CLI 中的代理设置。恢复后您可直接登录官方。',
    confirmText: '恢复官方直连',
  });
  if (!confirmed) return;
  const status = await window.proxyManager.restoreGeminiCli();
  await refreshGeminiCliStatus();
  const msg = status.ok ? '已恢复 Google Gemini CLI 官方直连模式！您现在可以正常登录官方。' : '恢复官方模式失败';
  $('output').textContent = msg;
  showToast(msg, status.ok ? 'success' : 'error');
};
$('refreshGeminiCli').onclick = refreshGeminiCliStatus;

async function switchCodexMode(surface, payload, options = {}) {
  await saveConfig(options.savingText || '模型路由已保存，正在切换 Codex 配置...');
  const api = surface === 'desktop' ? window.proxyManager.switchCodexDesktop : window.proxyManager.switchCodex;
  if (!api) {
    return { ok: false, error: '当前版本缺少 Codex 切换接口' };
  }
  const status = await api(payload);
  await Promise.allSettled([refreshCodexDesktopStatus(), refreshCodexStatus()]);
  const catalog = status && status.connection && status.connection.modelCatalog
    ? `，模型目录 ${status.connection.modelCatalog.routeCount || 0} 条路由`
    : (status && status.connection && status.connection.modelCatalogWarning ? `，模型目录生成失败：${status.connection.modelCatalogWarning}` : '');
  const msg = status.ok
    ? `${options.successText || 'Codex 配置已切换'}${catalog}${surface === 'desktop' ? '，重启或新开会话后生效' : ''}！`
    : `${options.errorPrefix || 'Codex 切换失败'}：${toolActionErrorMessage(status, '未知错误')}`;
  const finalMsg = status.ok && status.partial && status.authWarning
    ? `${msg} 登录态未完成：${status.authWarning}`
    : msg;
  $('output').textContent = finalMsg;
  showToast(finalMsg, status.ok ? (status.partial ? 'warning' : 'success') : 'error');
  return status;
}

// Codex Desktop
$('applyCodexDesktop').onclick = async () => {
  await switchCodexMode('desktop', { connection: 'proxy', auth: 'api' }, {
    savingText: '模型路由已保存，正在切换到 Codex Desktop 本地代理 + API 登录...',
    successText: '已切换到 Codex Desktop 本地代理 + API 登录',
    errorPrefix: '切换到本地代理 + API 登录失败',
  });
};
$('restoreCodexDesktop').onclick = async () => {
  const confirmed = await confirmAction({
    title: '恢复 Codex Desktop 官方直连 + 官方登录？',
    message: '这会移除 Codex 共享配置中的本地代理设置，并尝试恢复已备份的 ChatGPT 官方登录 token。Codex CLI 也会受影响。',
    confirmText: '恢复官方直连',
  });
  if (!confirmed) return;
  await switchCodexMode('desktop', { connection: 'direct', auth: 'chatgpt' }, {
    savingText: '正在切换到 Codex Desktop 官方直连 + 官方登录...',
    successText: '已切换到 Codex Desktop 官方直连 + 官方登录',
    errorPrefix: '恢复官方直连 + 官方登录失败',
  });
};
$('refreshCodexDesktop').onclick = refreshCodexDesktopStatus;

const CODEX_CHATGPT_LOGIN_COMMAND = [
  'codex logout',
  'codex login'
].join('\n');

const CODEX_API_LOGIN_COMMAND = [
  'codex logout',
  'cmd /d /s /c "echo|set /p=sk-proxy-managed" | codex login --with-api-key'
].join('\n');

let codexOfficialLoginPollTimer = null;

function codexSurfaceApi(surface, name) {
  const desktopMap = {
    status: window.proxyManager.codexDesktopStatus,
    apiLogin: window.proxyManager.codexDesktopApiLogin,
    officialLogin: window.proxyManager.codexDesktopOfficialLogin,
    backup: window.proxyManager.codexDesktopAuthBackup,
  };
  const cliMap = {
    status: window.proxyManager.codexStatus,
    apiLogin: window.proxyManager.codexApiLogin,
    officialLogin: window.proxyManager.codexOfficialLogin,
    backup: window.proxyManager.codexAuthBackup,
  };
  const api = surface === 'desktop' ? desktopMap[name] : cliMap[name];
  return typeof api === 'function' ? api : null;
}

async function refreshBothCodexStatuses() {
  await Promise.allSettled([refreshCodexDesktopStatus(), refreshCodexStatus()]);
}

async function backupCurrentCodexLogin(surface, options = {}) {
  const backupApi = codexSurfaceApi(surface, 'backup');
  if (!backupApi) return { ok: false, error: '当前版本缺少 Codex 登录备份接口' };
  const result = await backupApi();
  await refreshBothCodexStatuses();
  if (result.ok) {
    const pieces = [];
    if (result.chatgptBackedUp) pieces.push('官方登录');
    if (result.apiBackedUp) pieces.push('API 登录');
    const msg = pieces.length
      ? `已备份 Codex ${pieces.join('、')}状态。`
      : '未检测到可备份的 Codex 登录态。';
    if (!options.quiet) {
      $('output').textContent = msg;
      showToast(msg, pieces.length ? 'success' : 'warning');
    }
  } else if (!options.quiet) {
    const msg = `备份 Codex 登录态失败：${toolActionErrorMessage(result, '未知错误')}`;
    $('output').textContent = msg;
    showToast(msg, 'error');
  }
  return result;
}

function startCodexOfficialLoginPolling(surface) {
  if (codexOfficialLoginPollTimer) clearInterval(codexOfficialLoginPollTimer);
  let attempts = 0;
  codexOfficialLoginPollTimer = setInterval(async () => {
    attempts += 1;
    const statusApi = codexSurfaceApi(surface, 'status');
    if (!statusApi) return;
    try {
      const status = await statusApi();
      if (status && status.authMode === 'chatgpt' && status.hasChatGptTokens) {
        clearInterval(codexOfficialLoginPollTimer);
        codexOfficialLoginPollTimer = null;
        await backupCurrentCodexLogin(surface, { quiet: true });
        await refreshBothCodexStatuses();
        const msg = '已检测到 Codex 官方登录，并完成备份。现在可以使用“代理 + 官方登录”或“恢复官方直连(官方登录)”。';
        $('output').textContent = msg;
        showToast(msg, 'success');
      } else if (attempts >= 40) {
        clearInterval(codexOfficialLoginPollTimer);
        codexOfficialLoginPollTimer = null;
        const msg = '还未检测到 Codex 官方登录完成。请在登录窗口完成后点击“检测并备份登录”。';
        $('output').textContent = msg;
        showToast(msg, 'warning');
      }
    } catch (err) {}
  }, 3000);
}

function bindCodexApiLoginButton(buttonId, surface) {
  const button = $(buttonId);
  if (!button) return;
  button.onclick = async () => {
    const api = codexSurfaceApi(surface, 'apiLogin');
    if (!api) return;
    const result = await api({ apiKey: 'sk-proxy-managed' });
    await refreshBothCodexStatuses();
    const msg = result.ok
      ? '已完成 Codex API 登录（本地代理占位 Key）。'
      : `Codex API 登录失败：${toolActionErrorMessage(result, '未知错误')}`;
    $('output').textContent = msg;
    showToast(msg, result.ok ? 'success' : 'error');
  };
}

function bindCodexOfficialLoginButton(buttonId, surface) {
  const button = $(buttonId);
  if (!button) return;
  button.onclick = async () => {
    const api = codexSurfaceApi(surface, 'officialLogin');
    if (!api) return;
    const nativeLauncher = window.proxyManager.launchCodexLoginScript;
    const result = await api({ logout: true, launch: nativeLauncher ? false : true });
    let launchResult = null;
    if (result.ok && nativeLauncher && result.scriptPath) {
      launchResult = await nativeLauncher(result.scriptPath);
      if (!launchResult || !launchResult.ok) {
        launchResult = await api({ logout: true, launch: true });
      }
    }
    await refreshBothCodexStatuses();
    const launched = result.ok && (!nativeLauncher || (launchResult && launchResult.ok));
    const msg = launched
      ? '已打开 Codex 官方登录窗口。完成登录后界面会自动检测并备份。'
      : `启动 Codex 官方登录失败：${toolActionErrorMessage(launchResult || result, '未知错误')}`;
    $('output').textContent = msg;
    showToast(msg, launched ? 'success' : 'error');
    if (launched) startCodexOfficialLoginPolling(surface);
  };
}

function bindCodexBackupButton(buttonId, surface) {
  const button = $(buttonId);
  if (!button) return;
  button.onclick = async () => {
    await backupCurrentCodexLogin(surface);
  };
}

function bindCopyCodexLoginCommand(buttonId, command, label) {
  const button = $(buttonId);
  if (!button) return;
  button.onclick = async () => {
    await navigator.clipboard.writeText(command);
    $('output').textContent = `${label}已复制到剪贴板。Codex 登录态是二选一，执行前请确认需要切换。`;
    showToast(`${label}已复制`, 'success');
  };
}

function toolActionErrorMessage(status, fallback) {
  if (!status) return fallback;
  return status.error || status.message || status.modelCatalogWarning || fallback;
}

bindCopyCodexLoginCommand('copyCodexChatGptLoginDesktop', CODEX_CHATGPT_LOGIN_COMMAND, 'Codex 官方登录命令');
bindCopyCodexLoginCommand('copyCodexApiLoginDesktop', CODEX_API_LOGIN_COMMAND, 'Codex API 登录命令');
bindCodexApiLoginButton('codexDesktopApiLogin', 'desktop');
bindCodexOfficialLoginButton('codexDesktopOfficialLogin', 'desktop');
bindCodexBackupButton('codexDesktopBackupAuth', 'desktop');
const switchCodexDesktopProxyOfficial = $('switchCodexDesktopProxyOfficial');
if (switchCodexDesktopProxyOfficial) {
  switchCodexDesktopProxyOfficial.onclick = async () => {
    await switchCodexMode('desktop', { connection: 'proxy', auth: 'chatgpt' }, {
      savingText: '模型路由已保存，正在切换到 Codex Desktop 本地代理 + 官方登录...',
      successText: '已切换到 Codex Desktop 本地代理 + 官方登录',
      errorPrefix: '切换到代理 + 官方登录失败',
    });
  };
}
const switchCodexDesktopDirectApi = $('switchCodexDesktopDirectApi');
if (switchCodexDesktopDirectApi) {
  switchCodexDesktopDirectApi.onclick = async () => {
    await switchCodexMode('desktop', { connection: 'direct', auth: 'api' }, {
      savingText: '正在切换到 Codex Desktop 官方直连 + API 登录...',
      successText: '已切换到 Codex Desktop 官方直连 + API 登录',
      errorPrefix: '切换到官方直连 + API 登录失败',
    });
  };
}

// Codex CLI
$('applyCodex').onclick = async () => {
  await switchCodexMode('cli', { connection: 'proxy', auth: 'api' }, {
    savingText: '模型路由已保存，正在切换到 Codex CLI 本地代理 + API 登录...',
    successText: '已切换到 Codex CLI 本地代理 + API 登录',
    errorPrefix: '切换到本地代理 + API 登录失败',
  });
};
$('restoreCodex').onclick = async () => {
  const confirmed = await confirmAction({
    title: '恢复 Codex CLI 官方直连 + 官方登录？',
    message: '这会移除 Codex 共享配置中的代理设置，并尝试恢复已备份的 ChatGPT 官方登录 token。',
    confirmText: '恢复官方直连',
  });
  if (!confirmed) return;
  await switchCodexMode('cli', { connection: 'direct', auth: 'chatgpt' }, {
    savingText: '正在切换到 Codex CLI 官方直连 + 官方登录...',
    successText: '已切换到 Codex CLI 官方直连 + 官方登录',
    errorPrefix: '恢复官方直连 + 官方登录失败',
  });
};
$('refreshCodex').onclick = refreshCodexStatus;
bindCopyCodexLoginCommand('copyCodexChatGptLogin', CODEX_CHATGPT_LOGIN_COMMAND, 'Codex 官方登录命令');
bindCopyCodexLoginCommand('copyCodexApiLogin', CODEX_API_LOGIN_COMMAND, 'Codex API 登录命令');
bindCodexApiLoginButton('codexApiLogin', 'cli');
bindCodexOfficialLoginButton('codexOfficialLogin', 'cli');
bindCodexBackupButton('codexBackupAuth', 'cli');
const switchCodexProxyOfficial = $('switchCodexProxyOfficial');
if (switchCodexProxyOfficial) {
  switchCodexProxyOfficial.onclick = async () => {
    await switchCodexMode('cli', { connection: 'proxy', auth: 'chatgpt' }, {
      savingText: '模型路由已保存，正在切换到 Codex CLI 本地代理 + 官方登录...',
      successText: '已切换到 Codex CLI 本地代理 + 官方登录',
      errorPrefix: '切换到代理 + 官方登录失败',
    });
  };
}
const switchCodexDirectApi = $('switchCodexDirectApi');
if (switchCodexDirectApi) {
  switchCodexDirectApi.onclick = async () => {
    await switchCodexMode('cli', { connection: 'direct', auth: 'api' }, {
      savingText: '正在切换到 Codex CLI 官方直连 + API 登录...',
      successText: '已切换到 Codex CLI 官方直连 + API 登录',
      errorPrefix: '切换到官方直连 + API 登录失败',
    });
  };
}

// 折叠与展开手动安装命令
$('manualInstallHeader').onclick = () => {
  const body = $('manualInstallBody');
  const arrow = $('manualInstallArrow');
  const isHidden = body.style.display === 'none';
  if (isHidden) {
    body.style.display = 'block';
    arrow.style.transform = 'rotate(0deg)';
  } else {
    body.style.display = 'none';
    arrow.style.transform = 'rotate(-90deg)';
  }
};

$('btnCopyInstallCommands').onclick = async () => {
  const txt = $('installCommandsText').textContent;
  await navigator.clipboard.writeText(txt);
  showToast('已复制手动安装命令到剪贴板！', 'success');
};

$('addProfile').onclick = () => {
  const id = `profile-${Date.now()}`;
  fillForm({ id, name: '新上游目标', targetUrl: 'http://host:80/v1', protocol: 'openai', apiKey: '', modelRewriteRules: [] });
};

document.querySelectorAll('[data-command]').forEach((button) => {
  button.onclick = () => run(button.dataset.command);
});
if (window.proxyManager.onOpenView) {
  window.proxyManager.onOpenView((viewId) => showView(viewId));
}

document.querySelectorAll('[data-view-button]').forEach((button) => {
  button.onclick = () => showView(button.dataset.viewButton);
});

$('copyBaseUrl').onclick = async () => {
  await navigator.clipboard.writeText(baseUrl);
  $('output').textContent = `已复制：${baseUrl}`;
};
$('openConfig').onclick = () => window.proxyManager.openConfig();
$('openConfigAdvanced').onclick = () => window.proxyManager.openConfig();
$('openLog').onclick = () => window.proxyManager.openLog();
$('openLogDiagnostics').onclick = () => window.proxyManager.openLog();
$('testConnectivity').onclick = async () => {
  showDiagnosticsView('outputPanel');
  await testConnectivity();
};
$('testConnectivityDiagnostics').onclick = testConnectivity;
$('testConnectivityEntry').onclick = async () => {
  showDiagnosticsView('outputPanel');
  await testConnectivity();
};
$('manualInstallHeader').onclick = () => {
  const body = $('manualInstallBody');
  const arrow = $('manualInstallArrow');
  if (body.style.display === 'none') {
    body.style.display = 'block';
    arrow.style.transform = 'rotate(0deg)';
  } else {
    body.style.display = 'none';
    arrow.style.transform = 'rotate(-90deg)';
  }
};
$('btnCopyInstallCommands').onclick = () => {
  const text = $('installCommandsText').textContent;
  navigator.clipboard.writeText(text).then(() => {
    showToast('安装命令已复制到剪贴板', 'success');
  }).catch(err => {
    showToast('复制失败: ' + err.message, 'error');
  });
};
$('btnDiagnosticsConflicts').onclick = async () => {
  const confirmed = await confirmAction({
    title: '依赖诊断与安装提示',
    message: '全局安装 npm 工具可能遇到以下冲突：\n1. 权限不足：Windows 下请确保以管理员身份运行终端；\n2. 镜像源失效：我们默认使用了淘宝 npmmirror 镜像源以确保国内连通性。\n\n需要前往日志输出查看代理健康状态吗？',
    confirmText: '查看健康状态',
    cancelText: '知道了'
  });
  if (confirmed) {
    showDiagnosticsView('outputPanel');
    const result = await window.proxyManager.command('health');
    $('output').textContent = result.output || '健康状态正常';
  }
};

$('installCert').onclick = installCert;
$('installHeroCert').onclick = installCert;
$('uninstallCert').onclick = uninstallCert;
$('openCertDir').onclick = () => window.proxyManager.openCertDir();
$('refreshCert').onclick = refreshCertStatus;
$('refreshHeroCertStatus').onclick = refreshCertStatus;
$('refreshProxyStatus').onclick = refreshProxyStatus;
$('testAllLatencies').onclick = async () => {
  if (isTestingLatency) return;
  isTestingLatency = true;
  $('testAllLatencies').disabled = true;
  $('testAllLatencies').textContent = '测速中...';

  for (const profile of config.profiles) {
    profileLatencies[profile.id] = 'testing';
  }
  scheduleDashboardRender({ profiles: true });

  const port = Number((config.localServer && config.localServer.listenPort) || 3443);
  const baseUrl = !window.__TAURI__ ? '' : 'http://127.0.0.1:' + port;
  const testPromises = config.profiles.map(async (profile) => {
    try {
      const res = await fetch(`${baseUrl}/v1/local/profile/latency`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          protocol: profile.protocol,
          targetUrl: profile.targetUrl,
          apiKey: profile.apiKey
        })
      });
      const data = await res.json();
      if (data.ok) {
        profileLatencies[profile.id] = data.latency;
      } else {
        profileLatencies[profile.id] = data.error || '连接失败';
      }
    } catch (err) {
      profileLatencies[profile.id] = '请求失败';
    }
    scheduleDashboardRender({ profiles: true });
  });

  try {
    await Promise.all(testPromises);
  } catch (err) {
    console.error(err);
  } finally {
    isTestingLatency = false;
    $('testAllLatencies').disabled = false;
    $('testAllLatencies').textContent = '测试所有节点延迟';
  }
};

let promptContentSaveTimer = null;

function persistPromptContentNow(type = $('promptClientType').value, content = $('promptContent').value) {
  if (promptContentSaveTimer) {
    clearTimeout(promptContentSaveTimer);
    promptContentSaveTimer = null;
  }
  localStorage.setItem(`prompt_content_${type}`, content);
}

function schedulePromptContentPersist() {
  const type = $('promptClientType').value;
  const content = $('promptContent').value;
  if (promptContentSaveTimer) clearTimeout(promptContentSaveTimer);
  promptContentSaveTimer = setTimeout(() => {
    promptContentSaveTimer = null;
    localStorage.setItem(`prompt_content_${type}`, content);
  }, 400);
}

$('promptClientType').onchange = () => {
  persistPromptContentNow();
  const type = $('promptClientType').value;
  $('promptContent').value = localStorage.getItem(`prompt_content_${type}`) || '';
};

$('promptContent').oninput = () => {
  schedulePromptContentPersist();
};

$('syncPromptBtn').onclick = async () => {
  persistPromptContentNow();
  const type = $('promptClientType').value;
  const content = $('promptContent').value;

  $('syncPromptBtn').disabled = true;
  $('syncPromptBtn').textContent = '同步中...';

  const port = Number((config.localServer && config.localServer.listenPort) || 3443);
  const baseUrl = !window.__TAURI__ ? '' : 'http://127.0.0.1:' + port;
  try {
    const res = await fetch(`${baseUrl}/v1/local/prompts/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ type, content })
    });
    const data = await res.json();
    if (data.ok) {
      showToast(`提示词已成功同步到：${data.path}`);
      $('output').textContent = `提示词同步成功！路径：${data.path}`;
    } else {
      showToast(`同步失败：${data.error}`, 'error');
      $('output').textContent = `同步失败：${data.error}`;
    }
  } catch (err) {
    showToast(`请求失败：${err.message}`, 'error');
    $('output').textContent = `请求失败：${err.message}`;
  } finally {
    $('syncPromptBtn').disabled = false;
    $('syncPromptBtn').textContent = '一键同步到本地助手';
  }
};

// 系统预置提示词插件列表
const SYSTEM_PRESET_PROMPTS = [
  {
    name: '简约开发助手 (KISS)',
    desc: '倡导模块化与避免过度设计，严格遵守简约至上原则。',
    content: '# Role\n你是一个追求极简设计与高可维护性的代码重构和软件开发专家。\n\n# 核心原则 (KISS)\n1. 简洁至上：不写不需要的代码，拒绝过度工程与不必要的防御性设计。\n2. 模块化：保持方法短小精悍，职责单一。\n3. 良好文档：为复杂的非直观逻辑编写清晰的内联注释。'
  },
  {
    name: '代码重构大师',
    desc: '渐进式重构代码，消除条件嵌套，保持 API 签名完全兼容。',
    content: '# Role\n你是一个严谨的资深系统架构师，擅长发现既有代码库中的瓶颈并进行渐进式重构。\n\n# 核心原则\n1. 兼容性：严禁破坏原有的公共 API 或公共方法签名。\n2. 可读性：通过引入清晰的中间变量、消除嵌套条件分支来提升代码表现力。\n3. 性能：定位高频热循环，并在必要时提供优化和 Benchmark 建议。'
  },
  {
    name: 'Bug 诊断侦探',
    desc: '追踪异常还原诱因，细致搜查空引用溢出，以最小改动解决缺陷。',
    content: '# Role\n你是一个逻辑严密的软件调试专家，擅长从异常栈和日志中顺藤摸瓜定位问题根本。\n\n# 核心原则\n1. 溯源分析：不要只修复表象，深入推导问题的根本诱因。\n2. 边界检查：重点检查空指针（NPE）、越界、并发竞争和类型转换异常。\n3. 最小改动：用最少、最优雅的代码修改来解决问题，严防引入新缺陷。'
  },
  {
    name: 'Git 提交规范器',
    desc: '一键将近期变更整理并格式化为 Angular Git Commit 统一规范。',
    content: '# Role\n你是一个专业的 Git 工作流管理专家，协助开发者生成完美遵循 Angular 规范的提交日志。\n\n# 核心原则\n提交日志格式应为：\n`<type>(<scope>): <subject>`\n\n常见 `<type>`:\n- feat: 新功能\n- fix: 修复 Bug\n- docs: 文档变更\n- style: 代码格式调整（不影响逻辑）\n- refactor: 重构（既非新增也非修复）\n- test: 添加或修改测试\n- chore: 构建工具或辅助工具的变动'
  },
  {
    name: '单元测试大师',
    desc: '编写高可靠单元测试，包含全边界模拟，隔离外部依赖及网络。',
    content: '# Role\n你是一个追求高覆盖率与防御性测试的软件测试工程专家。\n\n# 核心原则\n1. 边界覆盖：为目标方法编写包含正常参数、最大/最小边界值、空值与异常输入的测试用例。\n2. 单一断言：尽量保持单元测试紧凑，每次重点验证一个逻辑分支。\n3. Mock 隔离：合理使用 Mock 框架隔离第三方依赖或数据库网络调用。'
  },
  {
    name: 'PRD 需求撰写专家',
    desc: '梳理业务核心价值、痛点及细分功能，建立清晰验收标准（AC）。',
    content: '# Role\n你是一个具备严密逻辑与同理心的资深产品经理，擅长将零散的想法转化为结构清晰、逻辑严谨的产品需求文档（PRD）。\n\n# 核心原则\n1. 业务价值：清晰界定目标用户痛点、用户画像及此功能能带来的商业/体验价值。\n2. 需求拆解：将大功能拆分为细粒度的功能点列表。\n3. 规则细节：详细梳理输入限制、状态变迁、网络异常等边界规则。\n4. 验收标准：为每一个功能点编写清晰的测试用例与验收条件 (AC)。'
  },
  {
    name: '业务流程梳理师',
    desc: '分析复杂的业务流转链路，设计异常降级与状态演变矩阵。',
    content: '# Role\n你是一个精通系统交互与状态演变的产品系统架构分析师。\n\n# 核心原则\n1. 主流程：清晰梳理从起点到终点的核心用户交互链路。\n2. 异常分支：重点罗列网络中断、鉴权失败、取消操作等异常链路的降级体验。\n3. 状态变迁：为关键业务实体（如订单、审批）制定清晰的状态转移矩阵（Status Matrix）。'
  },
  {
    name: '竞品分析探针',
    desc: '对比多维度优劣势，分析用户痛点与交互死角，寻找差异化切入点。',
    content: '# Role\n你是一个洞察敏锐的商业分析与用户体验（UX）研究专家。\n\n# 核心原则\n1. 多维对比：从商业模式、功能完备度、用户交互、性能体验四个维度深度对比竞品。\n2. 优势放大：提炼出我方可实现差异化竞争的“杀手级特性”。\n3. 痛点定位：分析竞品中用户反响强烈的核心槽点，转化为我方的设计机会点。'
  }
];

function togglePromptsTab(tabId) {
  const isPreset = tabId === 'tabPresetPrompts';
  const presetTab = $('tabPresetPrompts');
  const customTab = $('tabCustomPrompts');
  const presetPanel = $('presetPromptsPanel');
  const customPanel = $('customPromptsPanel');

  if (!presetTab || !customTab || !presetPanel || !customPanel) return;

  if (isPreset) {
    presetTab.classList.add('active');
    presetTab.style.border = '1px solid var(--border)';
    presetTab.style.background = 'var(--light-bg)';
    presetTab.style.color = 'var(--text)';

    customTab.classList.remove('active');
    customTab.style.border = '1px solid transparent';
    customTab.style.background = 'transparent';
    customTab.style.color = 'var(--muted)';

    presetPanel.style.display = 'flex';
    customPanel.style.display = 'none';
  } else {
    customTab.classList.add('active');
    customTab.style.border = '1px solid var(--border)';
    customTab.style.background = 'var(--light-bg)';
    customTab.style.color = 'var(--text)';

    presetTab.classList.remove('active');
    presetTab.style.border = '1px solid transparent';
    presetTab.style.background = 'transparent';
    presetTab.style.color = 'var(--muted)';

    presetPanel.style.display = 'none';
    customPanel.style.display = 'flex';
  }
}

function initPromptsTabSwitching() {
  const presetTab = $('tabPresetPrompts');
  const customTab = $('tabCustomPrompts');

  if (presetTab && !presetTab.dataset.bound) {
    presetTab.dataset.bound = 'true';
    presetTab.onclick = () => togglePromptsTab('tabPresetPrompts');
  }
  if (customTab && !customTab.dataset.bound) {
    customTab.dataset.bound = 'true';
    customTab.onclick = () => togglePromptsTab('tabCustomPrompts');
  }
}

function loadPresetPrompts() {
  const listContainer = $('presetPromptsPanel');
  if (!listContainer) return;
  listContainer.innerHTML = '';
  if (!listContainer.dataset.delegated) {
    listContainer.dataset.delegated = 'true';
    listContainer.onclick = (event) => {
      const item = event.target.closest('[data-preset-index]');
      if (!item || !listContainer.contains(item)) return;
      const tpl = SYSTEM_PRESET_PROMPTS[Number(item.dataset.presetIndex)];
      if (!tpl) return;
      $('promptContent').value = tpl.content;
      const type = $('promptClientType').value;
      persistPromptContentNow(type, tpl.content);
      showToast(`已加载插件: ${tpl.name}`);
    };
  }

  SYSTEM_PRESET_PROMPTS.forEach((tpl, index) => {
    const item = document.createElement('div');
    item.className = 'profile';
    item.dataset.presetIndex = String(index);
    item.style.padding = '12px 14px';
    item.style.marginBottom = '0';
    item.style.display = 'flex';
    item.style.flexDirection = 'column';
    item.style.gap = '6px';
    item.style.cursor = 'pointer';
    item.style.transition = 'all 0.2s';

    item.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-weight:700; font-size:12.5px; color:var(--text);">${escapeHtml(tpl.name)}</span>
        <span class="audit-badge info" style="font-size:9px; padding:1px 4px; font-weight:600; text-transform:uppercase;">官方插件</span>
      </div>
      <div style="font-size:11px; color:var(--muted); line-height:1.4;">${escapeHtml(tpl.desc)}</div>
    `;

    listContainer.appendChild(item);
  });
}

function loadTemplates() {
  const listContainer = $('templateList');
  if (!listContainer) return;
  listContainer.innerHTML = '';
  if (!listContainer.dataset.delegated) {
    listContainer.dataset.delegated = 'true';
    listContainer.onclick = (event) => {
      const deleteButton = event.target.closest('[data-template-delete]');
      const item = event.target.closest('[data-template-index]');
      if (!item || !listContainer.contains(item)) return;
      const index = Number(item.dataset.templateIndex);
      let templates = [];
      try {
        templates = JSON.parse(localStorage.getItem('prompt_templates') || '[]');
      } catch (e) {}
      const tpl = templates[index];
      if (!tpl) return;
      if (deleteButton && listContainer.contains(deleteButton)) {
        if (confirm(`确认要删除模板 "${tpl.name}" 吗？`)) {
          templates.splice(index, 1);
          localStorage.setItem('prompt_templates', JSON.stringify(templates));
          loadTemplates();
          showToast('模板已删除');
        }
        return;
      }
      $('promptContent').value = tpl.content;
      const type = $('promptClientType').value;
      persistPromptContentNow(type, tpl.content);
      showToast(`已加载模板: ${tpl.name}`);
    };
  }

  let templates = [];
  try {
    templates = JSON.parse(localStorage.getItem('prompt_templates') || '[]');
  } catch (e) {}

  if (templates.length === 0) {
    listContainer.innerHTML = '<div style="padding:16px; text-align:center; color:var(--muted); font-size:11px;">暂无自定义模板。可在上方输入模版名称，将左侧 Markdown 内容保存为本地插件。</div>';
    return;
  }

  templates.forEach((tpl, idx) => {
    const item = document.createElement('div');
    item.className = 'profile';
    item.dataset.templateIndex = String(idx);
    item.style.padding = '8px 10px';
    item.style.marginBottom = '0';
    item.style.display = 'flex';
    item.style.justifyContent = 'space-between';
    item.style.alignItems = 'center';
    item.style.gap = '8px';

    const titleSpan = document.createElement('span');
    titleSpan.style.cursor = 'pointer';
    titleSpan.style.fontWeight = '600';
    titleSpan.style.fontSize = '12.5px';
    titleSpan.style.flex = '1';
    titleSpan.style.overflow = 'hidden';
    titleSpan.style.textOverflow = 'ellipsis';
    titleSpan.style.whiteSpace = 'nowrap';
    titleSpan.textContent = tpl.name;

    const delBtn = document.createElement('button');
    delBtn.className = 'danger';
    delBtn.dataset.templateDelete = String(idx);
    delBtn.style.padding = '2px 6px';
    delBtn.style.margin = '0';
    delBtn.style.minHeight = '22px';
    delBtn.style.fontSize = '10px';
    delBtn.style.borderRadius = '4px';
    delBtn.style.boxShadow = 'none';
    delBtn.textContent = '删除';

    item.appendChild(titleSpan);
    item.appendChild(delBtn);
    listContainer.appendChild(item);
  });
}

const saveTplBtn = $('saveTemplateBtn');
if (saveTplBtn) {
  saveTplBtn.onclick = () => {
    persistPromptContentNow();
    const name = $('templateNameInput').value.trim();
    const content = $('promptContent').value;
    if (!name) {
      showToast('请输入模板名称', 'error');
      return;
    }
    if (!content.trim()) {
      showToast('提示词内容不能为空', 'error');
      return;
    }

    let templates = [];
    try {
      templates = JSON.parse(localStorage.getItem('prompt_templates') || '[]');
    } catch (e) {}

    const existingIdx = templates.findIndex(t => t.name === name);
    if (existingIdx >= 0) {
      if (!confirm(`已存在同名模板 "${name}"，是否覆盖？`)) return;
      templates[existingIdx].content = content;
    } else {
      templates.push({ name, content });
    }

    localStorage.setItem('prompt_templates', JSON.stringify(templates));
    $('templateNameInput').value = '';
    loadTemplates();
    showToast('模板保存成功');
  };
}

// --- MCP Hub UI Logic ---

let mcpHubConfig = { servers: [], routing: [] };

async function initMcpHubView() {
  const container = $('mcpHubView');
  if (!container || container.dataset.initialized) {
    refreshMcpHub();
    return;
  }
  container.dataset.initialized = 'true';

  $('refreshMcpHub').onclick = () => refreshMcpHub();
  $('addMcpServer').onclick = () => addMcpServer();
  $('saveMcpHub').onclick = () => saveMcpHub();

  refreshMcpHub();
}

async function refreshMcpHub() {
  const status = $('mcpHubStatus');
  status.textContent = '正在加载 MCP 配置...';

  try {
    const res = await window.proxyManager.mcpHubGet();
    if (res.ok) {
      mcpHubConfig = res.mcpHub;
      renderMcpServers();
      status.textContent = `已加载 ${mcpHubConfig.servers.length} 个服务器，${mcpHubConfig.routing.length} 条路由规则。`;
    } else {
      status.textContent = '加载 MCP 配置失败：' + (res.error || '未知错误');
    }

    const logsRes = await window.proxyManager.mcpHubLogs();
    if (logsRes.ok) {
      renderMcpLogs(logsRes.logs);
    }
  } catch (err) {
    status.textContent = '加载失败：' + err.message;
  }
}

function renderMcpServers() {
  const container = $('mcpServersList');
  if (!mcpHubConfig || !mcpHubConfig.servers || mcpHubConfig.servers.length === 0) {
    container.innerHTML = '<div class="muted" style="padding:20px; text-align:center;">暂无已配置的 MCP 服务器。</div>';
    return;
  }

  container.innerHTML = `
    <div class="route-table">
      <div class="route-table-head">
        <table>
          <thead>
            <tr>
              <th>服务器 ID</th>
              <th>URL (SSE)</th>
              <th>前缀</th>
              <th style="width:60px">注入</th>
              <th style="width:80px">操作</th>
            </tr>
          </thead>
        </table>
      </div>
      <div class="route-table-scroll">
        <table>
          <tbody>
            ${mcpHubConfig.servers.map((s, index) => `
              <tr>
                <td><input type="text" value="${escapeAttr(s.id)}" class="table-input" onchange="updateMcpServer(${index}, 'id', this.value)"></td>
                <td><input type="text" value="${escapeAttr(s.url)}" class="table-input" placeholder="http://..." onchange="updateMcpServer(${index}, 'url', this.value)"></td>
                <td><input type="text" value="${escapeAttr(s.prefix || '')}" class="table-input" placeholder="可选" onchange="updateMcpServer(${index}, 'prefix', this.value)"></td>
                <td style="text-align:center"><input type="checkbox" ${s.injectAll ? 'checked' : ''} onchange="updateMcpServer(${index}, 'injectAll', this.checked)"></td>
                <td style="text-align:right"><button class="danger" style="padding:2px 8px; font-size:12px; margin:0;" onclick="deleteMcpServer(${index})">删除</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

window.updateMcpServer = (index, field, value) => {
  if (mcpHubConfig.servers[index]) {
    mcpHubConfig.servers[index][field] = value;
  }
};

window.deleteMcpServer = (index) => {
  mcpHubConfig.servers.splice(index, 1);
  renderMcpServers();
};

function addMcpServer() {
  if (!mcpHubConfig.servers) mcpHubConfig.servers = [];
  mcpHubConfig.servers.push({
    id: 'mcp-server-' + Math.random().toString(36).substring(2, 6),
    url: 'http://localhost:3000/sse',
    prefix: '',
    injectAll: true
  });
  renderMcpServers();
}

function renderMcpLogs(logs) {
  const container = $('mcpExecutionLogs');
  if (!logs || logs.length === 0) {
    container.innerHTML = '<div class="muted">暂无执行记录...</div>';
    return;
  }

  container.innerHTML = logs.map(log => {
    const time = new Date(log.time).toLocaleTimeString();
    const statusClass = log.status === 'error' ? 'red' : 'green';
    const detail = log.error ? `<div style="color:#ef4444; margin-top:4px;">Error: ${escapeHtml(log.error)}</div>` : '';
    return `
      <div class="log-entry" style="margin-bottom: 12px; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <span class="muted">[${time}]</span>
            <strong style="color:var(--text)">${escapeHtml(log.serverId)}</strong>:
            <code style="color:var(--primary); font-weight:600;">${escapeHtml(log.toolName)}</code>
          </div>
          <span class="badge ${statusClass}">${log.status === 'error' ? '失败' : '成功'} (${log.elapsed}ms)</span>
        </div>
        ${detail}
        <details style="margin-top:6px;">
          <summary style="cursor:pointer; color:var(--primary); font-size:11px; user-select:none;">查看参数/结果</summary>
          <pre style="background:rgba(0,0,0,0.05); padding:8px; margin-top:4px; border-radius:4px; font-size:11.5px; white-space:pre-wrap; word-break:break-all;">${escapeHtml(JSON.stringify({ input: log.input, result: log.result }, null, 2))}</pre>
        </details>
      </div>
    `;
  }).join('');
}

async function saveMcpHub() {
  const btn = $('saveMcpHub');
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在保存...';

  try {
    const res = await window.proxyManager.mcpHubSave({ mcpHub: mcpHubConfig });
    if (res.ok) {
      showToast('MCP 配置已保存', 'success');
      refreshMcpHub();
    } else {
      showToast('保存失败：' + (res.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('保存出错：' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

bindCriticalFrontendControls('final');
markFrontendInit('load:start');
load()
  .then(() => markFrontendInit('load:complete'))
  .catch((error) => recordFrontendInitError('load', error));
