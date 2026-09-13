import { bindDomainDependencies } from '../runtime/dependencies.js';
import { reportFrontendError } from '../runtime/frontend-errors.js';
import { executeHealthCommand } from '../models/proxy-command.js';

let bridgeDependencies;

export function configureBridge(dependencies) {
  bridgeDependencies = bindDomainDependencies('bridge', dependencies, [
    'config',
    'showToast',
    'assertConfigurationLoaded',
  ]);
}

// 全局错误监控 Banner，第一性原理快速定位前端崩溃
window.onerror = function (message, source, lineno, colno, error) {
  const errorMsg = `${message} at ${source}:${lineno}:${colno}`;
  reportFrontendError('window.onerror', error || new Error(errorMsg));
  let errorDiv = document.getElementById('global-js-error-banner');
  if (!errorDiv) {
    errorDiv = document.createElement('div');
    errorDiv.id = 'global-js-error-banner';
    errorDiv.style.position = 'fixed';
    errorDiv.style.top = '0';
    errorDiv.style.left = '0';
    errorDiv.style.right = '0';
    errorDiv.style.background = '#e11d48';
    errorDiv.style.color = '#ffffff';
    errorDiv.style.padding = '10px 16px';
    errorDiv.style.zIndex = '9999999';
    errorDiv.style.fontSize = '12px';
    errorDiv.style.wordBreak = 'break-all';
    errorDiv.style.fontFamily = 'monospace';
    errorDiv.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
    document.body.appendChild(errorDiv);
  }
  errorDiv.textContent =
    '【前端错误诊断】' + errorMsg + (error && error.stack ? ' | ' + error.stack : '');
};

