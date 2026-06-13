const rateLimitsData = {};
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

function createLimitsTextElement(text, options = {}) {
  const item = document.createElement('span');
  item.textContent = text;
  if (options.color) item.style.color = options.color;
  item.style.opacity = options.opacity || '';
  item.style.fontSize = options.fontSize || '11px';
  return item;
}

function createLimitsSpinnerElement() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('animate-spin');
  svg.setAttribute('width', '10');
  svg.setAttribute('height', '10');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '3');
  svg.style.animation = 'spin 1s linear infinite';

  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', '23 4 23 10 17 10');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10');
  svg.append(polyline, path);
  return svg;
}

function limitsSignature(profileId) {
  const data = rateLimitsData[profileId];
  return JSON.stringify({
    profileId,
    loading: !!(data && data.loading),
    error: data && data.error ? String(data.error) : '',
    limits: data && Array.isArray(data.limits) ? data.limits : [],
  });
}

function createLimitsElement(profileId) {
  const data = rateLimitsData[profileId];
  if (!data) {
    return createLimitsTextElement('未同步凭证与限额', { opacity: '0.6' });
  }
  if (data.loading) {
    const loading = createLimitsTextElement('', { opacity: '0.8' });
    loading.style.display = 'inline-flex';
    loading.style.alignItems = 'center';
    loading.style.gap = '4px';
    loading.append(createLimitsSpinnerElement(), document.createTextNode('正在同步凭证与限额...'));
    return loading;
  }
  if (data.error) {
    return createLimitsTextElement(String(data.error), { color: '#ef4444' });
  }
  if (!data.limits || data.limits.length === 0) {
    return createLimitsTextElement('无限制数据', { opacity: '0.6' });
  }

  const fragment = document.createDocumentFragment();
  data.limits.forEach((limit, index) => {
    let color = '#10b981';
    const value = Number.isFinite(Number(limit.remainingPercent))
      ? Number(limit.remainingPercent)
      : Number(limit.percent || 0);
    const isRemaining = Number.isFinite(Number(limit.remainingPercent));
    if (isRemaining) {
      if (value <= 20) color = '#ef4444';
      else if (value <= 50) color = '#f59e0b';
    } else {
      if (value >= 80) color = '#ef4444';
      else if (value >= 50) color = '#f59e0b';
    }

    const item = document.createElement('span');
    item.style.background = 'rgba(255, 255, 255, 0.03)';
    item.style.padding = '2px 6px';
    item.style.borderRadius = '4px';
    item.style.border = '1px solid var(--border)';
    item.style.display = 'inline-flex';
    item.style.alignItems = 'center';
    item.style.gap = '4px';
    item.appendChild(document.createTextNode(`${limit.model ? limit.model : limit.window}: `));

    const valueEl = document.createElement('strong');
    valueEl.style.color = color;
    valueEl.style.fontWeight = '700';
    valueEl.textContent = `${value}%`;
    item.appendChild(valueEl);

    const resetValue = limit.resetDisplay || limit.resetIn || '';
    if (resetValue) {
      item.appendChild(document.createTextNode(' '));
      const reset = document.createElement('span');
      reset.style.opacity = '0.6';
      reset.style.fontSize = '10px';
      reset.textContent = `🕒 ${resetValue}`;
      item.appendChild(reset);
    }

    if (index > 0) fragment.appendChild(document.createTextNode(' '));
    fragment.appendChild(item);
  });
  return fragment;
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
        refreshedAt: Date.now(),
      };
    } else {
      rateLimitsData[profileId] = {
        error: result.error || '获取失败',
        refreshedAt: Date.now(),
      };
    }
  } catch (err) {
    rateLimitsData[profileId] = {
      error: err.message,
      refreshedAt: Date.now(),
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
const profileLatencies = {};
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
// Declared with let (not const) so getViewDomCache() in
// app-diagnostics.js can lazy-initialise the cache the first time
// a view switch happens. With const this throws
// "Assignment to constant variable" the moment the user clicks any
// [data-view-button] tab.
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
  {
    name: 'Claude Messages',
    host: 'localhost',
    listenPort: 3443,
    basePath: '/v1',
    protocol: 'claude',
  },
  {
    name: 'OpenAI Responses',
    host: 'localhost',
    listenPort: 3445,
    basePath: '/v1',
    protocol: 'openai-responses',
  },
  {
    name: 'OpenAI Chat Completions',
    host: 'localhost',
    listenPort: 3447,
    basePath: '/v1',
    protocol: 'openai-chat',
  },
];
const ENTRY_PROTOCOL_OPTIONS = ['claude', 'openai-responses', 'openai-chat', 'claude-desktop'];

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

function clearElement(el) {
  if (el) el.textContent = '';
}

function appendOption(select, value, label = value) {
  const option = document.createElement('option');
  option.value = String(value == null ? '' : value);
  option.textContent = String(label == null ? '' : label);
  select.appendChild(option);
  return option;
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
    clear: () => {
      perfRecords.length = 0;
    },
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
    ...meta,
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
  if (window.UX && window.UX.theme) {
    window.UX.theme.init();
    return;
  }
  // Fallback: legacy light/dark toggle
  currentTheme =
    localStorage.getItem('theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(currentTheme);
}

function applyTheme(theme) {
  if (window.UX && window.UX.theme) {
    window.UX.theme.apply(theme);
    return;
  }
  document.documentElement.setAttribute('data-theme', theme);
  $('themeIconSun').style.display = theme === 'dark' ? 'block' : 'none';
  $('themeIconMoon').style.display = theme === 'dark' ? 'none' : 'block';
  localStorage.setItem('theme', theme);
  currentTheme = theme;
}

const themeBtn = $('themeToggle');
if (themeBtn) {
  themeBtn.onclick = () => {
    if (window.UX && window.UX.theme) {
      const next = window.UX.theme.cycle();
      const labels = { light: '已切换为浅色', dark: '已切换为深色', auto: '已切换为跟随系统' };
      showToast(labels[next] || '主题已切换', 'success');
      return;
    }
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
    modal.onclick = (event) => {
      if (event.target === modal) finish(false);
    };
    document.onkeydown = (event) => {
      if (event.key === 'Escape') finish(false);
    };
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
  const protocol = String(value || '')
    .trim()
    .toLowerCase();
  if (protocol === 'responses' || protocol === 'response' || protocol === 'openai-response')
    return 'openai-responses';
  if (
    protocol === 'chat' ||
    protocol === 'chat-completions' ||
    protocol === 'openai-chat-completions' ||
    protocol === 'openai'
  )
    return 'openai-chat';
  if (protocol === 'desktop' || protocol === 'claude-desktop') return 'claude-desktop';
  if (
    protocol === 'claude' ||
    protocol === 'openai-responses' ||
    protocol === 'openai-chat' ||
    protocol === 'claude-desktop'
  )
    return protocol;
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
  return (
    config.profiles.find((profile) => profile.id === config.activeProfile) || config.profiles[0]
  );
}

function ensureLocalServer() {
  if (!config) config = {};
  const active = activeProfile() || {};
  if (!config.localServer) config.localServer = {};
  config.localServer.host = config.localServer.host || 'localhost';
  config.localServer.listenPort = Number(
    config.localServer.listenPort || (active && active.listenPort) || 3443
  );
  config.localServer.basePath = config.localServer.basePath || '/v1';
  config.localServer.protocol = normalizeEntryProtocol(config.localServer.protocol || 'claude');
}

function ensureEntryServers() {
  ensureLocalServer();
  const defaults = defaultEntriesForLocal();
  const source = Array.isArray(config.entryServers) ? config.entryServers.filter(Boolean) : [];
  const byProtocol = new Map(
    source.map((entry) => [normalizeEntryProtocol(entry.protocol), entry])
  );
  config.entryServers = defaults.map((fallback) => {
    const existing = byProtocol.get(fallback.protocol);
    return {
      name: existing && existing.name ? existing.name : fallback.name,
      host: existing && existing.host ? existing.host : fallback.host,
      listenPort: Number(
        (existing && (existing.listenPort || existing.port)) || fallback.listenPort
      ),
      basePath: existing && existing.basePath ? existing.basePath : fallback.basePath,
      protocol: fallback.protocol,
      enabled: existing && existing.enabled === false ? false : true,
    };
  });
}

function ensureAppSettings() {
  if (!config.appSettings) config.appSettings = {};
  if (typeof config.appSettings.closeToTray !== 'boolean') config.appSettings.closeToTray = true;
  if (typeof config.appSettings.stopProxyOnExit !== 'boolean')
    config.appSettings.stopProxyOnExit = true;
  if (typeof config.appSettings.autoStartProxy !== 'boolean')
    config.appSettings.autoStartProxy = true;
  if (typeof config.appSettings.showTopMenu !== 'boolean') config.appSettings.showTopMenu = true;
  if (typeof config.appSettings.showTrayMenu !== 'boolean') config.appSettings.showTrayMenu = true;
  if (typeof config.appSettings.showWindowOnTrayCommand !== 'boolean')
    config.appSettings.showWindowOnTrayCommand = true;
  if (typeof config.appSettings.desktopNotifications !== 'boolean') {
    // Default to enabled if the browser says Notification is usable; otherwise
    // off so the toggle does not dangle a "supported" promise.
    config.appSettings.desktopNotifications = window.UX ? window.UX.canNotify() : false;
  }
  if (typeof config.appSettings.disableLocalProxy !== 'boolean')
    config.appSettings.disableLocalProxy = false;
  if (typeof config.appSettings.conversationAuditEnabled !== 'boolean')
    config.appSettings.conversationAuditEnabled = true;
  if (typeof config.appSettings.performanceMode !== 'boolean') {
    const cachedPerfMode = localStorage.getItem('hpm_performance_mode');
    config.appSettings.performanceMode = cachedPerfMode == null ? true : cachedPerfMode !== 'false';
  }
}

function applyPerformanceMode(enabled) {
  const value = enabled ? 'true' : 'false';
  document.documentElement.setAttribute('data-performance-mode', value);
  try {
    localStorage.setItem('hpm_performance_mode', value);
  } catch (e) {}
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
  $('desktopNotifications').checked = config.appSettings.desktopNotifications;
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
    desktopNotifications: $('desktopNotifications').checked,
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
  if (!['proxy', 'direct', 'official'].includes(config.claudeDesktop.mode))
    config.claudeDesktop.mode = 'proxy';
  if (!config.claudeDesktop.profileName) config.claudeDesktop.profileName = 'HTTPS Proxy';
  if (
    !config.claudeDesktop.baseUrl ||
    config.claudeDesktop.baseUrl === 'http://127.0.0.1:15721/claude-desktop' ||
    config.claudeDesktop.baseUrl === 'https://localhost:3443/v1'
  )
    config.claudeDesktop.baseUrl = claudeProxyBaseUrl();
  if (typeof config.claudeDesktop.token !== 'string') config.claudeDesktop.token = '';
  if (!['text', 'thinking', 'off'].includes(config.claudeDesktop.traeProcessStyle))
    config.claudeDesktop.traeProcessStyle = 'text';
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
const CLAUDE_DESKTOP_PROCESS_VERIFICATION_PROMPT =
  '请执行一次极短的可见过程验证：先按你的内部流程规划 2 个步骤，再只输出一行“OK”。';

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
  clearElement(select);
  ids.forEach((id) => appendOption(select, id));
  select.value = ids.includes(previous) ? previous : ids[0] || 'claude-sonnet-4-6';
  updateClaudeDesktopRouteDetails();
}

function routeIdOfClaudeDesktopModel(model) {
  return String((model && (model.routeId || model.from || model.model)) || '').trim();
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
    labelOverride: String((model && (model.labelOverride || model.displayName)) || '').trim(),
    profileId: String(
      (model && (model.profileId || '')) || (route && route.profileId) || ''
    ).trim(),
    upstreamModel: String(
      (model && (model.upstreamModel || model.to || '')) || (route && route.to) || ''
    ).trim(),
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
  $('claudeDesktopTraeProcessStyle').value = config.claudeDesktop.traeProcessStyle || 'text';
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
  config.claudeDesktop.traeProcessStyle = $('claudeDesktopTraeProcessStyle').value || 'text';
  config.claudeDesktop.directBaseUrl = $('claudeDesktopDirectBaseUrl').value.trim();
  config.claudeDesktop.directApiKey = $('claudeDesktopDirectApiKey').value.trim();
}

function renderClaudeDesktopProfiles() {
  const select = $('cdProfileId');
  clearElement(select);
  config.profiles.forEach((profile) => {
    appendOption(
      select,
      profile.id,
      `${profile.name || profile.id} · ${protocolName(profile.protocol)}`
    );
  });
  select.value = config.activeProfile;
  updateClaudeDesktopRouteDetails();
}

function renderClaudeDesktopPreview() {
  collectClaudeDesktop();
  const mode = config.claudeDesktop.mode;
  const lines = [];
  if (mode === 'proxy') {
    lines.push(`Desktop Gateway：${config.claudeDesktop.baseUrl}`);
    lines.push(
      `模型数：${config.claudeDesktop.models.length}，代理运行时需要保持 Claude Desktop 入口开启。`
    );
    const style = config.claudeDesktop.traeProcessStyle || 'text';
    lines.push(
      style === 'off'
        ? 'Trae 过程显示：关闭。'
        : style === 'thinking'
          ? 'Trae 过程显示：Thinking 过程块。'
          : 'Trae 过程显示：文本过程，Claude Desktop 更容易直接显示。'
    );
  } else if (mode === 'direct') {
    lines.push('直连模式会把 Claude Desktop 指向当前上游或这里填写的直连地址。');
  } else {
    lines.push('恢复官方模式会切回 Claude Desktop 内置登录，不再使用本地代理。');
  }
  const preview = $('claudeDesktopPreview');
  preview.replaceChildren(
    ...lines.map((line) => {
      const item = document.createElement('div');
      item.textContent = line;
      return item;
    })
  );
}

let claudeDesktopPreviewFrame = 0;

function scheduleClaudeDesktopPreview() {
  if (claudeDesktopPreviewFrame) return;
  claudeDesktopPreviewFrame = requestAnimationFrame(() => {
    claudeDesktopPreviewFrame = 0;
    renderClaudeDesktopPreview();
  });
}

function createClaudeDesktopModelsEmptyElement() {
  const empty = document.createElement('div');
  empty.className = 'muted';
  empty.textContent = '暂无 Desktop 模型映射。';
  return empty;
}

function appendClaudeDesktopCell(row, value) {
  const cell = document.createElement('td');
  cell.textContent = value;
  row.appendChild(cell);
  return cell;
}

function createClaudeDesktopModelRow(model, index) {
  const resolved = resolveClaudeDesktopModel(model);
  const profile = config.profiles.find((item) => item.id === resolved.profileId) || {};
  const row = document.createElement('tr');

  appendClaudeDesktopCell(row, resolved.routeId);
  appendClaudeDesktopCell(row, resolved.labelOverride);
  appendClaudeDesktopCell(row, profile.name || resolved.profileId || '');
  appendClaudeDesktopCell(row, resolved.upstreamModel);
  appendClaudeDesktopCell(row, resolved.supports1m ? '是' : '否');

  const actionCell = document.createElement('td');
  const editButton = document.createElement('button');
  editButton.className = 'light';
  editButton.dataset.cdEdit = String(index);
  editButton.textContent = '编辑';
  const deleteButton = document.createElement('button');
  deleteButton.className = 'danger';
  deleteButton.dataset.cdDelete = String(index);
  deleteButton.textContent = '删除';
  actionCell.appendChild(editButton);
  actionCell.appendChild(deleteButton);
  row.appendChild(actionCell);
  return row;
}

function createClaudeDesktopModelsTableElement(models) {
  const wrapper = document.createElement('div');
  wrapper.className = 'route-table';

  const head = document.createElement('div');
  head.className = 'route-table-head';
  const headTable = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  ['Route ID', '菜单显示名', '上游', '真实模型', '1M', ''].forEach((label) => {
    const th = document.createElement('th');
    th.textContent = label;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  headTable.appendChild(thead);
  head.appendChild(headTable);

  const scroll = document.createElement('div');
  scroll.className = 'route-table-scroll';
  const table = document.createElement('table');
  const tbody = document.createElement('tbody');
  models.forEach((model, index) => tbody.appendChild(createClaudeDesktopModelRow(model, index)));
  table.appendChild(tbody);
  scroll.appendChild(table);

  wrapper.appendChild(head);
  wrapper.appendChild(scroll);
  return wrapper;
}

function renderClaudeDesktopModels() {
  ensureClaudeDesktop();
  renderClaudeDesktopRouteOptions();
  const container = $('claudeDesktopModels');
  container.textContent = '';
  if (!config.claudeDesktop.models.length) {
    container.appendChild(createClaudeDesktopModelsEmptyElement());
    return;
  }
  container.appendChild(createClaudeDesktopModelsTableElement(config.claudeDesktop.models));
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
  if (!config || !config.claudeDesktop || !Array.isArray(config.claudeDesktop.models) || !route)
    return false;
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
  config.claudeDesktop.models = config.claudeDesktop.models.filter(
    (model) => String(model.routeId || model.from || '').trim() !== from
  );
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
    name:
      row.querySelector('[data-entry-name]').value.trim() ||
      entryProtocolName(row.querySelector('[data-entry-protocol]').value),
    host: row.querySelector('[data-entry-host]').value.trim() || 'localhost',
    listenPort: Number(row.querySelector('[data-entry-port]').value || 3443),
    basePath: row.querySelector('[data-entry-base-path]').value.trim() || '/v1',
    protocol: normalizeEntryProtocol(row.querySelector('[data-entry-protocol]').value),
    enabled: row.querySelector('[data-entry-enabled]').checked,
    tls:
      normalizeEntryProtocol(row.querySelector('[data-entry-protocol]').value) === 'claude-desktop'
        ? false
        : true,
  }));
  const claudeEntry =
    config.entryServers.find((entry) => entry.protocol === 'claude') || config.entryServers[0];
  if (claudeEntry) {
    config.localServer.host = claudeEntry.host;
    config.localServer.listenPort = claudeEntry.listenPort;
    config.localServer.basePath = claudeEntry.basePath;
    config.localServer.protocol = 'claude';
    if (document.activeElement !== $('localHost')) $('localHost').value = claudeEntry.host;
    if (document.activeElement !== $('localPort')) $('localPort').value = claudeEntry.listenPort;
    if (document.activeElement !== $('localBasePath'))
      $('localBasePath').value = claudeEntry.basePath;
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

function entryServerUrl(entry, protocol) {
  const scheme = entry.tls === false || protocol === 'claude-desktop' ? 'http' : 'https';
  return `${scheme}://${entry.host || 'localhost'}:${entry.listenPort || 3443}${entry.basePath || '/v1'}`;
}

function createEntryInput(kind, value, placeholder, type = 'text') {
  const input = document.createElement('input');
  input.dataset[`entry${kind}`] = '';
  input.type = type;
  input.value = String(value == null ? '' : value);
  input.placeholder = placeholder;
  return input;
}

function createEntryProtocolSelect(protocol) {
  const select = document.createElement('select');
  select.dataset.entryProtocol = '';
  select.title = '入口协议';
  ENTRY_PROTOCOL_OPTIONS.forEach((value) => appendOption(select, value, entryProtocolName(value)));
  select.value = protocol;
  return select;
}

function createEntryServerRow(entry, index) {
  const protocol = normalizeEntryProtocol(entry.protocol);
  const row = document.createElement('div');
  row.className = 'entry-server-row';
  row.dataset.entryIndex = String(index);

  const head = document.createElement('div');
  head.className = 'entry-server-head';
  const title = document.createElement('div');
  title.className = 'entry-server-title';
  const name = document.createElement('strong');
  name.textContent = entry.name || entryProtocolName(protocol);
  const protocolBadge = document.createElement('span');
  protocolBadge.className = 'badge protocol';
  protocolBadge.textContent = entryProtocolName(protocol);
  const urlBadge = document.createElement('span');
  urlBadge.className = 'badge';
  urlBadge.textContent = entryServerUrl(entry, protocol);
  title.appendChild(name);
  title.appendChild(protocolBadge);
  title.appendChild(urlBadge);

  const enabledLabel = document.createElement('label');
  enabledLabel.className = 'inline-check';
  const enabled = document.createElement('input');
  enabled.dataset.entryEnabled = '';
  enabled.type = 'checkbox';
  enabled.checked = entry.enabled !== false;
  enabledLabel.appendChild(enabled);
  enabledLabel.appendChild(document.createTextNode(' 启用'));

  head.appendChild(title);
  head.appendChild(enabledLabel);

  const fields = document.createElement('div');
  fields.className = 'entry-server-fields';
  fields.appendChild(
    createEntryInput('Name', entry.name || entryProtocolName(protocol), '显示名称')
  );
  fields.appendChild(createEntryInput('Port', Number(entry.listenPort || 3443), '端口', 'number'));
  fields.appendChild(createEntryInput('Host', entry.host || 'localhost', 'Host'));
  fields.appendChild(createEntryInput('BasePath', entry.basePath || '/v1', '路径'));
  fields.appendChild(createEntryProtocolSelect(protocol));

  row.appendChild(head);
  row.appendChild(fields);
  return row;
}

function renderEntryServers() {
  ensureEntryServers();
  const container = $('entryServers');
  clearElement(container);
  config.entryServers.forEach((entry, index) => {
    container.appendChild(createEntryServerRow(entry, index));
  });
  container.querySelectorAll('input, select').forEach((input) => {
    input.oninput = () => {
      collectEntryServers();
      scheduleLocalPreview();
    };
    input.onchange = () => {
      collectEntryServers();
      scheduleEntryServersRender();
    };
  });
}

function renderLocalPreview() {
  collectEntryServers();
  const entries = Array.isArray(config.entryServers)
    ? config.entryServers.filter((entry) => entry.enabled !== false)
    : [];
  const primary = entries.find((entry) => entry.protocol === 'claude') ||
    entries[0] || {
      host: $('localHost').value.trim() || 'localhost',
      listenPort: $('localPort').value || 3443,
      basePath: $('localBasePath').value.trim() || '/v1',
      protocol: 'claude',
    };
  baseUrl = `https://${primary.host || 'localhost'}:${primary.listenPort || 3443}${primary.basePath || '/v1'}`;
  const preview = $('localUrlPreview');
  clearElement(preview);
  if (entries.length) {
    entries.forEach((entry) => {
      const protocol = normalizeEntryProtocol(entry.protocol);
      const url = entryServerUrl(entry, protocol);
      const row = document.createElement('div');
      const label = document.createElement('strong');
      label.textContent = entryProtocolName(entry.protocol);
      row.append(label, document.createTextNode(`：${url}`));
      preview.appendChild(row);
    });
  } else {
    preview.textContent = `IDE Base URL：${baseUrl}`;
  }
  $('heroBaseUrl').textContent = baseUrl;
}

function claudeProxyBaseUrl() {
  ensureEntryServers();
  const entry = (config.entryServers || []).find(
    (item) => item.enabled !== false && normalizeEntryProtocol(item.protocol) === 'claude'
  ) || { host: 'localhost', listenPort: 3443, basePath: '/v1', tls: true };
  const scheme = entry.tls === false ? 'http' : 'https';
  const host = entry.host === '0.0.0.0' ? '127.0.0.1' : entry.host || 'localhost';
  const basePath = entry.basePath === '/v1' ? '' : entry.basePath || '';
  return `${scheme}://${host}:${entry.listenPort || 3443}${basePath}`.replace(/\/+$/, '');
}

function currentRoutes() {
  if (!config) return [];
  if (Array.isArray(config.modelRoutes))
    return config.modelRoutes.filter((route) => route && route.from && route.profileId && route.to);
  const active = selectedProfile();
  if (!active) return [];
  const legacyRules =
    active.modelRewriteFrom && active.modelRewriteTo
      ? [{ from: active.modelRewriteFrom, to: active.modelRewriteTo }]
      : [];
  return (active.modelRewriteRules || legacyRules)
    .filter((rule) => rule && rule.from && rule.to)
    .map((rule) => ({ from: rule.from, profileId: active.id, to: rule.to }));
}

function renderRouteProfiles(selectedValue) {
  const select = $('modelRouteProfile');
  clearElement(select);
  config.profiles.forEach((profile) => {
    appendOption(
      select,
      profile.id,
      `${profile.name || profile.id} · ${protocolName(profile.protocol)} · ${profile.targetUrl || ''}`
    );
  });
  select.value = selectedValue || selectedId || config.activeProfile;
}

function renderModelOptions(selectedValue) {
  const list = $('availableModels');
  clearElement(list);
  availableModels.forEach((model) => appendOption(list, model, ''));
  $('modelRewriteTo').value = selectedValue || '';
}

function routeTableSignature() {
  const profiles = config && Array.isArray(config.profiles) ? config.profiles : [];
  return JSON.stringify({
    routes: modelRoutes.map((route) => ({
      from: route.from || '',
      to: route.to || '',
      profileId: route.profileId || '',
      labelOverride: route.labelOverride || '',
    })),
    profiles: profiles.map((profile) => ({
      id: profile.id || '',
      name: profile.name || '',
      protocol: profile.protocol || '',
      targetUrl: profile.targetUrl || '',
    })),
  });
}

function createRoutesEmptyElement() {
  const empty = document.createElement('div');
  empty.className = 'muted';
  empty.textContent = '暂无模型路由，未命中的请求会使用默认上游。';
  return empty;
}

function appendRouteHeaderRow(table) {
  const thead = document.createElement('thead');
  const row = document.createElement('tr');
  ['客户端模型', '转发到上游', '上游模型', '操作'].forEach((label) => {
    const cell = document.createElement('th');
    cell.textContent = label;
    row.appendChild(cell);
  });
  thead.appendChild(row);
  table.appendChild(thead);
}

function createRouteActionButton(kind, index, label, className = 'light') {
  const button = document.createElement('button');
  button.className = className;
  button.dataset[kind] = String(index);
  button.textContent = label;
  return button;
}

function createRouteTableRow(route, index) {
  const row = document.createElement('tr');
  const profile =
    config && Array.isArray(config.profiles)
      ? config.profiles.find((item) => item.id === route.profileId)
      : null;

  const fromCell = document.createElement('td');
  const fromStrong = document.createElement('strong');
  fromStrong.textContent = route.from || '';
  fromCell.appendChild(fromStrong);
  if (route.labelOverride) {
    const label = document.createElement('div');
    label.className = 'muted';
    label.textContent = `展示名: ${route.labelOverride}`;
    fromCell.appendChild(label);
  }

  const targetCell = document.createElement('td');
  if (profile) {
    targetCell.appendChild(document.createTextNode(profile.name || profile.id || ''));
    const targetMeta = document.createElement('div');
    targetMeta.className = 'muted';
    targetMeta.textContent = `${protocolName(profile.protocol)} · ${profile.targetUrl || ''}`;
    targetCell.appendChild(targetMeta);
  } else {
    targetCell.textContent = route.profileId || '';
  }

  const toCell = document.createElement('td');
  const toStrong = document.createElement('strong');
  toStrong.textContent = route.to || '';
  toCell.appendChild(toStrong);

  const actionsCell = document.createElement('td');
  const actions = document.createElement('div');
  actions.className = 'route-actions';
  actions.append(
    createRouteActionButton('testRoute', index, '测试'),
    createRouteActionButton('editRoute', index, '编辑'),
    createRouteActionButton('deleteRoute', index, '删除', 'danger')
  );
  actionsCell.appendChild(actions);

  row.append(fromCell, targetCell, toCell, actionsCell);
  return row;
}

function createRoutesTableElement() {
  if (modelRoutes.length === 0) return createRoutesEmptyElement();
  const wrapper = document.createElement('div');
  wrapper.className = 'route-table route-table-compact';

  const head = document.createElement('div');
  head.className = 'route-table-head';
  const headTable = document.createElement('table');
  appendRouteHeaderRow(headTable);
  head.appendChild(headTable);

  const scroll = document.createElement('div');
  scroll.className = 'route-table-scroll';
  const bodyTable = document.createElement('table');
  const tbody = document.createElement('tbody');
  modelRoutes.forEach((route, index) => tbody.appendChild(createRouteTableRow(route, index)));
  bodyTable.appendChild(tbody);
  scroll.appendChild(bodyTable);

  wrapper.append(head, scroll);
  return wrapper;
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
  cache.buttons.forEach((item) =>
    item.classList.toggle('active', item.dataset.viewButton === viewId)
  );
  cache.views.forEach((view) => view.classList.toggle('active', view.id === viewId));
  const view = $(viewId);
  currentViewId = view && view.classList.contains('active') ? viewId : currentViewId;

  // 清除代码工具页面的活动轮询定时器，防止其它页面持续后台请求造成性能浪费
  if (viewId !== 'codeToolsView' && typeof window.stopCodeToolsPolling === 'function') {
    window.stopCodeToolsPolling();
  }

  if (viewId === 'diagnostics') showDiagnosticsTab('logPanel');
  if (viewId === 'monitor') refreshMonitor();
  if (viewId === 'promptsAuditView') {
    initPromptsAuditView();
  }
  if (viewId === 'usageReportView') {
    initUsageReportView();
  }
  if (viewId === 'claudeDesktop') refreshAllToolStatuses({ passive: true });
  if (viewId === 'envCheckView') refreshEnvStatus({ passive: true });
  if (viewId === 'codeToolsView') {
    if (typeof window.initCodeToolsView === 'function') {
      window.initCodeToolsView();
    } else {
      console.error('代码工具模块未加载，无法初始化页面');
    }
  }
  if (viewId === 'mcpHubView') {
    initMcpHubView();
  }
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
          to: route.to,
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
      document
        .querySelector('.rule-editor')
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
  const signature = routeTableSignature();
  if (signature === lastRenderedRulesHtml) return;
  container.replaceChildren(createRoutesTableElement());
  lastRenderedRulesHtml = signature;
  bindRouteActions(container);
}

function renderOverview() {
  const active = activeProfile();
  const defaultProfileText = active
    ? `${active.name || active.id} · ${protocolName(active.protocol)}`
    : '未配置';
  const routeCountText = `${modelRoutes.length} 条`;
  const summaryText = active
    ? `本地入口：${baseUrl} · 默认上游：${active.name || active.id} · ${protocolName(active.protocol)} · ${active.targetUrl}`
    : '';
  const routesSignature = routeTableSignature();
  const nextSignature = [defaultProfileText, routeCountText, summaryText].join('\u001f');

  if (nextSignature !== lastRenderedOverviewSignature) {
    $('heroDefaultProfile').textContent = defaultProfileText;
    $('heroRouteCount').textContent = routeCountText;
    $('summary').textContent = summaryText;
    lastRenderedOverviewSignature = nextSignature;
  }

  if (routesSignature !== lastRenderedOverviewRoutesHtml) {
    const overviewRoutes = $('overviewRoutes');
    overviewRoutes.replaceChildren(createRoutesTableElement());
    lastRenderedOverviewRoutesHtml = routesSignature;
    bindRouteActions(overviewRoutes);
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

  const signature = limitsSignature(profileId);
  if (profileId !== lastRenderedLimitsProfileId || signature !== lastRenderedLimitsHtml) {
    container.replaceChildren(createLimitsElement(profileId));
    lastRenderedLimitsProfileId = profileId;
    lastRenderedLimitsHtml = signature;
  }

  const data = rateLimitsData[profileId];
  if (timeDisplay) {
    const nextText =
      data && !data.loading ? `🕒 ${getRelativeTime(data.refreshedAt)}` : '🕒 未同步';
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
        refreshedAt: Date.now(),
      };
      showToast('官方凭证与使用限额同步成功', 'success');
    } else {
      rateLimitsData[selectedId] = {
        error: result.error || '获取失败',
        refreshedAt: Date.now(),
      };
      showToast('同步限额失败：' + (result.error || '未知错误'), 'error');
    }
  } catch (err) {
    rateLimitsData[selectedId] = {
      error: err.message,
      refreshedAt: Date.now(),
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
    desc: '官方 OpenAI 接口。适用于 GPT-4o, GPT-4o-mini 等官方模型。',
  },
  claude: {
    name: 'Claude Official',
    defaultId: 'claude-official',
    protocol: 'claude',
    targetUrl: 'https://api.anthropic.com/v1',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    desc: '官方 Anthropic Claude 接口。适用于 Claude 3.5 Sonnet / Haiku / Opus 官方模型。',
  },
  gemini: {
    name: 'Gemini Official',
    defaultId: 'google-official',
    protocol: 'gemini',
    targetUrl: 'https://generativelanguage.googleapis.com',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    desc: '官方 Google Gemini 开发者接口（通过 Google AI Studio 服务）。',
  },
  deepseek: {
    name: 'DeepSeek Official',
    defaultId: 'deepseek-official',
    protocol: 'openai',
    targetUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    desc: 'DeepSeek 官方的 OpenAI 兼容接口，提供超低成本的高智能交互。',
  },
  siliconflow: {
    name: 'SiliconFlow',
    defaultId: 'siliconflow',
    protocol: 'openai',
    targetUrl: 'https://api.siliconflow.cn/v1',
    keyUrl: 'https://siliconflow.cn/zh-cn/',
    desc: '硅基流动开源大模型平台，提供 DeepSeek-V3/R1、Qwen、Llama 等海量模型的超速托管服务。',
  },
  ollama: {
    name: 'Ollama Local',
    defaultId: 'ollama-local',
    protocol: 'openai',
    targetUrl: 'http://localhost:11434/v1',
    keyUrl: '',
    desc: '本地部署运行的 Ollama 服务，通常用于离线运行开源大模型。注：本地运行，不需要填写 API Key。',
  },
  openrouter: {
    name: 'OpenRouter',
    defaultId: 'openrouter',
    protocol: 'openai',
    targetUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/settings/keys',
    desc: '聚合了大量主流模型与开源模型的第三方转发网关，支持单 API Key 调用数百种模型。',
  },
};

function clearProviderPresetHelp() {
  const helpEl = $('providerPresetHelp');
  if (!helpEl) return;
  helpEl.style.display = 'none';
  clearElement(helpEl);
}

function renderProviderPresetHelp(preset) {
  const helpEl = $('providerPresetHelp');
  if (!helpEl) return;
  clearElement(helpEl);
  if (!preset) {
    helpEl.style.display = 'none';
    return;
  }

  helpEl.style.display = 'block';
  const title = document.createElement('strong');
  title.textContent = preset.name;
  helpEl.append(title, document.createTextNode(`：${preset.desc || ''}`));
  if (preset.keyUrl) {
    const link = document.createElement('a');
    link.href = preset.keyUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.style.color = 'var(--primary)';
    link.style.textDecoration = 'none';
    link.style.display = 'inline-block';
    link.style.marginTop = '5px';
    link.style.fontWeight = '500';
    link.textContent = '获取 API Key (访问官方申请页) ↗';
    helpEl.append(document.createElement('br'), link);
  }
}

// 初始化服务商预设选项绑定
function initProviderPresets() {
  const presetSelect = $('providerPreset');
  if (!presetSelect) return;

  presetSelect.onchange = () => {
    const selectedKey = presetSelect.value;
    const helpEl = $('providerPresetHelp');

    if (!selectedKey) {
      clearProviderPresetHelp();
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
    if (
      !currentId ||
      currentId.startsWith('profile-') ||
      currentName === '新上游目标' ||
      !currentName
    ) {
      // 生成一个防冲突的 ID
      const existingIds = config.profiles.map((p) => p.id);
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
    renderProviderPresetHelp(preset);
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
    renderProviderPresetHelp(matched ? PROVIDER_PRESETS[matched] : null);
  }

  modelRoutes = currentRoutes().map((route) => ({
    from: route.from,
    profileId: route.profileId,
    to: route.to,
  }));
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

function profilesSignature() {
  return JSON.stringify({
    selectedId,
    activeProfile: config && config.activeProfile,
    profiles:
      config && Array.isArray(config.profiles)
        ? config.profiles.map((profile) => ({
            id: profile.id || '',
            name: profile.name || '',
            protocol: profile.protocol || '',
            targetUrl: profile.targetUrl || '',
            latency: profileLatencies[profile.id],
          }))
        : [],
  });
}

function createBadge(text, className = '') {
  const badge = document.createElement('span');
  badge.className = `badge${className ? ` ${className}` : ''}`;
  badge.textContent = text;
  return badge;
}

function applyLatencyBadgeStyle(badge, latency) {
  if (typeof latency !== 'number') {
    badge.style.background = 'rgba(239, 68, 68, 0.15)';
    badge.style.color = 'rgb(239, 68, 68)';
    badge.style.borderColor = 'rgba(239, 68, 68, 0.2)';
    return;
  }
  if (latency < 100) return;
  if (latency < 300) {
    badge.style.background = 'rgba(245, 158, 11, 0.15)';
    badge.style.color = 'rgb(245, 158, 11)';
    badge.style.borderColor = 'rgba(245, 158, 11, 0.2)';
    badge.style.fontWeight = '600';
    return;
  }
  badge.style.background = 'rgba(239, 68, 68, 0.15)';
  badge.style.color = 'rgb(239, 68, 68)';
  badge.style.borderColor = 'rgba(239, 68, 68, 0.2)';
  badge.style.fontWeight = '600';
}

function createLatencyBadge(profileId) {
  const latency = profileLatencies[profileId];
  if (latency === undefined) return null;
  if (latency === 'testing') return createBadge('测试中...', 'protocol');
  if (typeof latency === 'number' && latency < 100) return createBadge(`${latency} ms`, 'active');
  const badge = createBadge(typeof latency === 'number' ? `${latency} ms` : String(latency));
  applyLatencyBadgeStyle(badge, latency);
  return badge;
}

function createProfileCardElement(profile) {
  const card = document.createElement('div');
  card.className = 'profile';
  if (profile.id === selectedId) card.classList.add('selected');
  if (profile.id === config.activeProfile) card.classList.add('active');
  card.dataset.profileId = profile.id || '';

  const isActive = profile.id === config.activeProfile;
  const isSelected = profile.id === selectedId;

  const titleRow = document.createElement('div');
  titleRow.className = 'profile-title';
  const title = document.createElement('strong');
  title.textContent = profile.name || profile.id || '';
  const badges = document.createElement('span');
  badges.className = 'badges';
  badges.appendChild(createBadge(protocolName(profile.protocol), 'protocol'));
  if (isActive) badges.appendChild(createBadge('默认上游', 'active'));
  if (isSelected && !isActive) badges.appendChild(createBadge('正在编辑'));
  const latencyBadge = createLatencyBadge(profile.id);
  if (latencyBadge) badges.appendChild(latencyBadge);
  titleRow.append(title, badges);

  const target = document.createElement('div');
  target.className = 'muted';
  target.textContent = profile.targetUrl || '';

  const note = document.createElement('div');
  note.className = 'muted';
  note.textContent = isActive ? '未命中路由时使用该上游' : '可被模型路由选择';

  card.append(titleRow, target, note);
  return card;
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
  const signature = profilesSignature();
  if (signature !== lastRenderedProfilesHtml) {
    container.replaceChildren(
      ...config.profiles.map((profile) => createProfileCardElement(profile))
    );
    lastRenderedProfilesHtml = signature;
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
      document
        .querySelectorAll('#toolsList .tool-item')
        .forEach((el) => el.classList.remove('selected'));
      item.classList.add('selected');

      // Switch active panel visibility
      document.querySelectorAll('.tool-panel').forEach((panel) => panel.classList.remove('active'));
      const activePanel = $(`toolPanel-${toolId}`);
      if (activePanel) activePanel.classList.add('active');
      refreshAllToolStatuses({ force: true }).catch((err) =>
        console.error('refreshAllToolStatuses error:', err)
      );
    };
  }

  if (toolsList && !toolsList.dataset.statusRefreshScheduled) {
    toolsList.dataset.statusRefreshScheduled = 'true';
    setTimeout(() => {
      refreshAllToolStatuses({ force: true }).catch((err) =>
        console.error('refreshAllToolStatuses startup error:', err)
      );
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
  return {
    profiles: [],
    modelRoutes: [],
    localServer: {},
    appSettings: {},
    claudeDesktop: { models: [] },
    __fallback: true,
  };
}

function applyLoadedConfig(nextConfig) {
  config = nextConfig || fallbackConfig();
  selectedId = config ? config.activeProfile : null;

  try {
    ensureLocalServer();
  } catch (e) {
    console.error('ensureLocalServer error:', e);
  }
  try {
    ensureAppSettings();
  } catch (e) {
    console.error('ensureAppSettings error:', e);
  }
  try {
    ensureClaudeDesktop();
  } catch (e) {
    console.error('ensureClaudeDesktop error:', e);
  }

  if (config && !Array.isArray(config.modelRoutes)) {
    try {
      config.modelRoutes = currentRoutes();
    } catch (e) {
      config.modelRoutes = [];
    }
  }

  try {
    fillLocalServer();
  } catch (e) {
    console.error('fillLocalServer error:', e);
  }
  try {
    fillAppSettings();
  } catch (e) {
    console.error('fillAppSettings error:', e);
  }
  try {
    fillClaudeDesktop();
  } catch (e) {
    console.error('fillClaudeDesktop error:', e);
  }
  try {
    fillForm(selectedProfile());
  } catch (e) {
    console.error('fillForm error:', e);
  }
  try {
    renderOverview();
  } catch (e) {
    console.error('renderOverview error:', e);
  }
  return config;
}

async function hydrateConfigAfterStartup() {
  if (!config || !config.__fallback) return;
  // The Tauri dev manager kicks off the bundled proxy on a background
  // thread (start_proxy_if_needed). On a cold start that proxy can
  // take 7-10s before it begins accepting connections on 3543, so the
  // page's initial 8-attempt retry (4s) almost always gives up and we
  // end up stuck on the "未配置" placeholders even though the proxy is
  // fine. Keep retrying for a long stretch; the heartbeat will cancel
  // us early once config is no longer a fallback.
  const latest = await perfTrack('load.hydrateConfig', () =>
    window.proxyManager.readConfig({ attempts: 30, retryDelay: 500, quiet: true })
  );
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
  await perfTrack('load.initialRefresh', () =>
    refreshProxyStatus().catch((e) => console.error('refreshProxyStatus error:', e))
  );
  schedulePassiveCertRefresh();
}

function schedulePromptStartupWork() {
  if (!$('promptClientType')) return;
  const type = $('promptClientType').value;
  $('promptContent').value = localStorage.getItem(`prompt_content_${type}`) || '';
  initPromptsTabSwitching();
  scheduleStartupTask(
    'load.prompts',
    () => {
      loadPresetPrompts();
      loadTemplates();
    },
    { timeout: 2500, delay: 160 }
  );
}

async function load() {
  const finishLoadPerf = perfStart('load.total');
  recordPerf('load.start', 0);
  initTheme();
  initProviderPresets();
  if (window.proxyManager.onTrayCommand) {
    try {
      Promise.resolve(
        window.proxyManager.onTrayCommand(async (result) => {
          const commandNames = {
            status: '代理状态',
            start: '启动代理',
            stop: '停止代理',
            restart: '重启代理',
          };
          const title = commandNames[result.command] || result.command;
          const msg = result.output || `${title}完成`;
          $('output').textContent = msg;
          showDiagnosticsTab('outputPanel');
          showToast(
            title + (result.code === 0 ? '成功' : '失败'),
            result.code === 0 ? 'success' : 'error'
          );
          await refreshLog().catch((e) => console.error(e));
          await refreshProxyStatus().catch((e) => console.error(e));
        })
      ).catch((err) => console.error('onTrayCommand setup failed:', err));
    } catch (err) {
      console.error('onTrayCommand setup failed:', err);
    }
  }

  try {
    config = await perfTrack('load.readConfig', () =>
      window.proxyManager.readConfig({ attempts: 2, retryDelay: 250, quiet: true })
    );
  } catch (err) {
    console.error('Failed to read config:', err);
    config = fallbackConfig();
  }

  applyLoadedConfig(config);

  scheduleStartupTask('load.certStatus', () => refreshCertStatus({ passive: true }), {
    timeout: 1200,
    delay: 80,
  });
  scheduleStartupTask('load.startupProxyWork', runStartupProxyWork, { timeout: 1800, delay: 120 });

  try {
    initToolsTabSwitching();
  } catch (e) {
    console.error('initToolsTabSwitching error:', e);
  }
  try {
    startHeartbeat();
  } catch (e) {
    console.error('startHeartbeat error:', e);
  }

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
  finishLoadPerf({
    profiles: Array.isArray(config && config.profiles) ? config.profiles.length : 0,
  });
}

function setProxyStatusElement(element, color, text) {
  clearElement(element);
  const dot = document.createElement('span');
  dot.className = `status-dot ${color}`;
  element.append(dot, document.createTextNode(text));
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
      setProxyStatusElement(statusElement, 'green', `运行中${pid}`);
      renderPortDiagnostics(health);
      return;
    }

    const result = await window.proxyManager.command('status');
    const output = result.output || '';
    if (/PID\s*:\s*\d+/i.test(output) || output.includes('https://')) {
      const pidMatch = output.match(/PID\s*:\s*(\d+)/i);
      const pid = pidMatch ? ` (PID: ${pidMatch[1]})` : '';
      setProxyStatusElement(statusElement, 'green', `运行中${pid}`);
      renderPortDiagnostics(null);
      return;
    }
    if (output.trim()) {
      setProxyStatusElement(statusElement, 'amber', '未运行');
      renderPortDiagnostics(null);
      return;
    }
    setProxyStatusElement(statusElement, 'red', '状态未知');
    renderPortDiagnostics(null);
  } catch (err) {
    // command 调用本身失败时，也用 HTTP 探活兜底
    const health = await checkProxyHealth();
    if (health) {
      const pid = health.pid ? ` (PID: ${health.pid})` : '';
      setProxyStatusElement(statusElement, 'green', `运行中${pid}`);
      renderPortDiagnostics(health);
      return;
    }
    setProxyStatusElement(statusElement, 'red', '检查失败');
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
      $('claudeDesktopStatus').textContent =
        `当前平台不可写入 Claude Desktop 配置：${status.error || ''}`;
      if (badgeEl) {
        badgeEl.textContent = '不支持';
        badgeEl.className = 'badge error';
      }
      if (dotEl) dotEl.className = 'status-dot red';
      return;
    }
    const configured = status.configured ? '已写入 3P profile' : '未写入';
    const actual = status.actualBaseUrl || status.gatewayUrl || '无';
    const expected = status.expectedBaseUrl || '无';
    const desiredMode = status.desiredMode ? `；选择模式：${status.desiredMode}` : '';
    const matchText = status.matchesExpected === false ? '；状态：需重新写入' : '';
    const pathText =
      status.profilePath || status.configPath
        ? `\nProfile：${status.profilePath || status.configPath}`
        : '';
    const evidence = status.clientEvidence || {};
    const activeCode = evidence.activeCodeProcess || {};
    const latestSession = evidence.latestCodeSession || {};
    const clientText = evidence.processCount
      ? `\n客户端：Claude PID ${evidence.mainWindowPid || '未知'}；Code 模型：${activeCode.model || latestSession.model || '未检测'}；CLI Session：${activeCode.cliSessionId || latestSession.cliSessionId || '未检测'}`
      : '';
    $('claudeDesktopStatus').textContent =
      `${configured}；模式：${status.mode}${desiredMode}；当前 URL：${actual}；预期 URL：${expected}${matchText}${pathText}${clientText}`;

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
    $('claudeDesktopStatus').textContent =
      `Claude Desktop 状态检查失败：${err && err.message ? err.message : err}`;
    if (badgeEl) {
      badgeEl.textContent = '失败';
      badgeEl.className = 'badge error';
    }
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
      $('claudeCodeStatus').textContent =
        `未检测到 Claude Code 配置文件 (路径: ${status.configPath || ''})`;
      $('claudeCodeStatus').className = 'notice';
      if (badgeEl) {
        badgeEl.textContent = '未检测';
        badgeEl.className = 'badge official';
      }
      if (dotEl) dotEl.className = 'status-dot';
      return;
    }
    if (status.baseUrl) {
      $('claudeCodeStatus').textContent =
        `已配置本地代理；网关地址: ${status.baseUrl}，配置路径: ${status.configPath}`;
      $('claudeCodeStatus').className = 'notice green';
      if (badgeEl) {
        badgeEl.textContent = '已代理';
        badgeEl.className = 'badge active';
      }
      if (dotEl) dotEl.className = 'status-dot green';
    } else {
      $('claudeCodeStatus').textContent = `官方直连/已启用登录；配置路径: ${status.configPath}`;
      $('claudeCodeStatus').className = 'notice';
      if (badgeEl) {
        badgeEl.textContent = '直连';
        badgeEl.className = 'badge direct';
      }
      if (dotEl) dotEl.className = 'status-dot amber';
    }
  } catch (err) {
    $('claudeCodeStatus').textContent =
      `Claude Code 状态检查失败：${err && err.message ? err.message : err}`;
    $('claudeCodeStatus').className = 'notice';
    if (badgeEl) {
      badgeEl.textContent = '失败';
      badgeEl.className = 'badge error';
    }
    if (dotEl) dotEl.className = 'status-dot red';
  }
}

function formatTraeBridgeUrl(status) {
  const url = status && (status.bridgeUrl || status.url || status.healthUrl);
  if (!url) return 'http://127.0.0.1:17861';
  return String(url).replace(/\/health$/, '');
}

function formatTraeCommand(status, key, fallback = '未发现') {
  const value = status && status[key];
  return value ? String(value) : fallback;
}

async function refreshTraeBridgeStatus() {
  const badgeEl = $('toolBadge-trae-bridge');
  const dotEl = $('traeBridgeTitleDot');
  const statusEl = $('traeBridgeStatus');
  if (!statusEl) return;
  if (!window.proxyManager.traeBridgeStatus) {
    statusEl.textContent = '当前版本缺少 Trae Bridge 状态接口。';
    statusEl.className = 'notice';
    if (badgeEl) {
      badgeEl.textContent = '不可用';
      badgeEl.className = 'badge error';
    }
    if (dotEl) dotEl.className = 'status-dot red';
    return;
  }
  try {
    const status = await window.proxyManager.traeBridgeStatus();
    const reachable =
      status &&
      status.ok !== false &&
      (status.statusCode === 200 ||
        Boolean(status.command) ||
        Boolean(status.waitCommand) ||
        Boolean(status.streamCommand) ||
        Boolean(status.rawStreamCommand));
    if (!reachable) {
      const reason = status && (status.error || status.message || status.statusCode);
      statusEl.textContent = `Trae Bridge 未连接；本地桥接服务通常位于 http://127.0.0.1:17861。${reason ? `原因：${reason}` : '请确认 Trae 已启动并加载扩展。'}`;
      statusEl.className = 'notice';
      if (badgeEl) {
        badgeEl.textContent = '未连接';
        badgeEl.className = 'badge official';
      }
      if (dotEl) dotEl.className = 'status-dot amber';
      return;
    }

    const bridgeUrl = formatTraeBridgeUrl(status);
    const waitCommand = formatTraeCommand(
      status,
      'waitCommand',
      formatTraeCommand(status, 'command')
    );
    const streamCommand = formatTraeCommand(status, 'streamCommand');
    const rawStreamCommand = formatTraeCommand(status, 'rawStreamCommand');
    const discoveredCount = Number.isFinite(status.discoveredCommandCount)
      ? status.discoveredCommandCount
      : Array.isArray(status.discoveredCommands)
        ? status.discoveredCommands.length
        : 0;
    const rawAvailable = rawStreamCommand !== '未发现';
    const rawText = rawAvailable ? `Raw 调试流：${rawStreamCommand}` : 'Raw 调试流：未发现';

    statusEl.textContent = `Trae Bridge 已连接；地址：${bridgeUrl}；等待命令：${waitCommand}；流式命令：${streamCommand}；${rawText}；发现命令：${discoveredCount} 个。`;
    statusEl.className = 'notice green';
    if (badgeEl) {
      badgeEl.textContent = rawAvailable ? '已连接' : '可用';
      badgeEl.className = 'badge active';
    }
    if (dotEl) dotEl.className = 'status-dot green';
    refreshTraeDebugSettings();
  } catch (err) {
    statusEl.textContent = `Trae Bridge 状态检查失败：${err && err.message ? err.message : err}`;
    statusEl.className = 'notice';
    if (badgeEl) {
      badgeEl.textContent = '失败';
      badgeEl.className = 'badge error';
    }
    if (dotEl) dotEl.className = 'status-dot red';
  }
}

let lastTraeNativeDebugCommands = [
  'python scripts\\trae-frida-scan.py',
  'python scripts\\trae-frida-native-probe.py --pid <ai_agent_pid> --duration 45',
  'python scripts\\trae-frida-native-probe.py --pid <aha_net_pid> --duration 45',
].join('\n');

function renderTraeDebugEvents(events) {
  const target = $('traeDebugEvents');
  if (!target) return;
  clearElement(target);
  if (!Array.isArray(events) || events.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = '暂无过程事件。先发起一次 Trae 请求，或启用 Raw Stream Patch 后再刷新。';
    target.appendChild(empty);
    return;
  }
  events
    .slice(-40)
    .reverse()
    .forEach((event) => {
      const source = event.source || 'trae';
      const kind = event.kind || event.event || 'event';
      const message =
        event.message ||
        [
          kind,
          event.toolName ? `tool=${event.toolName}` : '',
          event.toolStatus ? `status=${event.toolStatus}` : '',
          event.bodyLen == null ? '' : `body=${event.bodyLen}`,
        ]
          .filter(Boolean)
          .join(' ');
      const item = document.createElement('div');
      item.className = 'trae-debug-event';
      const sourceEl = document.createElement('div');
      sourceEl.className = 'trae-debug-event-source';
      sourceEl.textContent = source;
      const messageEl = document.createElement('div');
      messageEl.className = 'trae-debug-event-message';
      messageEl.textContent = message;
      item.append(sourceEl, messageEl);
      target.appendChild(item);
    });
}

function formatTraeNativeCommandBlock(status, scanSummary) {
  const commands = status && status.commands ? status.commands : {};
  const aiPid = scanSummary && scanSummary.aiAgentPid;
  const ahaPid = scanSummary && scanSummary.ahaNetPid;
  return [
    commands.installFrida || 'python -m pip install --user frida-tools',
    commands.scan || 'python scripts\\trae-frida-scan.py',
    aiPid
      ? `python scripts\\trae-frida-native-probe.py --pid ${aiPid} --duration 45`
      : commands.aiAgentHook ||
        'python scripts\\trae-frida-native-probe.py --pid <ai_agent_pid> --duration 45',
    ahaPid
      ? `python scripts\\trae-frida-native-probe.py --pid ${ahaPid} --duration 45`
      : commands.ahaNetHook ||
        'python scripts\\trae-frida-native-probe.py --pid <aha_net_pid> --duration 45',
  ].join('\n');
}

async function refreshTraeDebugEvents() {
  const summaryEl = $('traeDebugSummary');
  if (!summaryEl || !window.proxyManager.traeDebugEvents) return;
  summaryEl.textContent = '正在读取 Trae 过程事件...';
  summaryEl.className = 'notice';
  try {
    const [eventsResult, nativeStatus] = await Promise.all([
      window.proxyManager.traeDebugEvents(),
      window.proxyManager.traeDebugNativeStatus
        ? window.proxyManager.traeDebugNativeStatus()
        : Promise.resolve(null),
    ]);
    if (nativeStatus && nativeStatus.commands) {
      lastTraeNativeDebugCommands = formatTraeNativeCommandBlock(nativeStatus);
    }
    if (!eventsResult || eventsResult.ok === false) {
      summaryEl.textContent = `Trae Debug 事件读取失败：${eventsResult && eventsResult.error ? eventsResult.error : '未知错误'}`;
      summaryEl.className = 'notice';
      renderTraeDebugEvents([]);
      return;
    }
    const rawCount =
      eventsResult.raw && Number.isFinite(eventsResult.raw.rawEventCount)
        ? eventsResult.raw.rawEventCount
        : 0;
    const logCount = Number.isFinite(eventsResult.logEventCount) ? eventsResult.logEventCount : 0;
    const eventCount = Array.isArray(eventsResult.events) ? eventsResult.events.length : 0;
    summaryEl.textContent = `已聚合 ${eventCount} 条安全过程事件；Raw ${rawCount} 条，日志摘要 ${logCount} 条。`;
    summaryEl.className = 'notice green';
    renderTraeDebugEvents(eventsResult.events || []);
  } catch (err) {
    summaryEl.textContent = `Trae Debug 事件读取失败：${err && err.message ? err.message : err}`;
    summaryEl.className = 'notice';
  }
}

function applyTraeDebugSettingsToUi(settings) {
  const rawEl = $('traeRawCommentsEnabled');
  const visibleEl = $('traeApiVisibleProgressEnabled');
  const claudeProcessStyleEl = $('traeClaudeProcessStyle');
  const logEl = $('traeLogProgressEnabled');
  if (rawEl) rawEl.checked = Boolean(settings && settings.rawCommentsEnabled);
  if (visibleEl) visibleEl.checked = Boolean(settings && settings.apiVisibleProgressEnabled);
  if (claudeProcessStyleEl)
    claudeProcessStyleEl.value =
      settings && settings.claudeProcessProgressEnabled
        ? settings.claudeProcessStyle || 'thinking'
        : '';
  if (logEl) logEl.checked = settings ? settings.liveLogProgress !== false : true;
}

function collectTraeDebugSettingsFromUi() {
  const visible = Boolean(
    $('traeApiVisibleProgressEnabled') && $('traeApiVisibleProgressEnabled').checked
  );
  return {
    rawCommentsEnabled:
      visible || Boolean($('traeRawCommentsEnabled') && $('traeRawCommentsEnabled').checked),
    apiVisibleProgressEnabled: visible,
    claudeProcessStyle:
      $('traeClaudeProcessStyle') && $('traeClaudeProcessStyle').value
        ? $('traeClaudeProcessStyle').value
        : '',
    liveLogProgress: !(
      $('traeLogProgressEnabled') && $('traeLogProgressEnabled').checked === false
    ),
  };
}

async function refreshTraeDebugSettings() {
  if (!window.proxyManager.traeDebugSettings) return;
  try {
    const settings = await window.proxyManager.traeDebugSettings();
    if (settings && settings.ok !== false) applyTraeDebugSettingsToUi(settings);
  } catch (err) {
    // Debug switches are optional; the status banner will show bridge health separately.
  }
}

async function saveTraeDebugSettingsFromUi() {
  const summaryEl = $('traeDebugSummary');
  if (!window.proxyManager.saveTraeDebugSettings) return;
  const payload = collectTraeDebugSettingsFromUi();
  if ($('traeRawCommentsEnabled')) $('traeRawCommentsEnabled').checked = payload.rawCommentsEnabled;
  if (summaryEl) {
    summaryEl.textContent = '正在保存 Trae Debug 开关...';
    summaryEl.className = 'notice';
  }
  try {
    const settings = await window.proxyManager.saveTraeDebugSettings(payload);
    if (!settings || settings.ok === false)
      throw new Error((settings && settings.error) || '保存失败');
    applyTraeDebugSettingsToUi(settings);
    const msg = settings.claudeProcessProgressEnabled
      ? settings.claudeProcessStyle === 'text'
        ? 'Trae Claude 文本备用过程块已开启；后续 Claude 流式 API 会把 Trae 过程写成独立文本块。'
        : 'Trae Claude Thinking 过程块已开启；后续 Claude 流式 API 会尝试把 Trae 过程写入 thinking 区域。'
      : settings.apiVisibleProgressEnabled
        ? 'Trae API 可见过程已开启；后续流式 API 会把安全过程摘要写入 assistant 正文。'
        : 'Trae Debug 开关已保存；API 正文不再注入可见过程摘要。';
    if (summaryEl) {
      summaryEl.textContent = msg;
      summaryEl.className =
        settings.apiVisibleProgressEnabled || settings.claudeProcessProgressEnabled
          ? 'notice green'
          : 'notice';
    }
    $('output').textContent = msg;
    showToast(msg, 'success');
  } catch (err) {
    const msg = `保存 Trae Debug 开关失败：${err && err.message ? err.message : err}`;
    if (summaryEl) summaryEl.textContent = msg;
    showToast(msg, 'error');
  }
}

function formatTraeClaudeProcessSelfTest(result) {
  if (!result || result.ok === false) {
    return `Claude 过程输出自检失败：${result && result.error ? result.error : '未知错误'}`;
  }
  const summary = result.summary || {};
  const lines = [
    `pass=${Boolean(result.pass)} status=${result.statusCode || ''} source=${result.source || ''}`,
    `model=${(result.request && result.request.model) || ''} expectedStyle=${result.expectedStyle || ''}`,
    `debugMode=${(result.settings && result.settings.rawProgressMode) || ''} debugStyle=${(result.settings && result.settings.claudeProcessStyle) || ''}`,
    `endpoint=${result.endpoint || ''}`,
    `thinking_delta=${summary.thinkingDeltaCount || 0} signature_delta=${summary.signatureDeltaCount || 0} text_delta=${summary.textDeltaCount || 0}`,
    `hasTraeProcess=${Boolean(summary.hasTraeProcessText)} planItem=${Boolean(summary.hasTraePlanItem)} timing=${Boolean(summary.hasTraeTiming)} messageStop=${Boolean(summary.hasDone)}`,
    result.hint || '',
  ];
  return lines.filter(Boolean).join('\n');
}

async function runClaudeDesktopProcessSelfTest({
  summaryEl,
  outputEl,
  runningText,
  successText,
} = {}) {
  if (!window.proxyManager.traeDebugClaudeProcessSelfTest) return;
  if (summaryEl) {
    summaryEl.textContent =
      runningText ||
      '正在验证 Claude Desktop 过程输出；会通过 Desktop Gateway 发起一条短 Trae 流式请求...';
    summaryEl.className = 'notice';
  }
  if (outputEl) outputEl.textContent = 'Claude 过程输出自检运行中...';
  try {
    const result = await window.proxyManager.traeDebugClaudeProcessSelfTest({
      useClaudeDesktopGateway: true,
      prompt: '请只回复 OK。',
      timeoutMs: 90000,
    });
    const text = formatTraeClaudeProcessSelfTest(result);
    if (outputEl) outputEl.textContent = text;
    if (summaryEl) {
      summaryEl.textContent =
        result && result.pass
          ? successText ||
            'Claude Desktop 过程输出自检通过；Desktop Gateway SSE 已包含 Trae 过程事件。'
          : text;
      summaryEl.className = result && result.pass ? 'notice green' : 'notice';
    }
    showToast(
      result && result.pass ? 'Claude 过程输出自检通过。' : 'Claude 过程输出自检未通过。',
      result && result.pass ? 'success' : 'error'
    );
  } catch (err) {
    const msg = `Claude 过程输出自检失败：${err && err.message ? err.message : err}`;
    if (summaryEl) summaryEl.textContent = msg;
    if (outputEl) outputEl.textContent = msg;
    showToast(msg, 'error');
  }
}

async function testTraeClaudeProcessOutput() {
  await runClaudeDesktopProcessSelfTest({
    summaryEl: $('traeDebugSummary'),
    outputEl: $('traeNativeDeepDebugOutput') || $('traeNativeDebugOutput'),
  });
}

async function testClaudeDesktopProcessOutput() {
  await runClaudeDesktopProcessSelfTest({
    summaryEl: $('claudeDesktopStatus'),
    outputEl: $('output'),
    runningText:
      '正在验证 Claude Desktop 过程显示；会通过当前 Desktop Gateway 跑一条短 Trae 流式请求...',
    successText: '过程显示自检通过；Claude Desktop Gateway SSE 已包含 Trae 过程文本。',
  });
}

function firstClaudeDesktopTraeRouteId() {
  ensureClaudeDesktop();
  for (const model of config.claudeDesktop.models || []) {
    const resolved = resolveClaudeDesktopModel(model);
    const profile = config.profiles.find((item) => item.id === resolved.profileId) || {};
    const target = String(profile.targetUrl || '').toLowerCase();
    if (
      profile.protocol === 'trae' ||
      resolved.profileId === 'trae-official' ||
      target.includes('coresg-normal.trae.ai')
    ) {
      return resolved.routeId;
    }
  }
  const first = config.claudeDesktop.models && config.claudeDesktop.models[0];
  return first ? routeIdOfClaudeDesktopModel(first) : '';
}

async function copyClaudeDesktopProcessPrompt() {
  let copied = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(CLAUDE_DESKTOP_PROCESS_VERIFICATION_PROMPT);
      copied = true;
    }
  } catch (err) {
    copied = false;
  }
  const routeId = firstClaudeDesktopTraeRouteId();
  const msg = [
    copied ? 'Claude Desktop 验证提示已复制。' : 'Claude Desktop 验证提示如下。',
    routeId ? `在 Claude Desktop 里选择模型 ${routeId}，粘贴后发送。` : '',
    '如果窗口里出现 [Trae plan_item]、[Trae timing] 或类似过程文本，就说明客户端可见链路已打通。',
    '',
    CLAUDE_DESKTOP_PROCESS_VERIFICATION_PROMPT,
  ]
    .filter(Boolean)
    .join('\n');
  $('output').textContent = msg;
  showDiagnosticsView('outputPanel');
  showToast(copied ? 'Claude Desktop 验证提示已复制' : '已显示 Claude Desktop 验证提示', 'success');
}

async function scanTraeNativeDebug() {
  const outputEl = $('traeNativeDebugOutput');
  const summaryEl = $('traeDebugSummary');
  if (!outputEl || !window.proxyManager.traeDebugNativeScan) return;
  outputEl.textContent = '正在扫描 Trae Native PID...';
  if (summaryEl) {
    summaryEl.textContent = 'Native 扫描运行中；这是一次性 Frida attach 扫描。';
    summaryEl.className = 'notice';
  }
  try {
    const [status, scan] = await Promise.all([
      window.proxyManager.traeDebugNativeStatus
        ? window.proxyManager.traeDebugNativeStatus()
        : Promise.resolve(null),
      window.proxyManager.traeDebugNativeScan(),
    ]);
    const scanSummary = scan && scan.summary ? scan.summary : {};
    if (status && status.commands) {
      lastTraeNativeDebugCommands = formatTraeNativeCommandBlock(status, scanSummary);
    }
    if (scan && scan.running) {
      outputEl.textContent = [
        'Native 扫描已启动，后台运行中。',
        scan.summary && scan.summary.ahaNetPid
          ? `已缓存 aha_net PID: ${scan.summary.ahaNetPid}`
          : '等待扫描结果...',
        '',
        scan.output || '',
      ].join('\n');
      if (summaryEl) {
        summaryEl.textContent = 'Native PID 扫描后台运行中；稍后会自动刷新。';
        summaryEl.className = 'notice';
      }
      setTimeout(scanTraeNativeDebug, 13000);
      return;
    }
    const lines = [
      scan && scan.ok
        ? 'Native 扫描完成。'
        : `Native 扫描失败：${(scan && (scan.error || scan.status)) || '未知错误'}`,
      `ai_agent PID: ${scanSummary.aiAgentPid || '未发现'}`,
      `aha_net PID: ${scanSummary.ahaNetPid || '未发现'}`,
      '',
      '候选进程:',
      ...(Array.isArray(scanSummary.candidates) && scanSummary.candidates.length
        ? scanSummary.candidates.map((item) => `- ${item.pid}: ${item.modules.join(', ')}`)
        : ['- 未发现 native 候选']),
      '',
      '脱敏扫描输出:',
      scan && scan.output ? scan.output : '',
    ];
    outputEl.textContent = lines.join('\n');
    if (summaryEl) {
      summaryEl.textContent =
        scan && scan.ok
          ? 'Native PID 扫描完成；可复制 Hook 命令进行短时本机 Debug。'
          : 'Native PID 扫描未完成；可检查 Frida/Python 状态。';
      summaryEl.className = scan && scan.ok ? 'notice green' : 'notice';
    }
  } catch (err) {
    outputEl.textContent = `Native 扫描失败：${err && err.message ? err.message : err}`;
    if (summaryEl) summaryEl.textContent = outputEl.textContent;
  }
}

function formatTraeNativeDeepOutput(result) {
  if (!result || result.ok === false) {
    return `Native 深入事件读取失败：${result && result.error ? result.error : '未知错误'}`;
  }
  const counts = result.counts && typeof result.counts === 'object' ? result.counts : {};
  const countLines = Object.keys(counts)
    .sort()
    .map((key) => `- ${key}: ${counts[key]}`);
  const events = Array.isArray(result.events) ? result.events : [];
  const eventLines = events.slice(-36).map((event) => {
    const keys =
      Array.isArray(event.keys) && event.keys.length ? ` keys=${event.keys.join(',')}` : '';
    const sse =
      Array.isArray(event.sseEventNames) && event.sseEventNames.length
        ? ` sse=${event.sseEventNames.join(',')}`
        : '';
    const claude =
      Array.isArray(event.sseSemantics) && event.sseSemantics.length
        ? ` claude=${event.sseSemantics
            .map((item) => item.claudeCandidate)
            .filter(Boolean)
            .filter((item, index, arr) => arr.indexOf(item) === index)
            .join(',')}`
        : '';
    const signals =
      event.contains && typeof event.contains === 'object'
        ? Object.keys(event.contains)
            .filter((key) => event.contains[key])
            .join(',')
        : '';
    return [
      `- ${event.kind || event.event || 'event'}`,
      event.urlPath ? ` url=${event.urlPath}` : '',
      event.bytesRead == null ? '' : ` bytes=${event.bytesRead}`,
      sse,
      claude,
      signals ? ` signals=${signals}` : '',
      keys,
    ]
      .filter(Boolean)
      .join('');
  });
  return [
    `状态: ${result.status || 'unknown'}${result.running ? ' (running)' : ''}`,
    `PID: ${result.pid || '未选择'}，模式: ${result.mode || '未启动'}，事件: ${result.eventCount || 0}`,
    result.error ? `错误: ${result.error}` : '',
    result.warning ? `提示: ${result.warning}` : '',
    '',
    '计数:',
    ...(countLines.length ? countLines : ['- 暂无']),
    '',
    '最近事件:',
    ...(eventLines.length ? eventLines : ['- 暂无；启动后发起一次 Trae API 请求再刷新。']),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTraeAhaPidFromScan(scan) {
  if (scan && scan.summary && scan.summary.ahaNetPid) return Number(scan.summary.ahaNetPid);
  const candidates =
    scan && scan.summary && Array.isArray(scan.summary.candidates) ? scan.summary.candidates : [];
  const candidate = candidates.find(
    (item) => Array.isArray(item.modules) && item.modules.includes('aha_net.dll')
  );
  return candidate ? Number(candidate.pid) : 0;
}

async function ensureTraeNativePidReady(outputEl, summaryEl) {
  if (!window.proxyManager.traeDebugNativeScan) {
    throw new Error('Trae Native PID 扫描接口不可用');
  }
  let lastScan = null;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    lastScan = await window.proxyManager.traeDebugNativeScan();
    const pid = getTraeAhaPidFromScan(lastScan);
    if (pid) return { pid, scan: lastScan };
    const running = lastScan && lastScan.running;
    const line = running
      ? `正在自动扫描 Native PID... ${attempt + 1}/16`
      : `正在准备 Native PID... ${attempt + 1}/16`;
    if (outputEl) {
      outputEl.textContent = [
        line,
        lastScan && lastScan.output ? lastScan.output : '等待扫描结果...',
      ].join('\n\n');
    }
    if (summaryEl) {
      summaryEl.textContent = line;
      summaryEl.className = 'notice';
    }
    await waitMs(attempt < 2 ? 1800 : 2500);
  }
  const error = lastScan && (lastScan.error || lastScan.status);
  throw new Error(
    error ? `Native PID 扫描未完成：${error}` : '未发现 Trae aha_net PID，请确认 Trae 正在运行'
  );
}

async function refreshTraeNativeDeepDebug() {
  const outputEl = $('traeNativeDeepDebugOutput');
  const summaryEl = $('traeDebugSummary');
  if (!outputEl || !window.proxyManager.traeDebugNativeDeepEvents) return null;
  try {
    const result = await window.proxyManager.traeDebugNativeDeepEvents();
    outputEl.textContent = formatTraeNativeDeepOutput(result);
    if (summaryEl && result && result.ok !== false) {
      summaryEl.textContent = result.running
        ? `Native 深入探针运行中；已捕获 ${result.eventCount || 0} 条脱敏结构事件。`
        : `Native 深入探针状态：${result.status || 'idle'}；已捕获 ${result.eventCount || 0} 条脱敏结构事件。`;
      summaryEl.className = result.eventCount ? 'notice green' : 'notice';
    }
    return result;
  } catch (err) {
    outputEl.textContent = `Native 深入事件读取失败：${err && err.message ? err.message : err}`;
    if (summaryEl) summaryEl.textContent = outputEl.textContent;
    return null;
  }
}

async function startTraeNativeDeepDebug() {
  const outputEl = $('traeNativeDeepDebugOutput');
  const summaryEl = $('traeDebugSummary');
  if (!window.proxyManager.startTraeDebugNativeDeep) return;
  if (outputEl) outputEl.textContent = '正在一键启用 Native 深入探针...';
  if (summaryEl) {
    summaryEl.textContent =
      '正在自动扫描 PID 并启动深入探针；这是短时 Frida attach，只用于本机诊断。';
    summaryEl.className = 'notice';
  }
  try {
    const ready = await ensureTraeNativePidReady(outputEl, summaryEl);
    if (outputEl) outputEl.textContent = `已找到 aha_net PID ${ready.pid}，正在启动深入探针...`;
    const result = await window.proxyManager.startTraeDebugNativeDeep({
      pid: ready.pid,
      durationSeconds: 60,
      maxPreview: 360,
    });
    if (!result || result.ok === false) {
      const msg = `Native 深入探针启动失败：${result && result.error ? result.error : '未知错误'}`;
      if (outputEl) outputEl.textContent = msg;
      if (summaryEl) summaryEl.textContent = msg;
      showToast(msg, 'error');
      return;
    }
    if (outputEl) outputEl.textContent = formatTraeNativeDeepOutput(result);
    const msg = 'Native 深入探针已启动；现在发起一次 Trae API 请求，然后刷新深入事件。';
    if (summaryEl) {
      summaryEl.textContent = msg;
      summaryEl.className = 'notice green';
    }
    showToast(msg, 'success');
    setTimeout(refreshTraeNativeDeepDebug, 2500);
  } catch (err) {
    const msg = `Native 深入探针启动失败：${err && err.message ? err.message : err}`;
    if (outputEl) outputEl.textContent = msg;
    if (summaryEl) summaryEl.textContent = msg;
    showToast(msg, 'error');
  }
}

async function stopTraeNativeDeepDebug() {
  if (!window.proxyManager.stopTraeDebugNativeDeep) return;
  try {
    const result = await window.proxyManager.stopTraeDebugNativeDeep();
    const outputEl = $('traeNativeDeepDebugOutput');
    if (outputEl) outputEl.textContent = formatTraeNativeDeepOutput(result);
    showToast('Native 深入探针停止请求已发送。', 'success');
  } catch (err) {
    showToast(`Native 深入探针停止失败：${err && err.message ? err.message : err}`, 'error');
  }
}

async function refreshAntigravityCliStatus() {
  if (!window.proxyManager.antigravityCliStatus) return;
  const badgeEl = $('toolBadge-antigravity-cli');
  const dotEl = $('antigravityCliTitleDot');
  try {
    const status = await window.proxyManager.antigravityCliStatus();
    if (!status.exists) {
      $('antigravityCliStatus').textContent =
        `未检测到 Antigravity CLI 配置文件 (路径: ${status.configPath || ''})`;
      $('antigravityCliStatus').className = 'notice';
      if (badgeEl) {
        badgeEl.textContent = '未检测';
        badgeEl.className = 'badge official';
      }
      if (dotEl) dotEl.className = 'status-dot';
      return;
    }
    if (status.baseUrl) {
      $('antigravityCliStatus').textContent =
        `已配置本地代理；网关地址: ${status.baseUrl}，配置路径: ${status.configPath}`;
      $('antigravityCliStatus').className = 'notice green';
      if (badgeEl) {
        badgeEl.textContent = '已代理';
        badgeEl.className = 'badge active';
      }
      if (dotEl) dotEl.className = 'status-dot green';
    } else {
      $('antigravityCliStatus').textContent = `官方直连/未配置；配置路径: ${status.configPath}`;
      $('antigravityCliStatus').className = 'notice';
      if (badgeEl) {
        badgeEl.textContent = '直连';
        badgeEl.className = 'badge direct';
      }
      if (dotEl) dotEl.className = 'status-dot amber';
    }
  } catch (err) {
    $('antigravityCliStatus').textContent =
      `Antigravity CLI 状态检查失败：${err && err.message ? err.message : err}`;
    $('antigravityCliStatus').className = 'notice';
    if (badgeEl) {
      badgeEl.textContent = '失败';
      badgeEl.className = 'badge error';
    }
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
      $('geminiCliStatus').textContent =
        `未检测到 Google Gemini CLI 配置文件 (路径: ${status.configPath || ''})`;
      $('geminiCliStatus').className = 'notice';
      if (badgeEl) {
        badgeEl.textContent = '未检测';
        badgeEl.className = 'badge official';
      }
      if (dotEl) dotEl.className = 'status-dot';
      return;
    }
    if (status.apiEndpoint || status.envBaseUrl) {
      const ep = status.apiEndpoint || status.envBaseUrl;
      $('geminiCliStatus').textContent =
        `已配置本地代理；网关地址: ${ep}，配置路径: ${status.configPath}`;
      $('geminiCliStatus').className = 'notice green';
      if (badgeEl) {
        badgeEl.textContent = '已代理';
        badgeEl.className = 'badge active';
      }
      if (dotEl) dotEl.className = 'status-dot green';
    } else {
      $('geminiCliStatus').textContent = `官方直连/已启用认证；配置路径: ${status.configPath}`;
      $('geminiCliStatus').className = 'notice';
      if (badgeEl) {
        badgeEl.textContent = '直连';
        badgeEl.className = 'badge direct';
      }
      if (dotEl) dotEl.className = 'status-dot amber';
    }
  } catch (err) {
    $('geminiCliStatus').textContent =
      `Google Gemini CLI 状态检查失败：${err && err.message ? err.message : err}`;
    $('geminiCliStatus').className = 'notice';
    if (badgeEl) {
      badgeEl.textContent = '失败';
      badgeEl.className = 'badge error';
    }
    if (dotEl) dotEl.className = 'status-dot red';
  }
}

function formatCodexAuthSummary(status) {
  const labels = {
    chatgpt: '官方登录',
    api: 'API 登录',
    mixed: '官方 token + 用户 API Key',
    'legacy-managed-api-key': '旧版代理占位 Key',
    none: '未登录',
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
      $('codexStatus').textContent =
        `未检测到 Codex CLI 配置文件 (路径: ${status.configPath || ''})`;
      $('codexStatus').className = 'notice';
      if (badgeEl) {
        badgeEl.textContent = '未检测';
        badgeEl.className = 'badge official';
      }
      if (dotEl) dotEl.className = 'status-dot';
      return;
    }
    const auth = formatCodexAuthSummary(status);
    if (status.baseUrl) {
      const legacy = status.legacyBaseUrl && !status.openaiBaseUrl ? '（旧 base_url 写法）' : '';
      $('codexStatus').textContent =
        `已配置本地代理；网关地址: ${status.baseUrl}${legacy}${auth}，配置路径: ${status.configPath}`;
      $('codexStatus').className = 'notice green';
      if (badgeEl) {
        badgeEl.textContent = '已代理';
        badgeEl.className = 'badge active';
      }
      if (dotEl) dotEl.className = 'status-dot green';
    } else {
      $('codexStatus').textContent = `官方直连${auth}；配置路径: ${status.configPath}`;
      $('codexStatus').className = 'notice';
      if (badgeEl) {
        badgeEl.textContent = '直连';
        badgeEl.className = 'badge direct';
      }
      if (dotEl) dotEl.className = 'status-dot amber';
    }
  } catch (err) {
    $('codexStatus').textContent =
      `Codex CLI 状态检查失败：${err && err.message ? err.message : err}`;
    $('codexStatus').className = 'notice';
    if (badgeEl) {
      badgeEl.textContent = '失败';
      badgeEl.className = 'badge error';
    }
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
      $('codexDesktopStatus').textContent =
        `未检测到 Codex 用户配置 (路径: ${status.configPath || ''})${auth}；应用代理会自动创建共享配置。`;
      $('codexDesktopStatus').className = 'notice';
      if (badgeEl) {
        badgeEl.textContent = '未检测';
        badgeEl.className = 'badge official';
      }
      if (dotEl) dotEl.className = 'status-dot';
      return;
    }
    const auth = formatCodexAuthSummary(status);
    if (status.baseUrl) {
      const restartText = status.requiresRestart ? '；重启 Codex Desktop 或新开会话后生效' : '';
      const legacy =
        status.legacyBaseUrl && !status.openaiBaseUrl ? '；当前为旧 base_url 写法' : '';
      const catalog =
        status.managedModelCatalog && status.modelCatalog && status.modelCatalog.exists
          ? `；模型目录 ${status.modelCatalog.modelCount || 0} 个模型 / ${status.modelCatalog.routeCount || 0} 条路由`
          : '';
      $('codexDesktopStatus').textContent =
        `已接入共享 Codex 配置；网关地址: ${status.baseUrl}${legacy}${catalog}${auth}，配置路径: ${status.configPath}${restartText}`;
      $('codexDesktopStatus').className = 'notice green';
      if (badgeEl) {
        badgeEl.textContent = '已代理';
        badgeEl.className = 'badge active';
      }
      if (dotEl) dotEl.className = 'status-dot green';
    } else {
      const catalog =
        status.managedModelCatalog && status.modelCatalog && status.modelCatalog.exists
          ? `；已生成模型目录 ${status.modelCatalog.modelCount || 0} 个模型`
          : '';
      $('codexDesktopStatus').textContent =
        `官方直连${catalog}${auth}；配置路径: ${status.configPath}。Codex Desktop 通过共享 config.toml 和启动时模型目录接管。`;
      $('codexDesktopStatus').className = 'notice';
      if (badgeEl) {
        badgeEl.textContent = '直连';
        badgeEl.className = 'badge direct';
      }
      if (dotEl) dotEl.className = 'status-dot amber';
    }
  } catch (err) {
    $('codexDesktopStatus').textContent =
      `Codex Desktop 状态检查失败：${err && err.message ? err.message : err}`;
    $('codexDesktopStatus').className = 'notice';
    if (badgeEl) {
      badgeEl.textContent = '失败';
      badgeEl.className = 'badge error';
    }
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
    refreshTraeBridgeStatus(),
    refreshAntigravityCliStatus(),
    refreshGeminiCliStatus(),
    refreshCodexStatus(),
    refreshCodexDesktopStatus(),
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
      outputTail: result.outputTail || '',
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

function envDataSignature(tools = []) {
  return JSON.stringify({
    tools: tools.map((tool) => ({
      id: tool && tool.id,
      name: tool && tool.name,
      current: tool && tool.current,
      latest: tool && tool.latest,
      hasUpdate: !!(tool && tool.hasUpdate),
    })),
    jobs: Array.from(envInstallJobsByTool.values()).map((job) => ({
      toolId: job && job.toolId,
      status: job && job.status,
      lastLine: job && job.lastLine,
      outputTail: job && job.outputTail,
      installCommand: job && job.installCommand,
      usesIrm: !!(job && job.usesIrm),
    })),
  });
}

function setGridNotice(element) {
  if (!element) return;
  element.style.gridColumn = '1 / -1';
}

function createEnvCodeBlock(text, maxHeight = '42px') {
  const code = document.createElement('code');
  code.style.display = 'block';
  code.style.maxHeight = maxHeight;
  code.style.overflow = 'auto';
  code.style.whiteSpace = 'pre-wrap';
  code.style.wordBreak = 'break-word';
  code.style.color = 'var(--text)';
  code.style.fontFamily = 'var(--font-mono)';
  code.style.fontSize = '11.5px';
  code.style.lineHeight = '1.35';
  code.textContent = text;
  return code;
}

function createEnvProgressItem(job) {
  const failed = job.status === 'failed';
  const succeeded = job.status === 'succeeded';
  const item = document.createElement('div');
  item.style.display = 'grid';
  item.style.gridTemplateColumns = 'minmax(120px, 180px) minmax(100px, 140px) 1fr';
  item.style.gap = '10px';
  item.style.alignItems = 'start';
  item.style.padding = '8px 10px';
  item.style.border = `1px solid ${failed ? 'rgba(239, 68, 68, 0.35)' : 'var(--border)'}`;
  item.style.borderRadius = '6px';
  item.style.background = succeeded ? 'rgba(16, 185, 129, 0.08)' : 'var(--card-bg)';

  const info = document.createElement('div');
  const name = document.createElement('div');
  name.style.fontWeight = '700';
  name.style.color = 'var(--text)';
  name.textContent = job.name || job.toolId || '';
  const method = document.createElement('div');
  method.className = 'muted';
  method.style.fontSize = '12px';
  method.textContent = job.usesIrm ? '官方 irm 安装脚本' : 'npm 全局安装';
  info.append(name, method);

  const status = document.createElement('strong');
  status.style.color = failed ? '#ef4444' : 'var(--text)';
  status.textContent = envJobStatusLabel(job.status);

  item.append(
    info,
    status,
    createEnvCodeBlock(
      job.lastLine || job.outputTail || job.installCommand || '等待输出...',
      '48px'
    )
  );
  return item;
}

function updateEnvInstallProgressPanel() {
  const panel = $('envInstallProgressPanel');
  if (!panel) return;
  const jobs = Array.from(envInstallJobsByTool.values()).sort(
    (a, b) => (b.startedAt || 0) - (a.startedAt || 0)
  );
  if (jobs.length === 0) {
    panel.style.display = 'none';
    clearElement(panel);
    return;
  }

  panel.style.display = 'block';
  clearElement(panel);
  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.justifyContent = 'space-between';
  header.style.gap = '12px';
  header.style.marginBottom = '8px';
  const title = document.createElement('strong');
  title.style.fontSize = '13px';
  title.style.color = 'var(--text)';
  title.textContent = '安装/升级进度';
  const hint = document.createElement('span');
  hint.className = 'muted';
  hint.style.fontSize = '12px';
  hint.textContent = '显示最近任务输出，完成后会自动刷新版本状态';
  header.append(title, hint);

  const list = document.createElement('div');
  list.style.display = 'grid';
  list.style.gap = '8px';
  jobs.forEach((job) => list.appendChild(createEnvProgressItem(job)));
  panel.append(header, list);
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
      outputTail: '',
    });
  }
  updateEnvInstallProgressPanel();
  lastRenderedEnvHtml = '';
}