function localManagementPathFromUrl(url) {
  if (typeof url !== 'string') return '';
  if (url.startsWith('/v1/local/') || url.startsWith('/local/')) return url;
  try {
    const parsed = new URL(url);
    const isLoopback =
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '[::1]' ||
      parsed.hostname === '::1';
    if (
      isLoopback &&
      (parsed.pathname.startsWith('/v1/local/') || parsed.pathname.startsWith('/local/'))
    ) {
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch (err) {
    reportFrontendError('management.parse_local_url', err);
  }
  return '';
}

function rememberLocalServerPorts(config) {
  if (!config || !config.localServer || typeof localStorage === 'undefined') return;
  const listenPort = Number(config.localServer.listenPort);
  if (Number.isFinite(listenPort) && listenPort > 0) {
    localStorage.setItem('last_local_proxy_port', String(listenPort));
  }
  const managementPort = Number(config.localServer.managementPort);
  if (Number.isFinite(managementPort) && managementPort > 0) {
    localStorage.setItem('last_local_management_port', String(managementPort));
  } else if (Number.isFinite(listenPort) && listenPort > 0) {
    localStorage.removeItem('last_local_management_port');
  }
}

export { getApiBase };

function requestContentType(options = {}) {
  const headers = options.headers;
  if (headers instanceof Headers) return headers.get('content-type') || 'application/json';
  if (!headers || typeof headers !== 'object') return 'application/json';
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'content-type');
  return key ? String(headers[key]) : 'application/json';
}

async function nativeManagementFetch(path, options = {}) {
  const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  if (!invoke) throw new Error('Native management bridge is unavailable');
  const body = options.body == null ? '' : options.body;
  if (typeof body !== 'string') {
    throw new TypeError('Native management request body must be a string');
  }
  const result = await invoke('management_fetch_native', {
    // The native host reads the installed configuration; renderer caches may
    // belong to an older port and must not redirect recovery requests.
    managementPort: null,
    path,
    method: String(options.method || 'GET').toUpperCase(),
    contentType: requestContentType(options),
    body,
  });
  return new window.Response(result.body || '', {
    status: result.status,
    headers: result.headers || {},
  });
}

if (typeof localStorage !== 'undefined') localStorage.removeItem('hpm_mgmt_token');

// 拦截全局 fetch，使得在 Tauri 等非同一 origin 下运行时，能够正确访问本地代理的 REST API
const originalFetch = window.fetch;
window.fetch = async function (url, options) {
  const localManagementPath = localManagementPathFromUrl(url);
  if (localManagementPath) {
    const origin = window.location.origin;
    const isRelativeManagementUrl =
      typeof url === 'string' && (url.startsWith('/v1/local/') || url.startsWith('/local/'));
    const isLocalDevOrigin =
      origin.startsWith('http://localhost:') ||
      origin.startsWith('http://127.0.0.1:') ||
      origin.startsWith('https://localhost:');
    const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
    if (invoke && !isLocalDevOrigin) {
      return nativeManagementFetch(localManagementPath, options || {});
    }
    if (isRelativeManagementUrl && !isLocalDevOrigin) {
      url = `http://127.0.0.1:${getManagementPort()}${url}`;
    }
  }
  const response = await originalFetch.call(this, url, options);
  if (localManagementPath && response && response.status === 401) {
    const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
    if (invoke) return nativeManagementFetch(localManagementPath, options || {});
  }
  return response;
};

// 提供基础的 Mock 并在非 Tauri 环境下桥接到本地代理的 REST API
const getListenPort = () => {
  const portEl = document.getElementById('localPort');
  return portEl ? Number(portEl.value || 3443) : 3443;
};
const getManagementPort = () => {
  // 默认管理端口 = HTTPS 端口 + 100；如果配置显式指定 managementPort，则优先使用缓存值。
  const cachedManagementPort =
    typeof localStorage !== 'undefined' ? localStorage.getItem('last_local_management_port') : null;
  const explicitManagementPort = Number(cachedManagementPort);
  if (Number.isFinite(explicitManagementPort) && explicitManagementPort > 0) {
    return explicitManagementPort;
  }
  const cachedPort =
    typeof localStorage !== 'undefined' ? localStorage.getItem('last_local_proxy_port') : null;
  const port = getListenPort();
  const activePort = document.getElementById('localPort')?.value ? port : cachedPort || 3443;
  const derivedPort = Number(activePort) + 100;
  return Number.isInteger(derivedPort) && derivedPort > 0 && derivedPort <= 65535
    ? derivedPort
    : 3543;
};
const getApiBase = () => {
  const origin = window.location.origin;
  // 在 localhost 上时，相对路径即可（开发服务器会代理转发到 HTTPS 代理）
  if (
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:') ||
    origin.startsWith('https://localhost:')
  ) {
    return '';
  }
  // 非 localhost（生产环境 Tauri），使用纯 HTTP 管理端口，避免自签名证书被 webview 拒绝
  return `http://127.0.0.1:${getManagementPort()}`;
};

const isLocalDevOrigin = () => {
  const origin = window.location.origin;
  return (
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:') ||
    origin.startsWith('https://localhost:')
  );
};

const withTimeout = (promise, timeoutMs, message) => {
  let timerId;
  const timeout = new Promise((_, reject) => {
    timerId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timerId));
};

export async function checkProxyHealth() {
  try {
    return await withTimeout(
      (async () => {
        const response = await fetch(getApiBase() + '/v1/local/health');
        if (!response.ok) return null;
        const health = await response.json();
        return health && health.appId === 'https-proxy-manager' ? health : null;
      })(),
      12000,
      'Health check timed out'
    );
  } catch (_) {
    return null;
  }
}

const fetchJsonWithTimeout = async (url, options = {}, timeoutMs = 7000) => {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    let data = {};
    try {
      data = await res.json();
    } catch (err) {
      data = { error: `HTTP ${res.status}` };
    }
    return res.ok ? data : { ok: false, ...data, statusCode: res.status };
  } finally {
    clearTimeout(timerId);
  }
};

const fetchLocalJsonWithAuth = async (path, options = {}, timeoutMs = 7000) => {
  return fetchJsonWithTimeout(`${getApiBase()}${path}`, options, timeoutMs);
};

const fetchLocalPostJson = (path, body = null, timeoutMs = 10000) => {
  const options = { method: 'POST' };
  if (body !== null && body !== undefined) {
    options.headers = { 'content-type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  return fetchJsonWithTimeout(`${getApiBase()}${path}`, options, timeoutMs).catch((err) => ({
    ok: false,
    error: err.message,
  }));
};

const runHealthCommand = () =>
  executeHealthCommand(() => fetchJsonWithTimeout(`${getApiBase()}/v1/local/health`, {}, 7000));

async function clearAuditConversationsNative() {
  const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  if (!invoke) return null;
  try {
    const result = await invoke('clear_audit_conversations_native', {
      managementPort: getManagementPort(),
    });
    if (result && result.ok !== false) return result;
    return result || null;
  } catch (err) {
    reportFrontendError('audit.native_clear_unavailable', err);
    return null;
  }
}

if (!window.proxyManager || !window.proxyManager.setActive) {
  window.proxyManager = {
    applyAppMenu: async (show) => {
      // 非 Tauri 环境下无需操作
    },
    readConfig: async (options = {}) => {
      options = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
      const attempts = Number.isFinite(options.attempts)
        ? Math.min(30, Math.max(1, Math.floor(options.attempts)))
        : 8;
      const retryDelay = Number.isFinite(options.retryDelay)
        ? Math.min(30000, Math.max(0, options.retryDelay))
        : 1000;
      const timeoutMs = Number.isFinite(options.timeoutMs)
        ? Math.min(15000, Math.max(100, options.timeoutMs))
        : 12000;
      const quiet = options.quiet === true;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const data = await withTimeout(
            (async () => {
              const res = await fetch(`${getApiBase()}/v1/local/config`);
              const value = await res.json();
              if (
                !res.ok ||
                !value ||
                value.error ||
                !Array.isArray(value.profiles) ||
                !Array.isArray(value.modelRoutes)
              ) {
                throw new Error('Failed to fetch valid configuration');
              }
              return value;
            })(),
            timeoutMs,
            'Configuration request timed out'
          );
          rememberLocalServerPorts(data);
          return data;
        } catch (err) {
          if (attempt < attempts - 1) {
            await new Promise((r) => setTimeout(r, retryDelay));
            continue;
          }
          if (!quiet) bridgeDependencies.showToast('无法连接本地代理管理端口', 'error');
          reportFrontendError('config.read_unavailable', err);
          return {
            profiles: [],
            modelRoutes: [],
            localServer: {},
            appSettings: {},
            claudeDesktop: { models: [] },
            __fallback: true,
          };
        }
      }
    },
    saveConfig: async (config) => {
      try {
        bridgeDependencies.assertConfigurationLoaded(config);
        rememberLocalServerPorts(config);
        const res = await fetch(`${getApiBase()}/v1/local/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Failed to save configuration');
        }
        return {
          ...config,
          _revision: data.revision || config._revision,
        };
      } catch (err) {
        const message =
          err && err.message
            ? `保存配置失败：${err.message}`
            : '保存配置失败，请确认静态中转及代理在运行中';
        throw new Error(message, { cause: err });
      }
    },
    revealEntryAuthKey: async (keyId) => {
      try {
        const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
        if (invoke && !isLocalDevOrigin()) {
          const result = await invoke('reveal_entry_auth_key_native', {
            managementPort: getManagementPort(),
            keyId,
          });
          return JSON.parse(result.body || '{}');
        }
        const res = await fetch(`${getApiBase()}/v1/local/config/entry-auth-key/reveal`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ keyId }),
        });
        return await res.json();
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    testProfileAuth: async (payload) => {
      try {
        const res = await fetch(`${getApiBase()}/v1/local/profile/test-auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return await res.json();
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    setActive: async (profileId) => {
      try {
        const res = await fetch(getApiBase() + '/v1/local/active', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId }),
        });
        const data = await res.json();
        if (data.ok) {
          const confRes = await fetch(getApiBase() + '/v1/local/config');
          const nextConfig = await confRes.json();
          rememberLocalServerPorts(nextConfig);
          return nextConfig;
        }
      } catch (err) {
        bridgeDependencies.showToast('切换默认上游失败', 'error');
      }
      return bridgeDependencies.config;
    },
    readLog: async (options = {}) => {
      try {
        const params = new URLSearchParams();
        params.set('lines', String(options.lines || 320));
        params.set('maxBytes', String(options.maxBytes || 262144));
        const res = await fetch(`${getApiBase()}/v1/local/log?${params.toString()}`);
        return await res.text();
      } catch (err) {
        return '读取日志失败，请确认代理在运行中';
      }
    },
    readDiagnostics: async () => {
      try {
        const res = await fetch(`${getApiBase()}/v1/local/diagnostics`);
        return await res.json();
      } catch (err) {
        return {
          status: { ok: false, config: null },
          output: '读取诊断事件失败，请确认代理在运行中',
        };
      }
    },
    probeExternalIngress: async (url) => {
      try {
        const res = await fetch(`${getApiBase()}/v1/local/diagnostics/ingress-probe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        return await res.json();
      } catch (err) {
        return { ok: false, classification: 'request_error', error: err.message };
      }
    },
    clearDiagnostics: async () => {
      try {
        const res = await fetch(`${getApiBase()}/v1/local/diagnostics/clear`, { method: 'POST' });
        return await res.json();
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    diagnosticsStatus: async () => {
      try {
        const res = await fetch(getApiBase() + '/v1/local/diagnostics');
        const data = await res.json();
        return data.ok ? data.status : null;
      } catch (err) {
        return null;
      }
    },
    claudeDesktopStatus: async () => {
      try {
        return await fetchJsonWithTimeout(
          `${getApiBase()}/v1/local/claude-desktop/status`,
          {},
          7000
        );
      } catch (err) {
        return {
          ok: false,
          error: err && err.name === 'AbortError' ? 'Claude Desktop 状态检查超时' : err.message,
        };
      }
    },
    traeBridgeStatus: async () => {
      try {
        return await fetchJsonWithTimeout(`${getApiBase()}/v1/local/trae/bridge/status`, {}, 7000);
      } catch (err) {
        return {
          ok: false,
          error: err && err.name === 'AbortError' ? 'Trae Bridge 状态检查超时' : err.message,
        };
      }
    },
    traeDebugClaudeProcessSelfTest: async (payload) => {
      try {
        return await fetchJsonWithTimeout(
          `${getApiBase()}/v1/local/trae/debug/claude-process/self-test`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload || {}),
          },
          120000
        );
      } catch (err) {
        return {
          ok: false,
          error: err && err.name === 'AbortError' ? 'Claude 过程输出自检超时' : err.message,
        };
      }
    },
    traeDebugEvents: async () => {
      try {
        return await fetchJsonWithTimeout(
          `${getApiBase()}/v1/local/trae/debug/events?limit=80`,
          {},
          7000
        );
      } catch (err) {
        return {
          ok: false,
          error: err && err.name === 'AbortError' ? 'Trae Debug 事件读取超时' : err.message,
        };
      }
    },
    traeDebugNativeDeepEvents: async () => {
      try {
        return await fetchJsonWithTimeout(
          `${getApiBase()}/v1/local/trae/debug/native/deep/events?limit=120`,
          {},
          7000
        );
      } catch (err) {
        return {
          ok: false,
          error: err && err.name === 'AbortError' ? 'Trae 深入事件读取超时' : err.message,
        };
      }
    },
    startTraeDebugNativeDeep: async (payload) => {
      try {
        return await fetchJsonWithTimeout(
          `${getApiBase()}/v1/local/trae/debug/native/deep/start`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload || {}),
          },
          35000
        );
      } catch (err) {
        return {
          ok: false,
          error: err && err.name === 'AbortError' ? 'Trae 深入探针启动超时' : err.message,
        };
      }
    },
    stopTraeDebugNativeDeep: async () => {
      try {
        return await fetchJsonWithTimeout(
          `${getApiBase()}/v1/local/trae/debug/native/deep/stop`,
          { method: 'POST' },
          7000
        );
      } catch (err) {
        return {
          ok: false,
          error: err && err.name === 'AbortError' ? 'Trae 深入探针停止超时' : err.message,
        };
      }
    },
    traeDebugSettings: async () => {
      try {
        return await fetchJsonWithTimeout(`${getApiBase()}/v1/local/trae/debug/settings`, {}, 7000);
      } catch (err) {
        return {
          ok: false,
          error: err && err.name === 'AbortError' ? 'Trae Debug 开关读取超时' : err.message,
        };
      }
    },
    saveTraeDebugSettings: async (payload) => {
      try {
        return await fetchJsonWithTimeout(
          `${getApiBase()}/v1/local/trae/debug/settings`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload || {}),
          },
          7000
        );
      } catch (err) {
        return {
          ok: false,
          error: err && err.name === 'AbortError' ? 'Trae Debug 开关保存超时' : err.message,
        };
      }
    },
    traeDebugNativeStatus: async () => {
      try {
        return await fetchJsonWithTimeout(
          `${getApiBase()}/v1/local/trae/debug/native/status`,
          {},
          7000
        );
      } catch (err) {
        return {
          ok: false,
          error: err && err.name === 'AbortError' ? 'Trae Native Debug 状态读取超时' : err.message,
        };
      }
    },
    traeDebugNativeScan: async () => {
      try {
        return await fetchJsonWithTimeout(
          `${getApiBase()}/v1/local/trae/debug/native/scan`,
          { method: 'POST' },
          30000
        );
      } catch (err) {
        return {
          ok: false,
          error: err && err.name === 'AbortError' ? 'Trae Native 扫描超时' : err.message,
        };
      }
    },
    applyClaudeDesktop: async () => {
      try {
        return await fetchJsonWithTimeout(
          `${getApiBase()}/v1/local/claude-desktop/apply`,
          { method: 'POST' },
          10000
        );
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    restoreClaudeDesktop: async () => {
      try {
        return await fetchJsonWithTimeout(
          `${getApiBase()}/v1/local/claude-desktop/restore`,
          { method: 'POST' },
          10000
        );
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    claudeDesktopSyncMcp: () =>
      fetchJsonWithTimeout(
        `${getApiBase()}/v1/local/claude-desktop/sync-mcp`,
        { method: 'POST' },
        10000
      ).catch((err) => ({ ok: false, error: err.message })),
    claudeDesktopRestoreBackup: () =>
      fetchJsonWithTimeout(
        `${getApiBase()}/v1/local/claude-desktop/restore-backup`,
        { method: 'POST' },
        10000
      ).catch((err) => ({ ok: false, error: err.message })),
    clientActivity: (client, limit = 5) =>
      fetchJsonWithTimeout(
        `${getApiBase()}/v1/local/client-activity?client=${encodeURIComponent(client || '')}&limit=${limit}`,
        {},
        7000
      ).catch((err) => ({ ok: false, error: err.message, activities: [] })),
    applyPromptPresetToClient: (presetId, client) =>
      fetchJsonWithTimeout(
        `${getApiBase()}/v1/local/prompts/presets`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'apply', presetId, client }),
        },
        10000
      ).catch((err) => ({ ok: false, error: err.message })),
    mcpToolsList: (serverId) =>
      fetchJsonWithTimeout(
        `${getApiBase()}/v1/local/mcp-hub/tools${serverId ? `?serverId=${encodeURIComponent(serverId)}` : ''}`,
        {},
        10000
      ).catch((err) => ({ ok: false, error: err.message, results: {} })),
    mcpExecuteTool: (serverId, toolName, args) =>
      fetchJsonWithTimeout(
        `${getApiBase()}/v1/local/mcp-hub/execute`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverId, toolName, arguments: args || {} }),
        },
        20000
      ).catch((err) => ({ ok: false, error: err.message })),
    certStatus: async () => {
      if (window.__TAURI__ && window.__TAURI__.core && !isLocalDevOrigin()) {
        try {
          const nativeStatus = await withTimeout(
            window.__TAURI__.core.invoke('get_cert_status_native'),
            900,
            'Tauri native certificate status timed out'
          );
          if (nativeStatus && nativeStatus.ok) return nativeStatus;
        } catch (err) {
          reportFrontendError('certificate.native_status_unavailable', err);
        }
      }
      try {
        const httpStatus = await fetchJsonWithTimeout(
          getApiBase() + '/v1/local/cert',
          {},
          isLocalDevOrigin() ? 1200 : 2500
        );
        if (httpStatus && httpStatus.ok) return httpStatus;
      } catch (err) {
        reportFrontendError('certificate.local_status_unavailable', err);
      }
      if (window.__TAURI__ && window.__TAURI__.core) {
        try {
          const nativeStatus = await withTimeout(
            window.__TAURI__.core.invoke('get_cert_status_native'),
            isLocalDevOrigin() ? 800 : 3500,
            'Tauri native certificate status timed out'
          );
          if (nativeStatus && nativeStatus.ok) return nativeStatus;
        } catch (err) {
          reportFrontendError('certificate.native_status_unavailable', err);
        }
      }
      try {
        return await fetchJsonWithTimeout(getApiBase() + '/v1/local/cert', {}, 7000);
      } catch (err) {
        const isAbort = err && err.name === 'AbortError';
        return {
          ok: false,
          exists: false,
          error: isAbort
            ? '证书状态请求超时'
            : err && err.message
              ? err.message
              : '证书状态请求失败',
        };
      }
    },
    listModels: async (profile) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(getApiBase() + '/v1/local/models/list', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify(profile),
        });
        return await res.json();
      } catch (err) {
        return {
          ok: false,
          error:
            err && err.name === 'AbortError'
              ? '获取上游模型超时，请检查上游地址、代理网络或官方登录凭证。'
              : err.message,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },
    testRouteConnection: async (payload) => {
      try {
        const res = await fetch(getApiBase() + '/v1/local/route/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return await res.json();
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    command: async (cmd) => {
      if (cmd === 'health') return runHealthCommand();
      if (window.__TAURI__ && window.__TAURI__.core) {
        try {
          return await window.__TAURI__.core.invoke('execute_proxy_command', { command: cmd });
        } catch (e) {
          return { code: -1, output: '执行命令失败: ' + e };
        }
      }
      if (cmd === 'status') {
        try {
          const res = await fetch(getApiBase() + '/v1/local/health');
          const data = await res.json();
          if (data.ok) {
            return { output: `PID: 9999\n运行中，接口正常（非 Tauri 桥接）。` };
          }
        } catch (err) {
          reportFrontendError('proxy.browser_status', err);
        }
        return { output: '' };
      }
      return {
        output: `非 Tauri 环境限制：无法直接通过网页控制代理进程。请在命令行手动执行：npm run start 或者是 node openai-proxy.js 启动/停止代理。`,
      };
    },
    testConnectivity: async () => {
      try {
        const res = await fetch(getApiBase() + '/v1/local/health');
        const data = await res.json();
        return {
          ok: data.ok,
          output: data.ok ? '代理服务器健康且连通！' : '代理服务器未处于健康状态。',
        };
      } catch (err) {
        return {
          ok: false,
          error: err.message,
          output: '无法连通本地代理服务，请确保代理服务已启动。',
        };
      }
    },
    openConfig: async () => {
      if (window.__TAURI__ && window.__TAURI__.core) {
        try {
          await window.__TAURI__.core.invoke('open_config');
        } catch (e) {
          reportFrontendError('bridge.read_config', e);
        }
        return;
      }
      bridgeDependencies.showToast(
        '非 Tauri 环境限制：请手动使用文本编辑器打开项目根目录下的 proxy.config.json 进行编辑。'
      );
    },
    openLog: async () => {
      if (window.__TAURI__ && window.__TAURI__.core) {
        try {
          await window.__TAURI__.core.invoke('open_log');
        } catch (e) {
          reportFrontendError('bridge.save_config', e);
        }
        return;
      }
      bridgeDependencies.showToast(
        '非 Tauri 环境限制：请直接打开项目根目录下的 .hpm-runtime/proxy.log 查看日志。'
      );
    },
    openCertDir: async () => {
      if (window.__TAURI__ && window.__TAURI__.core) {
        try {
          await window.__TAURI__.core.invoke('open_cert_dir');
        } catch (e) {
          reportFrontendError('bridge.get_runtime_info', e);
        }
        return;
      }
      bridgeDependencies.showToast(
        '非 Tauri 环境限制：证书目录位于项目根目录的 .hpm-runtime/.certs 文件夹中。'
      );
    },
    readEvents: async (options = {}) => {
      try {
        const params = new URLSearchParams();
        if (options.limit) params.set('limit', String(options.limit));
        if (options.after) params.set('after', options.after);
        const suffix = params.toString() ? `?${params.toString()}` : '';
        const res = await fetch(`${getApiBase()}/v1/local/events${suffix}`);
        return await res.json();
      } catch (err) {
        return [];
      }
    },
    clearEvents: async () => {
      try {
        const res = await fetch(`${getApiBase()}/v1/local/events/clear`, { method: 'POST' });
        return await res.json();
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    installCert: async () => {
      try {
        const res = await fetch(getApiBase() + '/v1/local/cert/trust', { method: 'POST' });
        return await res.json();
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    uninstallCert: async () => {
      try {
        const res = await fetch(getApiBase() + '/v1/local/cert/untrust', { method: 'POST' });
        return await res.json();
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    onTrayCommand: () => Promise.resolve(() => {}),
    onOpenView: () => Promise.resolve(() => {}),
    claudeCodeStatus: async () => {
      try {
        return await fetchJsonWithTimeout(`${getApiBase()}/v1/local/claude-code/status`, {}, 7000);
      } catch (err) {
        return {
          ok: false,
          error: err && err.name === 'AbortError' ? 'Claude Code 状态检查超时' : err.message,
        };
      }
    },
    applyClaudeCode: async () => {
      try {
        return await fetchJsonWithTimeout(
          getApiBase() + '/v1/local/claude-code/apply',
          { method: 'POST' },
          10000
        );
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    restoreClaudeCode: async () => {
      try {
        return await fetchJsonWithTimeout(
          getApiBase() + '/v1/local/claude-code/restore',
          { method: 'POST' },
          10000
        );
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    antigravityCliStatus: async () => {
      try {
        return await fetchJsonWithTimeout(
          `${getApiBase()}/v1/local/antigravity-cli/status`,
          {},
          7000
        );
      } catch (err) {
        return {
          ok: false,
          error: err && err.name === 'AbortError' ? 'Antigravity CLI 状态检查超时' : err.message,
        };
      }
    },
    applyAntigravityCli: async () => {
      try {
        return await fetchJsonWithTimeout(
          getApiBase() + '/v1/local/antigravity-cli/apply',
          { method: 'POST' },
          10000
        );
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    restoreAntigravityCli: async () => {
      try {
        return await fetchJsonWithTimeout(
          getApiBase() + '/v1/local/antigravity-cli/restore',
          { method: 'POST' },
          10000
        );
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    envCheck: async () => {
      try {
        const res = await fetch(`${getApiBase()}/v1/local/env/check`);
        return await res.json();
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    envUpgrade: async (payload) => {
      try {
        const body = Array.isArray(payload)
          ? { toolIds: payload }
          : payload && typeof payload === 'object'
            ? payload
            : { toolId: payload };
        const res = await fetch(getApiBase() + '/v1/local/env/upgrade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return await res.json();
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    envInstallJobs: async (jobIds = []) => {
      try {
        const params = new URLSearchParams();
        if (Array.isArray(jobIds) && jobIds.length > 0) {
          params.set('ids', jobIds.join(','));
        }
        const query = params.toString();
        const res = await fetch(
          getApiBase() + '/v1/local/env/install-jobs' + (query ? `?${query}` : '')
        );
        return await res.json();
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    codexStatus: async () => {
      try {
        return await fetchJsonWithTimeout(`${getApiBase()}/v1/local/codex/status`, {}, 7000);
      } catch (err) {
        return {
          ok: false,
          error: err && err.name === 'AbortError' ? 'Codex CLI 状态检查超时' : err.message,
        };
      }
    },
    codexDesktopStatus: async () => {
      try {
        return await fetchJsonWithTimeout(
          `${getApiBase()}/v1/local/codex-desktop/status`,
          {},
          7000
        );
      } catch (err) {
        return {
          ok: false,
          error: err && err.name === 'AbortError' ? 'Codex Desktop 状态检查超时' : err.message,
        };
      }
    },

    applyCodex: (payload = {}) => fetchLocalPostJson('/v1/local/codex/apply', payload),
    switchCodex: (payload = {}) => fetchLocalPostJson('/v1/local/codex/switch', payload),
    codexApiLogin: (payload = {}) => fetchLocalPostJson('/v1/local/codex/auth/api-login', payload),
    codexOfficialLogin: (payload = {}) =>
      fetchLocalPostJson('/v1/local/codex/auth/official-login', payload),
    codexAuthBackup: () => fetchLocalPostJson('/v1/local/codex/auth/backup'),
    applyCodexDesktop: () => fetchLocalPostJson('/v1/local/codex-desktop/apply'),
    codexDesktopApiLogin: (payload = {}) =>
      fetchLocalPostJson('/v1/local/codex-desktop/auth/api-login', payload),
    codexDesktopOfficialLogin: (payload = {}) =>
      fetchLocalPostJson('/v1/local/codex-desktop/auth/official-login', payload),
    codexDesktopAuthBackup: () => fetchLocalPostJson('/v1/local/codex-desktop/auth/backup'),
    switchCodexDesktop: (payload = {}) =>
      fetchLocalPostJson('/v1/local/codex-desktop/switch', payload),
    restoreCodex: () => fetchLocalPostJson('/v1/local/codex/restore'),
    restoreCodexDesktop: () => fetchLocalPostJson('/v1/local/codex-desktop/restore'),
    geminiCliStatus: async () => {
      try {
        return await fetchJsonWithTimeout(`${getApiBase()}/v1/local/gemini-cli/status`, {}, 7000);
      } catch (err) {
        return {
          ok: false,
          error: err && err.name === 'AbortError' ? 'Gemini CLI 状态检查超时' : err.message,
        };
      }
    },
    applyGeminiCli: () => fetchLocalPostJson('/v1/local/gemini-cli/apply'),
    restoreGeminiCli: () => fetchLocalPostJson('/v1/local/gemini-cli/restore'),
    cliCredentials: async (type) => {
      try {
        const res = await fetch(getApiBase() + '/v1/local/auth/cli-credentials?type=' + type);
        return await res.json();
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    getRateLimits: async (profileId) => {
      try {
        const res = await fetch(
          getApiBase() + '/v1/local/auth/rate-limits?profileId=' + encodeURIComponent(profileId)
        );
        return await res.json();
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    readAuditConversations: async (limit = 50) => {
      try {
        return await fetchLocalJsonWithAuth(
          '/v1/local/audit/conversations?limit=' + encodeURIComponent(String(limit)),
          {},
          7000
        );
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    readUsageReport: async (options = {}) => {
      try {
        const params = new URLSearchParams();
        params.set('limit', String(options.limit || 300));
        if (options.after) params.set('after', options.after);
        return await fetchLocalJsonWithAuth(
          '/v1/local/usage/report?' + params.toString(),
          {},
          7000
        );
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    retryAuditRequest: async (id) => {
      try {
        return await fetchLocalJsonWithAuth(
          '/v1/local/audit/retry',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          },
          15000
        );
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    clearAuditConversations: async () => {
      try {
        const nativeResult = await clearAuditConversationsNative();
        if (nativeResult && nativeResult.ok !== false) return nativeResult;
        return await fetchLocalJsonWithAuth(
          '/v1/local/audit/conversations/clear',
          {
            method: 'POST',
          },
          7000
        );
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  };
}

if (window.__TAURI__ && window.__TAURI__.core) {
  const invoke = window.__TAURI__.core.invoke;
  window.proxyManager.applyAppMenu = async (show) => {
    try {
      await invoke('apply_app_menu', { show });
    } catch (e) {
      reportFrontendError('app_menu.apply', e);
    }
  };
  window.proxyManager.getLaunchOnLogin = async () => {
    return await invoke('get_launch_on_login');
  };
  window.proxyManager.setLaunchOnLogin = async (enabled) => {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    return await invoke('set_launch_on_login', { enabled });
  };
  window.proxyManager.command = async (command) => {
    if (command === 'health') return runHealthCommand();
    try {
      const res = await invoke('execute_proxy_command', { command });
      const out = (res.output || '').toLowerCase();
      return {
        code: res.code,
        output: res.output || '',
        ok: res.code === 0,
        message: res.output || '',
        running: out.includes('running') && !out.includes('not running'),
      };
    } catch (e) {
      reportFrontendError('proxy.command', e);
      return {
        code: -1,
        output: String(e),
        ok: false,
        error: String(e),
        message: String(e),
        running: false,
      };
    }
  };
  window.proxyManager.launchCodexLoginScript = async () => {
    try {
      const res = await invoke('launch_codex_login_script');
      return { ok: true, ...res };
    } catch (e) {
      reportFrontendError('codex_login.launch', e);
      return { ok: false, error: String(e) };
    }
  };
  window.proxyManager.selectDirectory = async () => {
    try {
      return await invoke('select_directory_native');
    } catch (e) {
      reportFrontendError('directory.select', e);
      return { ok: false, error: String(e) };
    }
  };
  window.proxyManager.onTrayCommand = (handler) => {
    if (!window.__TAURI__.event) return Promise.resolve(() => {});
    return window.__TAURI__.event.listen('tray-command', (event) => handler(event.payload));
  };
  window.proxyManager.onOpenView = (handler) => {
    if (!window.__TAURI__.event) return Promise.resolve(() => {});
    return window.__TAURI__.event.listen('open-view', (event) => handler(event.payload));
  };
  if (window.__TAURI__.event) {
    window.__TAURI__.event
      .listen('reload-requested', (event) => {
        if (event && event.payload === true) {
          window.location.reload(true);
          return;
        }
        window.location.reload();
      })
      .catch((e) => reportFrontendError('reload.listen', e));
  }
}