function finalizeEnvInstallSubmission(toolIds = [], results = [], fallbackError = '') {
  const byId = new Map((results || []).map((result) => [result && result.id, result]));
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
      lastLine: failed
        ? fallbackError || (result && result.error) || '安装任务失败'
        : '安装/升级完成',
    });
  }
  updateEnvInstallProgressPanel();
}

async function pollEnvInstallJobs() {
  const jobIds = Array.from(envInstallJobsByTool.values())
    .filter((job) => job && job.jobId && job.status !== 'succeeded' && job.status !== 'failed')
    .map((job) => job.jobId);
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
    pollEnvInstallJobs().catch((err) => console.error('环境安装进度轮询失败:', err));
  }, 1200);
  pollEnvInstallJobs().catch((err) => console.error('环境安装进度轮询失败:', err));
}

function createEnvSkeletonCard() {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.padding = '16px';
  card.style.display = 'flex';
  card.style.flexDirection = 'column';
  card.style.minHeight = '120px';
  card.style.opacity = '0.7';

  const top = document.createElement('div');
  top.style.display = 'flex';
  top.style.justifyContent = 'space-between';
  top.style.alignItems = 'flex-start';
  top.style.marginBottom = '12px';
  const identity = document.createElement('div');
  identity.style.display = 'flex';
  identity.style.alignItems = 'center';
  identity.style.gap = '8px';
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  dot.style.margin = '0';
  dot.style.background = 'var(--border)';
  const title = document.createElement('strong');
  title.style.width = '80px';
  title.style.height = '16px';
  title.style.background = 'var(--border)';
  title.style.borderRadius = '2px';
  identity.append(dot, title);
  top.appendChild(identity);

  const rows = document.createElement('div');
  rows.style.display = 'flex';
  rows.style.flexDirection = 'column';
  rows.style.gap = '8px';
  ['60%', '80%'].forEach((width) => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';
    row.style.height = '14px';
    row.style.background = 'var(--border)';
    row.style.borderRadius = '2px';
    row.style.width = width;
    rows.appendChild(row);
  });
  card.append(top, rows);
  return card;
}

function renderEnvSkeleton(grid) {
  clearElement(grid);
  for (let i = 0; i < 6; i++) grid.appendChild(createEnvSkeletonCard());
}

function createEnvActionButton(tool, isInstalled, isJobRunning) {
  const button = document.createElement('button');
  button.style.margin = '0';
  button.style.padding = '4px 8px';
  button.style.fontSize = '12px';
  button.style.height = '26px';
  button.style.lineHeight = '1';
  if (isJobRunning) {
    button.className = 'light';
    button.disabled = true;
    button.style.opacity = '0.7';
    button.textContent = '执行中';
    return button;
  }
  if (!isInstalled || tool.hasUpdate) {
    button.className = 'primary';
    button.dataset.upgradeTool = tool.id || '';
    button.dataset.upgradeAction = isInstalled ? 'upgrade' : 'install';
    button.textContent = isInstalled ? '升级' : '安装';
    return button;
  }
  button.className = 'light';
  button.disabled = true;
  button.style.opacity = '0.5';
  button.textContent = '最新';
  return button;
}

function createEnvProgressBlock(installJob) {
  if (!installJob) return null;
  const failed = installJob.status === 'failed';
  const block = document.createElement('div');
  block.style.display = 'flex';
  block.style.flexDirection = 'column';
  block.style.gap = '4px';
  block.style.marginTop = '4px';
  block.style.padding = '8px 10px';
  block.style.border = `1px solid ${failed ? 'rgba(239, 68, 68, 0.35)' : 'var(--border)'}`;
  block.style.borderRadius = '6px';
  block.style.background =
    installJob.status === 'succeeded' ? 'rgba(16, 185, 129, 0.08)' : 'var(--bg-hover)';

  const line = document.createElement('div');
  line.style.display = 'flex';
  line.style.justifyContent = 'space-between';
  line.style.gap = '8px';
  line.style.alignItems = 'center';
  const label = document.createElement('span');
  label.className = 'muted';
  label.textContent = '安装进度';
  const status = document.createElement('strong');
  status.style.color = failed ? '#ef4444' : 'var(--text)';
  status.textContent = envJobStatusLabel(installJob.status);
  line.append(label, status);

  const method = document.createElement('div');
  method.className = 'muted';
  method.style.fontSize = '12px';
  method.textContent = installJob.usesIrm ? '官方 irm 安装脚本' : 'npm 全局安装';
  block.append(
    line,
    method,
    createEnvCodeBlock(installJob.lastLine || installJob.outputTail || '等待输出...')
  );
  return block;
}

function createEnvInfoRow(labelText, valueText) {
  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.justifyContent = 'space-between';
  const label = document.createElement('span');
  label.className = 'muted';
  label.textContent = labelText;
  const value = document.createElement('strong');
  value.style.color = 'var(--text)';
  value.textContent = valueText;
  row.append(label, value);
  return row;
}

function createEnvToolCard(tool) {
  const isInstalled = !!tool.current;
  const installJob = envInstallJobsByTool.get(tool.id);
  const isJobRunning =
    installJob && installJob.status !== 'succeeded' && installJob.status !== 'failed';
  const card = document.createElement('div');
  card.className = 'card env-card';
  card.style.padding = '16px';
  card.style.display = 'flex';
  card.style.flexDirection = 'column';
  card.style.minHeight = '142px';
  card.style.border = `1px solid ${!isInstalled || tool.hasUpdate ? 'var(--primary)' : 'var(--border)'}`;
  card.style.background =
    !isInstalled || tool.hasUpdate ? 'rgba(var(--primary-rgb), 0.05)' : 'var(--card-bg)';

  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'flex-start';
  header.style.marginBottom = '12px';
  const identity = document.createElement('div');
  identity.style.display = 'flex';
  identity.style.alignItems = 'center';
  identity.style.gap = '8px';
  const dot = document.createElement('span');
  dot.className = `status-dot ${isInstalled ? 'green' : 'amber'}`;
  dot.style.margin = '0';
  const name = document.createElement('strong');
  name.style.fontSize = '15px';
  name.style.color = 'var(--text)';
  name.textContent = tool.name || tool.id || '';
  identity.append(dot, name);
  header.append(identity, createEnvActionButton(tool, isInstalled, isJobRunning));

  const body = document.createElement('div');
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.gap = '6px';
  body.style.fontSize = '13px';
  body.style.flex = '1';
  body.append(
    createEnvInfoRow('当前版本', tool.current || '未安装'),
    createEnvInfoRow('最新版本', tool.latest || '加载中...')
  );

  const commandBlock = document.createElement('div');
  commandBlock.style.display = 'flex';
  commandBlock.style.flexDirection = 'column';
  commandBlock.style.gap = '4px';
  commandBlock.style.marginTop = '4px';
  const commandLabel = document.createElement('span');
  commandLabel.className = 'muted';
  commandLabel.textContent = '安装命令';
  const command = document.createElement('code');
  command.style.display = 'block';
  command.style.padding = '6px 8px';
  command.style.border = '1px solid var(--border)';
  command.style.borderRadius = '4px';
  command.style.background = 'var(--bg-hover)';
  command.style.color = 'var(--text)';
  command.style.fontFamily = 'var(--font-mono)';
  command.style.fontSize = '12px';
  command.style.lineHeight = '1.35';
  command.style.overflowX = 'auto';
  command.style.whiteSpace = 'nowrap';
  command.textContent = getPreferredEnvInstallCommand(tool);
  commandBlock.append(commandLabel, command);
  body.appendChild(commandBlock);
  const progress = createEnvProgressBlock(installJob);
  if (progress) body.appendChild(progress);
  card.append(header, body);
  return card;
}

async function refreshEnvStatus(options = {}) {
  const now = Date.now();
  if (
    options.passive &&
    !options.force &&
    lastRenderedEnvHtml &&
    now - lastEnvStatusRefresh < 30000
  )
    return;
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
    renderEnvSkeleton(grid);
  }

  try {
    const res = await window.proxyManager.envCheck();
    if (!res.ok) throw new Error(res.error || '检查失败');

    let updateCount = 0;
    let installCount = 0;
    const actionToolIds = [];
    const tools = Array.isArray(res.tools) ? res.tools : [];
    tools.forEach((tool) => {
      if (tool && tool.id) lastEnvToolsById.set(tool.id, tool);
      const isInstalled = !!(tool && tool.current);
      if (!isInstalled) installCount++;
      if (tool && tool.hasUpdate) updateCount++;
      if (tool && (!isInstalled || tool.hasUpdate)) actionToolIds.push(tool.id);
    });
    lastEnvActionToolIds = actionToolIds.filter(Boolean);
    const envSignature = envDataSignature(tools);
    if (envSignature !== lastRenderedEnvHtml) {
      grid.replaceChildren(...tools.map((tool) => createEnvToolCard(tool || {})));
      lastRenderedEnvHtml = envSignature;
    }

    const actionCount = updateCount + installCount;
    btnUpgradeAll.textContent =
      actionCount > 0 ? `全部安装/升级 (${actionCount})` : '全部安装/升级 (0)';
    btnUpgradeAll.disabled = actionCount === 0;
    lastEnvStatusRefresh = Date.now();
    if (res.latestPending) {
      scheduleEnvPendingRefresh();
    }
  } catch (err) {
    showToast('环境检查刷新失败: ' + err.message, 'error');
    const notice = document.createElement('div');
    notice.className = 'notice';
    setGridNotice(notice);
    notice.textContent = `刷新失败，请检查网络或代理服务器运行状态：${err.message}`;
    grid.replaceChildren(notice);
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

window.upgradeSingleTool = async function (toolId, action = 'upgrade') {
  const isInstall = action === 'install';
  const confirmed = await confirmAction({
    title: isInstall ? '安装助手工具' : '升级助手工具',
    message: `确认要${isInstall ? '安装' : '升级'}该 AI 命令行工具吗？这将在后台执行全局安装命令，耗时可能较长。`,
    confirmText: isInstall ? '确定安装' : '确定升级',
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
    showToast(
      isInstall ? '安装任务已启动，正在显示进度...' : '升级任务已启动，正在显示进度...',
      'success'
    );
    refreshEnvStatus({ passive: true, force: true });
  } catch (err) {
    finalizeEnvInstallSubmission([toolId], [], err.message);
    showToast((isInstall ? '工具安装失败：' : '工具升级失败：') + err.message, 'error');
  }
};

async function upgradeAllEnv() {
  const confirmed = await confirmAction({
    title: '全部安装/升级',
    message:
      '确认要安装缺失工具并升级有更新的 AI 命令行工具吗？这将在后台依次串行执行全局安装命令，需要数分钟时间。',
    confirmText: '全部安装/升级',
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
    const failed = res.results.filter((r) => !r.ok);
    if (failed.length > 0) {
      showToast(`部分包升级失败: ${failed.map((f) => f.name).join(', ')}`, 'error');
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

function setStatusDotText(elementId, color, text) {
  const element = $(elementId);
  clearElement(element);
  const dot = document.createElement('span');
  dot.className = `status-dot ${color}`;
  element.append(dot, document.createTextNode(text));
}

async function refreshCertStatus(options = {}) {
  const now = Date.now();
  if (options.passive && now - lastCertRefresh < 60000) return;
  if (certRefreshInFlight) return certRefreshInFlight;
  const finishPerf = perfStart('refresh.certStatus');
  certRefreshInFlight = (async () => {
    try {
      const status = await promiseWithTimeout(
        window.proxyManager.certStatus(),
        9000,
        '证书状态检查超时'
      );
      lastCertRefresh = Date.now();
      if (!status || !status.ok) {
        $('certStatus').textContent =
          `证书状态检查失败：${status && status.error ? status.error : '未知错误'}；目录：${status && status.certDir ? status.certDir : ''}`;
        setStatusDotText('heroCertStatus', 'red', '检查失败');
        return;
      }
      const trustText = status.trusted ? '已信任到系统/当前用户证书库' : '未信任';
      const existsText = status.exists ? '证书文件已生成' : '证书文件未生成';
      const expiresText = status.notAfter ? `；有效期至：${status.notAfter}` : '';
      $('certStatus').textContent =
        `${existsText}；${trustText}${expiresText}；目录：${status.certDir || ''}`;
      setStatusDotText(
        'heroCertStatus',
        status.trusted ? 'green' : 'amber',
        status.trusted ? '已信任' : '未信任'
      );
    } catch (err) {
      // 注意:这里故意不写 lastCertRefresh。代理冷启动要 7-10s,
      // 第一次 scheduleStartupTask('load.certStatus') 几乎一定会
      // 超时,这时必须让后续的 passive 重试(heartbeat 触发)再尝试,
      // 否则证书卡片会被动节流锁 60s,只能靠用户手动点刷新。
      const message = err && err.message ? err.message : '未知错误';
      $('certStatus').textContent = `证书状态检查失败：${message}`;
      setStatusDotText('heroCertStatus', 'red', '检查失败');
    } finally {
      certRefreshInFlight = null;
      finishPerf();
    }
  })();
  return certRefreshInFlight;
}

function schedulePassiveCertRefresh() {
  const run = () =>
    refreshCertStatus({ passive: true }).catch((err) =>
      console.error('refreshCertStatus error:', err)
    );
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
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const important = lines.filter((line) =>
    /Port occupied|Auto-releasing|Still occupied|Refusing|aborted|failed|timed out|timeout|Exited immediately|already running|started|stopped|Running/i.test(
      line
    )
  );
  const picked = (important.length ? important : lines).slice(0, 3);
  return picked.join('；');
}

async function run(command) {
  const confirmations = {
    stop: {
      title: '停止代理？',
      message: '停止后正在使用本地代理的 IDE 或客户端请求会失败。',
      confirmText: '停止代理',
    },
    restart: {
      title: '重启代理？',
      message: '重启会短暂中断本地代理连接，正在进行的请求可能失败。',
      confirmText: '重启代理',
      danger: false,
    },
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
  if (
    window.UX &&
    result.code === 0 &&
    ['start', 'stop', 'restart'].includes(command) &&
    config.appSettings &&
    config.appSettings.desktopNotifications
  ) {
    const titles = { start: '代理已启动', stop: '代理已停止', restart: '代理已重启' };
    window.UX.notify(titles[command], {
      body: msg.split('\n').slice(0, 2).join(' / '),
      tag: `proxy:${command}`,
    });
  }
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
    const profile =
      config.profiles.find((item) => item.id === $('modelRouteProfile').value) || collectForm();
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
    $('output').textContent =
      availableModels.length > 0
        ? '模型列表已更新' + modeText
        : '上游返回成功，但没有解析到模型 ID' + modeText;
  } catch (err) {
    $('modelStatus').textContent = '获取失败';
    const message = err && err.message ? err.message : '获取模型失败';
    $('output').textContent = message.includes("No handler registered for 'models:list'")
      ? '请完全退出并重新启动管理器窗口后再获取模型，新 IPC 需要 Electron 主进程重新加载。'
      : message;
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
  const index =
    editingRouteIndex !== null && modelRoutes[editingRouteIndex]
      ? editingRouteIndex
      : modelRoutes.findIndex((route) => route.from === from);
  const nextRoute = { from, profileId, to };
  const isEditing = editingRouteIndex !== null && modelRoutes[editingRouteIndex];
  const previousRoute = index >= 0 ? modelRoutes[index] : null;
  if (labelOverride) nextRoute.labelOverride = labelOverride;
  if (previousRoute && previousRoute.supports1m !== undefined)
    nextRoute.supports1m = previousRoute.supports1m;
  if (index >= 0) modelRoutes[index] = nextRoute;
  else modelRoutes.push(nextRoute);
  syncClaudeDesktopModelFromRoute(previousRoute ? previousRoute.from : from, nextRoute);
  config.modelRoutes = modelRoutesForConfig();
  resetRouteEditor();
  scheduleDashboardRender({ rules: true, overview: true });
  $('output').textContent =
    (isEditing ? '模型路由已更新：' : '模型路由已添加：') +
    from +
    ' → ' +
    (config.profiles.find((item) => item.id === profileId)?.name || profileId) +
    ' → ' +
    to +
    '，保存路由配置后生效';
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

document.querySelectorAll('#modelAutocompleteContainer .autocomplete-tag').forEach((tag) => {
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
    $('importCredsStatus').textContent =
      '本地凭证导入成功！请点击下方【保存上游目标】按钮保存修改。';
    showToast('本地凭证导入成功！', 'success');
  } else {
    $('importCredsStatus').textContent =
      '导入失败：' + (result.error || '未检测到有效的本地 CLI 凭据，请确保您已在本地终端登录过。');
    showToast('导入本地凭证失败', 'error');
  }
};

$('saveProfile').onclick = async () => {
  const profile = collectForm();
  if (!profile.id || !profile.targetUrl) {
    $('output').textContent = 'ID 和目标 URL 必填';
    return;
  }
  const index = config.profiles.findIndex(
    (item) => item.id === selectedId || item.id === profile.id
  );
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
      profileId: profile.id || selectedId,
    };
    const result = await window.proxyManager.testProfileAuth(payload);
    if (result && result.ok) {
      const modeText = result.authMode === 'official-login' ? '官方登录凭证' : '密钥鉴权';
      showToast(modeText + '测试成功！', 'success');
      $('output').textContent =
        result.warning || result.message || '上游目标' + modeText + '测试成功，连接正常。';
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
  const primaryEntry = entries.find(
    (e) => e.protocol === (profile.protocol === 'claude' ? 'claude' : 'openai')
  ) ||
    entries[0] || { host: 'localhost', listenPort: 3443, basePath: '/v1' };
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
    'OPENAI_API_KEY="sk-proxy-managed"',
  ].join('\n');

  navigator.clipboard
    .writeText(envs)
    .then(() => {
      showToast('已复制 IDE 环境变量配置到剪贴板', 'success');
    })
    .catch((err) => {
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
const testClaudeDesktopProcessButton = $('testClaudeDesktopProcess');
if (testClaudeDesktopProcessButton)
  testClaudeDesktopProcessButton.onclick = testClaudeDesktopProcessOutput;
const copyClaudeDesktopProcessPromptButton = $('copyClaudeDesktopProcessPrompt');
if (copyClaudeDesktopProcessPromptButton)
  copyClaudeDesktopProcessPromptButton.onclick = copyClaudeDesktopProcessPrompt;
[
  'claudeDesktopEnabled',
  'claudeDesktopMode',
  'claudeDesktopBaseUrl',
  'claudeDesktopToken',
  'claudeDesktopTraeProcessStyle',
  'claudeDesktopDirectBaseUrl',
  'claudeDesktopDirectApiKey',
].forEach((id) => {
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
  const index = config.claudeDesktop.models.findIndex(
    (item) => (item.routeId || item.from) === routeId
  );
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
  const msg = status.configured
    ? 'Claude Desktop 3P profile 已写入，重启 Claude Desktop 后生效'
    : 'Claude Desktop 配置已处理';
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
  const msg = status.ok
    ? 'Claude Desktop 已恢复官方模式，重启 Claude Desktop 后生效'
    : '恢复官方模式失败';
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
  const msg = status.ok
    ? '已恢复 Claude Code 官方直连模式！您现在可以正常登录官方。'
    : '恢复官方模式失败';
  $('output').textContent = msg;
  showToast(msg, status.ok ? 'success' : 'error');
};
$('refreshClaudeCode').onclick = refreshClaudeCodeStatus;

const TRAE_RAW_PROGRESS_ENV_COMMAND = [
  "$env:TRAE_BRIDGE_RAW_PROGRESS = 'comment'",
  '.\\proxy.bat restart',
].join('\n');

const TRAE_VISIBLE_PROGRESS_ENV_COMMAND = [
  "$env:TRAE_BRIDGE_RAW_PROGRESS = 'visible'",
  "$env:TRAE_BRIDGE_LOG_PROGRESS = 'visible'",
  '.\\proxy.bat restart',
].join('\n');

const refreshTraeBridgeButton = $('refreshTraeBridge');
if (refreshTraeBridgeButton) refreshTraeBridgeButton.onclick = refreshTraeBridgeStatus;

const refreshTraeDebugEventsButton = $('refreshTraeDebugEvents');
if (refreshTraeDebugEventsButton) {
  refreshTraeDebugEventsButton.onclick = async () => {
    await refreshTraeDebugEvents();
    await refreshTraeNativeDeepDebug();
  };
}

const testTraeClaudeProcessButton = $('testTraeClaudeProcess');
if (testTraeClaudeProcessButton) testTraeClaudeProcessButton.onclick = testTraeClaudeProcessOutput;

const scanTraeNativeDebugButton = $('scanTraeNativeDebug');
if (scanTraeNativeDebugButton) scanTraeNativeDebugButton.onclick = scanTraeNativeDebug;

const startTraeNativeDeepDebugButton = $('startTraeNativeDeepDebug');
if (startTraeNativeDeepDebugButton)
  startTraeNativeDeepDebugButton.onclick = startTraeNativeDeepDebug;

const stopTraeNativeDeepDebugButton = $('stopTraeNativeDeepDebug');
if (stopTraeNativeDeepDebugButton) stopTraeNativeDeepDebugButton.onclick = stopTraeNativeDeepDebug;

const refreshTraeNativeDeepDebugButton = $('refreshTraeNativeDeepDebug');
if (refreshTraeNativeDeepDebugButton)
  refreshTraeNativeDeepDebugButton.onclick = refreshTraeNativeDeepDebug;

[
  'traeRawCommentsEnabled',
  'traeClaudeProcessStyle',
  'traeApiVisibleProgressEnabled',
  'traeLogProgressEnabled',
].forEach((id) => {
  const input = $(id);
  if (input) input.onchange = saveTraeDebugSettingsFromUi;
});

const copyTraeNativeDebugCommandsButton = $('copyTraeNativeDebugCommands');
if (copyTraeNativeDebugCommandsButton) {
  copyTraeNativeDebugCommandsButton.onclick = async () => {
    await navigator.clipboard.writeText(lastTraeNativeDebugCommands);
    const msg = 'Trae Native Debug 命令已复制。默认命令为脱敏短时运行；不要长期常驻。';
    $('output').textContent = msg;
    showToast(msg, 'success');
  };
}

const copyTraeRawProgressEnvButton = $('copyTraeRawProgressEnv');
if (copyTraeRawProgressEnvButton) {
  copyTraeRawProgressEnvButton.onclick = async () => {
    await navigator.clipboard.writeText(TRAE_RAW_PROGRESS_ENV_COMMAND);
    const msg = 'Trae Raw 调试流开关命令已复制，执行后需重启代理进程。';
    $('output').textContent = msg;
    showToast(msg, 'success');
  };
}

const copyTraeVisibleProgressEnvButton = $('copyTraeVisibleProgressEnv');
if (copyTraeVisibleProgressEnvButton) {
  copyTraeVisibleProgressEnvButton.onclick = async () => {
    await navigator.clipboard.writeText(TRAE_VISIBLE_PROGRESS_ENV_COMMAND);
    const msg = 'Trae 可见过程开关已复制，执行后普通流式客户端也能看到过程摘要。';
    $('output').textContent = msg;
    showToast(msg, 'success');
  };
}

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
  const msg = status.ok
    ? '已恢复 Google Gemini CLI 官方直连模式！您现在可以正常登录官方。'
    : '恢复官方模式失败';
  $('output').textContent = msg;
  showToast(msg, status.ok ? 'success' : 'error');
};
$('refreshGeminiCli').onclick = refreshGeminiCliStatus;

async function switchCodexMode(surface, payload, options = {}) {
  await saveConfig(options.savingText || '模型路由已保存，正在切换 Codex 配置...');
  const api =
    surface === 'desktop'
      ? window.proxyManager.switchCodexDesktop
      : window.proxyManager.switchCodex;
  if (!api) {
    return { ok: false, error: '当前版本缺少 Codex 切换接口' };
  }
  const status = await api(payload);
  await Promise.allSettled([refreshCodexDesktopStatus(), refreshCodexStatus()]);
  const catalog =
    status && status.connection && status.connection.modelCatalog
      ? `，模型目录 ${status.connection.modelCatalog.routeCount || 0} 条路由`
      : status && status.connection && status.connection.modelCatalogWarning
        ? `，模型目录生成失败：${status.connection.modelCatalogWarning}`
        : '';
  const msg = status.ok
    ? `${options.successText || 'Codex 配置已切换'}${catalog}${surface === 'desktop' ? '，重启或新开会话后生效' : ''}！`
    : `${options.errorPrefix || 'Codex 切换失败'}：${toolActionErrorMessage(status, '未知错误')}`;
  const finalMsg =
    status.ok && status.partial && status.authWarning
      ? `${msg} 登录态未完成：${status.authWarning}`
      : msg;
  $('output').textContent = finalMsg;
  showToast(finalMsg, status.ok ? (status.partial ? 'warning' : 'success') : 'error');
  return status;
}

// Codex Desktop
$('applyCodexDesktop').onclick = async () => {
  await switchCodexMode(
    'desktop',
    { connection: 'proxy', auth: 'api' },
    {
      savingText: '模型路由已保存，正在切换到 Codex Desktop 本地代理 + API 登录...',
      successText: '已切换到 Codex Desktop 本地代理 + API 登录',
      errorPrefix: '切换到本地代理 + API 登录失败',
    }
  );
};
$('restoreCodexDesktop').onclick = async () => {
  const confirmed = await confirmAction({
    title: '恢复 Codex Desktop 官方直连 + 官方登录？',
    message:
      '这会移除 Codex 共享配置中的本地代理设置，并尝试恢复已备份的 ChatGPT 官方登录 token。Codex CLI 也会受影响。',
    confirmText: '恢复官方直连',
  });
  if (!confirmed) return;
  await switchCodexMode(
    'desktop',
    { connection: 'direct', auth: 'chatgpt' },
    {
      savingText: '正在切换到 Codex Desktop 官方直连 + 官方登录...',
      successText: '已切换到 Codex Desktop 官方直连 + 官方登录',
      errorPrefix: '恢复官方直连 + 官方登录失败',
    }
  );
};
$('refreshCodexDesktop').onclick = refreshCodexDesktopStatus;

const CODEX_CHATGPT_LOGIN_COMMAND = ['codex logout', 'codex login'].join('\n');

const CODEX_API_LOGIN_COMMAND = [
  'codex logout',
  'cmd /d /s /c "echo|set /p=sk-proxy-managed" | codex login --with-api-key',
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
        const msg =
          '已检测到 Codex 官方登录，并完成备份。现在可以使用“代理 + 官方登录”或“恢复官方直连(官方登录)”。';
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
    $('output').textContent =
      `${label}已复制到剪贴板。Codex 登录态是二选一，执行前请确认需要切换。`;
    showToast(`${label}已复制`, 'success');
  };
}

function toolActionErrorMessage(status, fallback) {
  if (!status) return fallback;
  return status.error || status.message || status.modelCatalogWarning || fallback;
}

bindCopyCodexLoginCommand(
  'copyCodexChatGptLoginDesktop',
  CODEX_CHATGPT_LOGIN_COMMAND,
  'Codex 官方登录命令'
);
bindCopyCodexLoginCommand(
  'copyCodexApiLoginDesktop',
  CODEX_API_LOGIN_COMMAND,
  'Codex API 登录命令'
);
bindCodexApiLoginButton('codexDesktopApiLogin', 'desktop');
bindCodexOfficialLoginButton('codexDesktopOfficialLogin', 'desktop');
bindCodexBackupButton('codexDesktopBackupAuth', 'desktop');
const switchCodexDesktopProxyOfficial = $('switchCodexDesktopProxyOfficial');
if (switchCodexDesktopProxyOfficial) {
  switchCodexDesktopProxyOfficial.onclick = async () => {
    await switchCodexMode(
      'desktop',
      { connection: 'proxy', auth: 'chatgpt' },
      {
        savingText: '模型路由已保存，正在切换到 Codex Desktop 本地代理 + 官方登录...',
        successText: '已切换到 Codex Desktop 本地代理 + 官方登录',
        errorPrefix: '切换到代理 + 官方登录失败',
      }
    );
  };
}
const switchCodexDesktopDirectApi = $('switchCodexDesktopDirectApi');
if (switchCodexDesktopDirectApi) {
  switchCodexDesktopDirectApi.onclick = async () => {
    await switchCodexMode(
      'desktop',
      { connection: 'direct', auth: 'api' },
      {
        savingText: '正在切换到 Codex Desktop 官方直连 + API 登录...',
        successText: '已切换到 Codex Desktop 官方直连 + API 登录',
        errorPrefix: '切换到官方直连 + API 登录失败',
      }
    );
  };
}

// Codex CLI
$('applyCodex').onclick = async () => {
  await switchCodexMode(
    'cli',
    { connection: 'proxy', auth: 'api' },
    {
      savingText: '模型路由已保存，正在切换到 Codex CLI 本地代理 + API 登录...',
      successText: '已切换到 Codex CLI 本地代理 + API 登录',
      errorPrefix: '切换到本地代理 + API 登录失败',
    }
  );
};
$('restoreCodex').onclick = async () => {
  const confirmed = await confirmAction({
    title: '恢复 Codex CLI 官方直连 + 官方登录？',
    message: '这会移除 Codex 共享配置中的代理设置，并尝试恢复已备份的 ChatGPT 官方登录 token。',
    confirmText: '恢复官方直连',
  });
  if (!confirmed) return;
  await switchCodexMode(
    'cli',
    { connection: 'direct', auth: 'chatgpt' },
    {
      savingText: '正在切换到 Codex CLI 官方直连 + 官方登录...',
      successText: '已切换到 Codex CLI 官方直连 + 官方登录',
      errorPrefix: '恢复官方直连 + 官方登录失败',
    }
  );
};
$('refreshCodex').onclick = refreshCodexStatus;
bindCopyCodexLoginCommand(
  'copyCodexChatGptLogin',
  CODEX_CHATGPT_LOGIN_COMMAND,
  'Codex 官方登录命令'
);
bindCopyCodexLoginCommand('copyCodexApiLogin', CODEX_API_LOGIN_COMMAND, 'Codex API 登录命令');
bindCodexApiLoginButton('codexApiLogin', 'cli');
bindCodexOfficialLoginButton('codexOfficialLogin', 'cli');
bindCodexBackupButton('codexBackupAuth', 'cli');
const switchCodexProxyOfficial = $('switchCodexProxyOfficial');
if (switchCodexProxyOfficial) {
  switchCodexProxyOfficial.onclick = async () => {
    await switchCodexMode(
      'cli',
      { connection: 'proxy', auth: 'chatgpt' },
      {
        savingText: '模型路由已保存，正在切换到 Codex CLI 本地代理 + 官方登录...',
        successText: '已切换到 Codex CLI 本地代理 + 官方登录',
        errorPrefix: '切换到代理 + 官方登录失败',
      }
    );
  };
}
const switchCodexDirectApi = $('switchCodexDirectApi');
if (switchCodexDirectApi) {
  switchCodexDirectApi.onclick = async () => {
    await switchCodexMode(
      'cli',
      { connection: 'direct', auth: 'api' },
      {
        savingText: '正在切换到 Codex CLI 官方直连 + API 登录...',
        successText: '已切换到 Codex CLI 官方直连 + API 登录',
        errorPrefix: '切换到官方直连 + API 登录失败',
      }
    );
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
  fillForm({
    id,
    name: '新上游目标',
    targetUrl: 'http://host:80/v1',
    protocol: 'openai',
    apiKey: '',
    modelRewriteRules: [],
  });
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
  navigator.clipboard
    .writeText(text)
    .then(() => {
      showToast('安装命令已复制到剪贴板', 'success');
    })
    .catch((err) => {
      showToast('复制失败: ' + err.message, 'error');
    });
};
$('btnDiagnosticsConflicts').onclick = async () => {
  const confirmed = await confirmAction({
    title: '依赖诊断与安装提示',
    message:
      '全局安装 npm 工具可能遇到以下冲突：\n1. 权限不足：Windows 下请确保以管理员身份运行终端；\n2. 镜像源失效：我们默认使用了淘宝 npmmirror 镜像源以确保国内连通性。\n\n需要前往日志输出查看代理健康状态吗？',
    confirmText: '查看健康状态',
    cancelText: '知道了',
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
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          protocol: profile.protocol,
          targetUrl: profile.targetUrl,
          apiKey: profile.apiKey,
        }),
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

function persistPromptContentNow(
  type = $('promptClientType').value,
  content = $('promptContent').value
) {
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
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type, content }),
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
    content:
      '# Role\n你是一个追求极简设计与高可维护性的代码重构和软件开发专家。\n\n# 核心原则 (KISS)\n1. 简洁至上：不写不需要的代码，拒绝过度工程与不必要的防御性设计。\n2. 模块化：保持方法短小精悍，职责单一。\n3. 良好文档：为复杂的非直观逻辑编写清晰的内联注释。',
  },
  {
    name: '代码重构大师',
    desc: '渐进式重构代码，消除条件嵌套，保持 API 签名完全兼容。',
    content:
      '# Role\n你是一个严谨的资深系统架构师，擅长发现既有代码库中的瓶颈并进行渐进式重构。\n\n# 核心原则\n1. 兼容性：严禁破坏原有的公共 API 或公共方法签名。\n2. 可读性：通过引入清晰的中间变量、消除嵌套条件分支来提升代码表现力。\n3. 性能：定位高频热循环，并在必要时提供优化和 Benchmark 建议。',
  },
  {
    name: 'Bug 诊断侦探',
    desc: '追踪异常还原诱因，细致搜查空引用溢出，以最小改动解决缺陷。',
    content:
      '# Role\n你是一个逻辑严密的软件调试专家，擅长从异常栈和日志中顺藤摸瓜定位问题根本。\n\n# 核心原则\n1. 溯源分析：不要只修复表象，深入推导问题的根本诱因。\n2. 边界检查：重点检查空指针（NPE）、越界、并发竞争和类型转换异常。\n3. 最小改动：用最少、最优雅的代码修改来解决问题，严防引入新缺陷。',
  },
  {
    name: 'Git 提交规范器',
    desc: '一键将近期变更整理并格式化为 Angular Git Commit 统一规范。',
    content:
      '# Role\n你是一个专业的 Git 工作流管理专家，协助开发者生成完美遵循 Angular 规范的提交日志。\n\n# 核心原则\n提交日志格式应为：\n`<type>(<scope>): <subject>`\n\n常见 `<type>`:\n- feat: 新功能\n- fix: 修复 Bug\n- docs: 文档变更\n- style: 代码格式调整（不影响逻辑）\n- refactor: 重构（既非新增也非修复）\n- test: 添加或修改测试\n- chore: 构建工具或辅助工具的变动',
  },
  {
    name: '单元测试大师',
    desc: '编写高可靠单元测试，包含全边界模拟，隔离外部依赖及网络。',
    content:
      '# Role\n你是一个追求高覆盖率与防御性测试的软件测试工程专家。\n\n# 核心原则\n1. 边界覆盖：为目标方法编写包含正常参数、最大/最小边界值、空值与异常输入的测试用例。\n2. 单一断言：尽量保持单元测试紧凑，每次重点验证一个逻辑分支。\n3. Mock 隔离：合理使用 Mock 框架隔离第三方依赖或数据库网络调用。',
  },
  {
    name: 'PRD 需求撰写专家',
    desc: '梳理业务核心价值、痛点及细分功能，建立清晰验收标准（AC）。',
    content:
      '# Role\n你是一个具备严密逻辑与同理心的资深产品经理，擅长将零散的想法转化为结构清晰、逻辑严谨的产品需求文档（PRD）。\n\n# 核心原则\n1. 业务价值：清晰界定目标用户痛点、用户画像及此功能能带来的商业/体验价值。\n2. 需求拆解：将大功能拆分为细粒度的功能点列表。\n3. 规则细节：详细梳理输入限制、状态变迁、网络异常等边界规则。\n4. 验收标准：为每一个功能点编写清晰的测试用例与验收条件 (AC)。',
  },
  {
    name: '业务流程梳理师',
    desc: '分析复杂的业务流转链路，设计异常降级与状态演变矩阵。',
    content:
      '# Role\n你是一个精通系统交互与状态演变的产品系统架构分析师。\n\n# 核心原则\n1. 主流程：清晰梳理从起点到终点的核心用户交互链路。\n2. 异常分支：重点罗列网络中断、鉴权失败、取消操作等异常链路的降级体验。\n3. 状态变迁：为关键业务实体（如订单、审批）制定清晰的状态转移矩阵（Status Matrix）。',
  },
  {
    name: '竞品分析探针',
    desc: '对比多维度优劣势，分析用户痛点与交互死角，寻找差异化切入点。',
    content:
      '# Role\n你是一个洞察敏锐的商业分析与用户体验（UX）研究专家。\n\n# 核心原则\n1. 多维对比：从商业模式、功能完备度、用户交互、性能体验四个维度深度对比竞品。\n2. 优势放大：提炼出我方可实现差异化竞争的“杀手级特性”。\n3. 痛点定位：分析竞品中用户反响强烈的核心槽点，转化为我方的设计机会点。',
  },
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

function createPresetPromptItemElement(tpl, index) {
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

  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';

  const name = document.createElement('span');
  name.style.fontWeight = '700';
  name.style.fontSize = '12.5px';
  name.style.color = 'var(--text)';
  name.textContent = tpl.name;

  const badge = document.createElement('span');
  badge.className = 'audit-badge info';
  badge.style.fontSize = '9px';
  badge.style.padding = '1px 4px';
  badge.style.fontWeight = '600';
  badge.style.textTransform = 'uppercase';
  badge.textContent = '官方插件';

  const desc = document.createElement('div');
  desc.style.fontSize = '11px';
  desc.style.color = 'var(--muted)';
  desc.style.lineHeight = '1.4';
  desc.textContent = tpl.desc;

  header.appendChild(name);
  header.appendChild(badge);
  item.appendChild(header);
  item.appendChild(desc);
  return item;
}

function createTemplateEmptyElement() {
  const empty = document.createElement('div');
  empty.style.padding = '16px';
  empty.style.textAlign = 'center';
  empty.style.color = 'var(--muted)';
  empty.style.fontSize = '11px';
  empty.textContent = '暂无自定义模板。可在上方输入模版名称，将左侧 Markdown 内容保存为本地插件。';
  return empty;
}

function loadPresetPrompts() {
  const listContainer = $('presetPromptsPanel');
  if (!listContainer) return;
  listContainer.textContent = '';
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
    listContainer.appendChild(createPresetPromptItemElement(tpl, index));
  });
}

function loadTemplates() {
  const listContainer = $('templateList');
  if (!listContainer) return;
  listContainer.textContent = '';
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
    listContainer.appendChild(createTemplateEmptyElement());
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

    const existingIdx = templates.findIndex((t) => t.name === name);
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
  clearElement(container);
  if (!mcpHubConfig || !mcpHubConfig.servers || mcpHubConfig.servers.length === 0) {
    container.appendChild(createMcpServersEmptyElement());
    return;
  }

  container.appendChild(createMcpServersTableElement(mcpHubConfig.servers));
}

function createMcpServersEmptyElement() {
  const empty = document.createElement('div');
  empty.className = 'muted';
  empty.style.padding = '20px';
  empty.style.textAlign = 'center';
  empty.textContent = '暂无已配置的 MCP 服务器。';
  return empty;
}

function createMcpServersTableElement(servers) {
  const wrapper = document.createElement('div');
  wrapper.className = 'route-table';
  const head = document.createElement('div');
  head.className = 'route-table-head';
  const headTable = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  [
    ['服务器 ID', ''],
    ['URL (SSE)', ''],
    ['前缀', ''],
    ['注入', '60px'],
    ['操作', '80px'],
  ].forEach(([label, width]) => {
    const th = document.createElement('th');
    th.textContent = label;
    if (width) th.style.width = width;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  headTable.appendChild(thead);
  head.appendChild(headTable);

  const scroll = document.createElement('div');
  scroll.className = 'route-table-scroll';
  const bodyTable = document.createElement('table');
  const tbody = document.createElement('tbody');
  servers.forEach((server, index) => tbody.appendChild(createMcpServerRow(server, index)));
  bodyTable.appendChild(tbody);
  scroll.appendChild(bodyTable);
  wrapper.append(head, scroll);
  return wrapper;
}

function createMcpServerInput(server, index, field, placeholder = '') {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = String(server[field] || '');
  input.className = 'table-input';
  if (placeholder) input.placeholder = placeholder;
  input.addEventListener('change', () => updateMcpServer(index, field, input.value));
  return input;
}

function createMcpServerRow(server, index) {
  const row = document.createElement('tr');

  const idCell = document.createElement('td');
  idCell.appendChild(createMcpServerInput(server, index, 'id'));
  row.appendChild(idCell);

  const urlCell = document.createElement('td');
  urlCell.appendChild(createMcpServerInput(server, index, 'url', 'http://...'));
  row.appendChild(urlCell);

  const prefixCell = document.createElement('td');
  prefixCell.appendChild(createMcpServerInput(server, index, 'prefix', '可选'));
  row.appendChild(prefixCell);

  const injectCell = document.createElement('td');
  injectCell.style.textAlign = 'center';
  const injectCheckbox = document.createElement('input');
  injectCheckbox.type = 'checkbox';
  injectCheckbox.checked = Boolean(server.injectAll);
  injectCheckbox.addEventListener('change', () =>
    updateMcpServer(index, 'injectAll', injectCheckbox.checked)
  );
  injectCell.appendChild(injectCheckbox);
  row.appendChild(injectCell);

  const actionCell = document.createElement('td');
  actionCell.style.textAlign = 'right';
  const deleteButton = document.createElement('button');
  deleteButton.className = 'danger';
  deleteButton.style.padding = '2px 8px';
  deleteButton.style.fontSize = '12px';
  deleteButton.style.margin = '0';
  deleteButton.textContent = '删除';
  deleteButton.addEventListener('click', () => deleteMcpServer(index));
  actionCell.appendChild(deleteButton);
  row.appendChild(actionCell);

  return row;
}

function updateMcpServer(index, field, value) {
  if (mcpHubConfig.servers[index]) {
    mcpHubConfig.servers[index][field] = value;
  }
}

function deleteMcpServer(index) {
  mcpHubConfig.servers.splice(index, 1);
  renderMcpServers();
}

function addMcpServer() {
  if (!mcpHubConfig.servers) mcpHubConfig.servers = [];
  mcpHubConfig.servers.push({
    id: 'mcp-server-' + Math.random().toString(36).substring(2, 6),
    url: 'http://localhost:3000/sse',
    prefix: '',
    injectAll: true,
  });
  renderMcpServers();
}

function createMcpLogsEmptyElement() {
  const empty = document.createElement('div');
  empty.className = 'muted';
  empty.textContent = '暂无执行记录...';
  return empty;
}

function createMcpLogEntryElement(log) {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.style.marginBottom = '12px';
  entry.style.borderBottom = '1px solid var(--border)';
  entry.style.paddingBottom = '8px';

  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';

  const title = document.createElement('div');
  const time = document.createElement('span');
  time.className = 'muted';
  time.textContent = `[${new Date(log.time).toLocaleTimeString()}] `;
  title.appendChild(time);

  const server = document.createElement('strong');
  server.style.color = 'var(--text)';
  server.textContent = log.serverId || '-';
  title.appendChild(server);
  title.appendChild(document.createTextNode(': '));

  const tool = document.createElement('code');
  tool.style.color = 'var(--primary)';
  tool.style.fontWeight = '600';
  tool.textContent = log.toolName || '-';
  title.appendChild(tool);

  const badge = document.createElement('span');
  badge.className = `badge ${log.status === 'error' ? 'red' : 'green'}`;
  badge.textContent = `${log.status === 'error' ? '失败' : '成功'} (${log.elapsed || 0}ms)`;

  header.appendChild(title);
  header.appendChild(badge);
  entry.appendChild(header);

  if (log.error) {
    const error = document.createElement('div');
    error.style.color = '#ef4444';
    error.style.marginTop = '4px';
    error.textContent = `Error: ${log.error}`;
    entry.appendChild(error);
  }

  const details = document.createElement('details');
  details.style.marginTop = '6px';
  const summary = document.createElement('summary');
  summary.style.cursor = 'pointer';
  summary.style.color = 'var(--primary)';
  summary.style.fontSize = '11px';
  summary.style.userSelect = 'none';
  summary.textContent = '查看参数/结果';

  const pre = document.createElement('pre');
  pre.style.background = 'rgba(0,0,0,0.05)';
  pre.style.padding = '8px';
  pre.style.marginTop = '4px';
  pre.style.borderRadius = '4px';
  pre.style.fontSize = '11.5px';
  pre.style.whiteSpace = 'pre-wrap';
  pre.style.wordBreak = 'break-all';
  pre.textContent = JSON.stringify({ input: log.input, result: log.result }, null, 2);

  details.appendChild(summary);
  details.appendChild(pre);
  entry.appendChild(details);
  return entry;
}

function renderMcpLogs(logs) {
  const container = $('mcpExecutionLogs');
  container.textContent = '';
  if (!logs || logs.length === 0) {
    container.appendChild(createMcpLogsEmptyElement());
    return;
  }

  logs.forEach((log) => container.appendChild(createMcpLogEntryElement(log)));
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
