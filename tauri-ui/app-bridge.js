// 全局错误监控 Banner，第一性原理快速定位前端崩溃
window.onerror = function(message, source, lineno, colno, error) {
  const errorMsg = `${message} at ${source}:${lineno}:${colno}`;
  console.error(errorMsg);
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
  errorDiv.textContent = '【前端错误诊断】' + errorMsg + (error && error.stack ? ' | ' + error.stack : '');
};

// 拦截全局 fetch，使得在 Tauri 等非同一 origin 下运行时，能够正确访问本地代理的 REST API
const originalFetch = window.fetch;
window.fetch = function(url, options) {
  if (typeof url === 'string' && (url.startsWith('/v1/local/') || url.startsWith('/local/'))) {
    const origin = window.location.origin;
    if (!origin.startsWith('http://localhost:') && !origin.startsWith('http://127.0.0.1:') && !origin.startsWith('https://localhost:')) {
      const cachedPort = localStorage.getItem('last_local_proxy_port') || '3443';
      const mgmtPort = Number(cachedPort) + 100;
      url = `http://127.0.0.1:${mgmtPort}${url}`;
    }

    // 自动注入管理 Token
    options = options || {};
    options.headers = options.headers || {};
    const token = localStorage.getItem('hpm_mgmt_token');
    if (token && !options.headers['x-mgmt-token']) {
      if (options.headers instanceof Headers) {
        options.headers.set('x-mgmt-token', token);
      } else {
        options.headers['x-mgmt-token'] = token;
      }
    }
  }
  return originalFetch.call(this, url, options);
};

// 提供基础的 Mock 并在非 Tauri 环境下桥接到本地代理的 REST API
const getListenPort = () => {
  const portEl = document.getElementById('localPort');
  return portEl ? Number(portEl.value || 3443) : 3443;
};
const getManagementPort = () => {
  // 管理端口 = HTTPS 端口 + 100（如 3443 → 3543）
  const cachedPort = typeof localStorage !== 'undefined' ? localStorage.getItem('last_local_proxy_port') : null;
  const port = getListenPort();
  const activePort = document.getElementById('localPort')?.value ? port : (cachedPort || 3443);
  return Number(activePort) + 100;
};
const getApiBase = () => {
  const origin = window.location.origin;
  // 在 localhost 上时，相对路径即可（开发服务器会代理转发到 HTTPS 代理）
  if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:') || origin.startsWith('https://localhost:')) {
    return '';
  }
  // 非 localhost（生产环境 Tauri），使用纯 HTTP 管理端口，避免自签名证书被 webview 拒绝
  return `http://127.0.0.1:${getManagementPort()}`;
};

const withTimeout = (promise, timeoutMs, message) => {
  let timerId;
  const timeout = new Promise((_, reject) => {
    timerId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timerId));
};

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

if (!window.proxyManager || !window.proxyManager.setActive) {
  window.proxyManager = {
    applyAppMenu: async (show) => {
      // 非 Tauri 环境下无需操作
    },
    readConfig: async (options = {}) => {
      const attempts = Number.isFinite(options.attempts) ? Math.max(1, options.attempts) : 8;
      const retryDelay = Number.isFinite(options.retryDelay) ? Math.max(0, options.retryDelay) : 1000;
      const quiet = options.quiet === true;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const res = await fetch(`${getApiBase()}/v1/local/config`, {
            headers: { 'x-mgmt-token': localStorage.getItem('hpm_mgmt_token') || '' }
          });
          const data = await res.json();
          if (!res.ok || data.error) throw new Error(data.error || 'Failed to fetch config');
          if (data && data.localServer && data.localServer.listenPort) {
            localStorage.setItem('last_local_proxy_port', String(data.localServer.listenPort));
          }
          return data;
        } catch (err) {
          if (attempt < attempts - 1) {
            await new Promise(r => setTimeout(r, retryDelay));
            continue;
          }
          if (!quiet) showToast('无法连接本地代理管理端口', 'error');
          return { profiles: [], modelRoutes: [], localServer: {}, appSettings: {}, claudeDesktop: { models: [] }, __fallback: true };
        }
      }
    },
    saveConfig: async (config) => {
      try {
        if (config && config.localServer && config.localServer.listenPort) {
          localStorage.setItem('last_local_proxy_port', String(config.localServer.listenPort));
        }
        const res = await fetch(`${getApiBase()}/v1/local/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config)
        });
        const data = await res.json();
        return data.ok ? config : config;
      } catch (err) {
        showToast('保存配置失败，请确认静态中转及代理在运行中', 'error');
        return config;
      }
    },
    testProfileAuth: async (payload) => {
      try {
        const res = await fetch(`${getApiBase()}/v1/local/profile/test-auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
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
          body: JSON.stringify({ profileId })
        });
        const data = await res.json();
        if (data.ok) {
          const confRes = await fetch(getApiBase() + '/v1/local/config');
          return await confRes.json();
        }
      } catch (err) {
        showToast('切换默认上游失败', 'error');
      }
      return config;
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
        return { status: { ok: false, config: null }, output: '读取诊断事件失败，请确认代理在运行中' };
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
        return await fetchJsonWithTimeout(`${getApiBase()}/v1/local/claude-desktop/status`, {}, 7000);
      } catch (err) {
        return { ok: false, error: err && err.name === 'AbortError' ? 'Claude Desktop 状态检查超时' : err.message };
      }
    },
    traeBridgeStatus: async () => {
      try {
        return await fetchJsonWithTimeout(`${getApiBase()}/v1/local/trae/bridge/status`, {}, 7000);
      } catch (err) {
        return { ok: false, error: err && err.name === 'AbortError' ? 'Trae Bridge 状态检查超时' : err.message };
      }
    },
    traeDebugEvents: async () => {
      try {
        return await fetchJsonWithTimeout(`${getApiBase()}/v1/local/trae/debug/events?limit=80`, {}, 7000);
      } catch (err) {
        return { ok: false, error: err && err.name === 'AbortError' ? 'Trae Debug 事件读取超时' : err.message };
      }
    },
    traeDebugSettings: async () => {
      try {
        return await fetchJsonWithTimeout(`${getApiBase()}/v1/local/trae/debug/settings`, {}, 7000);
      } catch (err) {
        return { ok: false, error: err && err.name === 'AbortError' ? 'Trae Debug 开关读取超时' : err.message };
      }
    },
    saveTraeDebugSettings: async (payload) => {
      try {
        return await fetchJsonWithTimeout(`${getApiBase()}/v1/local/trae/debug/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload || {})
        }, 7000);
      } catch (err) {
        return { ok: false, error: err && err.name === 'AbortError' ? 'Trae Debug 开关保存超时' : err.message };
      }
    },
    traeDebugNativeStatus: async () => {
      try {
        return await fetchJsonWithTimeout(`${getApiBase()}/v1/local/trae/debug/native/status`, {}, 7000);
      } catch (err) {
        return { ok: false, error: err && err.name === 'AbortError' ? 'Trae Native Debug 状态读取超时' : err.message };
      }
    },
    traeDebugNativeScan: async () => {
      try {
        return await fetchJsonWithTimeout(`${getApiBase()}/v1/local/trae/debug/native/scan`, { method: 'POST' }, 30000);
      } catch (err) {
        return { ok: false, error: err && err.name === 'AbortError' ? 'Trae Native 扫描超时' : err.message };
      }
    },
    applyClaudeDesktop: async () => {
      try {
        return await fetchJsonWithTimeout(`${getApiBase()}/v1/local/claude-desktop/apply`, { method: 'POST' }, 10000);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    restoreClaudeDesktop: async () => {
      try {
        return await fetchJsonWithTimeout(getApiBase() + '/v1/local/claude-desktop/restore', { method: 'POST' }, 10000);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    certStatus: async () => {
      if (window.__TAURI__ && window.__TAURI__.core) {
        try {
          const nativeStatus = await withTimeout(
            window.__TAURI__.core.invoke('get_cert_status_native'),
            3500,
            'Tauri native certificate status timed out'
          );
          if (nativeStatus && nativeStatus.ok) return nativeStatus;
        } catch (err) {
          console.debug('Native certificate status unavailable:', err);
        }
      }
      try {
        return await fetchJsonWithTimeout(getApiBase() + '/v1/local/cert', {}, 7000);
      } catch (err) {
        const isAbort = err && err.name === 'AbortError';
        return { ok: false, exists: false, error: isAbort ? '证书状态请求超时' : (err && err.message ? err.message : '证书状态请求失败') };
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
          body: JSON.stringify(profile)
        });
        return await res.json();
      } catch (err) {
        return { ok: false, error: err && err.name === 'AbortError' ? '获取上游模型超时，请检查上游地址、代理网络或官方登录凭证。' : err.message };
      } finally {
        clearTimeout(timeoutId);
      }
    },
    testRouteConnection: async (payload) => {
      try {
        const res = await fetch(getApiBase() + '/v1/local/route/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        return await res.json();
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    command: async (cmd) => {
      if (window.__TAURI__ && window.__TAURI__.core) {
        try {
          return await window.__TAURI__.core.invoke('executeProxyCommand', { command: cmd });
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
        } catch (err) {}
        return { output: '' };
      }
      if (cmd === 'health') {
        try {
          const res = await fetch(getApiBase() + '/v1/local/health');
          const data = await res.json();
          if (data.ok) {
            return { code: 0, output: `代理服务健康检查：\n状态: ${data.status}\n一切正常！` };
          }
        } catch (err) {
          return { code: -1, output: `健康检查失败：${err.message}` };
        }
      }
      return { output: `非 Tauri 环境限制：无法直接通过网页控制代理进程。请在命令行手动执行：npm run start 或者是 node openai-proxy.js 启动/停止代理。` };
    },
    testConnectivity: async () => {
      try {
        const res = await fetch(getApiBase() + '/v1/local/health');
        const data = await res.json();
        return { ok: data.ok, output: data.ok ? '代理服务器健康且连通！' : '代理服务器未处于健康状态。' };
      } catch (err) {
        return { ok: false, error: err.message, output: '无法连通本地代理服务，请确保代理服务已启动。' };
      }
    },
    openConfig: async () => {
      if (window.__TAURI__ && window.__TAURI__.core) {
        try { await window.__TAURI__.core.invoke('openConfig'); } catch (e) { console.error(e); }
        return;
      }
      showToast('非 Tauri 环境限制：请手动使用文本编辑器打开项目根目录下的 proxy.config.json 进行编辑。');
    },
    openLog: async () => {
      if (window.__TAURI__ && window.__TAURI__.core) {
        try { await window.__TAURI__.core.invoke('openLog'); } catch (e) { console.error(e); }
        return;
      }
      showToast('非 Tauri 环境限制：请直接打开项目根目录下的 .hpm-runtime/proxy.log 查看日志。');
    },
    openCertDir: async () => {
      if (window.__TAURI__ && window.__TAURI__.core) {
        try { await window.__TAURI__.core.invoke('openCertDir'); } catch (e) { console.error(e); }
        return;
      }
      showToast('非 Tauri 环境限制：证书目录位于项目根目录的 .hpm-runtime/.certs 文件夹中。');
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
        return { ok: false, error: err && err.name === 'AbortError' ? 'Claude Code 状态检查超时' : err.message };
      }
    },
    applyClaudeCode: async () => {
      try {
        return await fetchJsonWithTimeout(getApiBase() + '/v1/local/claude-code/apply', { method: 'POST' }, 10000);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    restoreClaudeCode: async () => {
      try {
        return await fetchJsonWithTimeout(getApiBase() + '/v1/local/claude-code/restore', { method: 'POST' }, 10000);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    antigravityCliStatus: async () => {
      try {
        return await fetchJsonWithTimeout(`${getApiBase()}/v1/local/antigravity-cli/status`, {}, 7000);
      } catch (err) {
        return { ok: false, error: err && err.name === 'AbortError' ? 'Antigravity CLI 状态检查超时' : err.message };
      }
    },
    applyAntigravityCli: async () => {
      try {
        return await fetchJsonWithTimeout(getApiBase() + '/v1/local/antigravity-cli/apply', { method: 'POST' }, 10000);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    restoreAntigravityCli: async () => {
      try {
        return await fetchJsonWithTimeout(getApiBase() + '/v1/local/antigravity-cli/restore', { method: 'POST' }, 10000);
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
          : (payload && typeof payload === 'object' ? payload : { toolId: payload });
        const res = await fetch(getApiBase() + '/v1/local/env/upgrade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
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
        const res = await fetch(getApiBase() + '/v1/local/env/install-jobs' + (query ? `?${query}` : ''));
        return await res.json();
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    codexStatus: async () => {
      try {
        return await fetchJsonWithTimeout(`${getApiBase()}/v1/local/codex/status`, {}, 7000);
      } catch (err) {
        return { ok: false, error: err && err.name === 'AbortError' ? 'Codex CLI 状态检查超时' : err.message };
      }
    },
    codexDesktopStatus: async () => {
      try {
        return await fetchJsonWithTimeout(`${getApiBase()}/v1/local/codex-desktop/status`, {}, 7000);
      } catch (err) {
        return { ok: false, error: err && err.name === 'AbortError' ? 'Codex Desktop 状态检查超时' : err.message };
      }
    },
    applyCodex: async () => {
      try {
        return await fetchJsonWithTimeout(getApiBase() + '/v1/local/codex/apply', { method: 'POST' }, 10000);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    switchCodex: async (payload = {}) => {
      try {
        return await fetchJsonWithTimeout(getApiBase() + '/v1/local/codex/switch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }, 10000);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    codexApiLogin: async (payload = {}) => {
      try {
        return await fetchJsonWithTimeout(getApiBase() + '/v1/local/codex/auth/api-login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }, 10000);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    codexOfficialLogin: async (payload = {}) => {
      try {
        return await fetchJsonWithTimeout(getApiBase() + '/v1/local/codex/auth/official-login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }, 10000);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    codexAuthBackup: async () => {
      try {
        return await fetchJsonWithTimeout(getApiBase() + '/v1/local/codex/auth/backup', { method: 'POST' }, 10000);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    applyCodexDesktop: async () => {
      try {
        return await fetchJsonWithTimeout(getApiBase() + '/v1/local/codex-desktop/apply', { method: 'POST' }, 10000);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    codexDesktopApiLogin: async (payload = {}) => {
      try {
        return await fetchJsonWithTimeout(getApiBase() + '/v1/local/codex-desktop/auth/api-login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }, 10000);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    codexDesktopOfficialLogin: async (payload = {}) => {
      try {
        return await fetchJsonWithTimeout(getApiBase() + '/v1/local/codex-desktop/auth/official-login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }, 10000);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    codexDesktopAuthBackup: async () => {
      try {
        return await fetchJsonWithTimeout(getApiBase() + '/v1/local/codex-desktop/auth/backup', { method: 'POST' }, 10000);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    switchCodexDesktop: async (payload = {}) => {
      try {
        return await fetchJsonWithTimeout(getApiBase() + '/v1/local/codex-desktop/switch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }, 10000);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    restoreCodex: async () => {
      try {
        return await fetchJsonWithTimeout(getApiBase() + '/v1/local/codex/restore', { method: 'POST' }, 10000);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    restoreCodexDesktop: async () => {
      try {
        return await fetchJsonWithTimeout(getApiBase() + '/v1/local/codex-desktop/restore', { method: 'POST' }, 10000);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    geminiCliStatus: async () => {
      try {
        return await fetchJsonWithTimeout(`${getApiBase()}/v1/local/gemini-cli/status`, {}, 7000);
      } catch (err) {
        return { ok: false, error: err && err.name === 'AbortError' ? 'Gemini CLI 状态检查超时' : err.message };
      }
    },
    applyGeminiCli: async () => {
      try {
        return await fetchJsonWithTimeout(getApiBase() + '/v1/local/gemini-cli/apply', { method: 'POST' }, 10000);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    restoreGeminiCli: async () => {
      try {
        return await fetchJsonWithTimeout(getApiBase() + '/v1/local/gemini-cli/restore', { method: 'POST' }, 10000);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
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
        const res = await fetch(getApiBase() + '/v1/local/auth/rate-limits?profileId=' + encodeURIComponent(profileId));
        return await res.json();
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    readAuditConversations: async (limit = 50) => {
      try {
        const res = await fetch(getApiBase() + '/v1/local/audit/conversations?limit=' + limit);
        return await res.json();
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    readUsageReport: async (options = {}) => {
      try {
        const params = new URLSearchParams();
        params.set('limit', String(options.limit || 300));
        if (options.after) params.set('after', options.after);
        const res = await fetch(getApiBase() + '/v1/local/usage/report?' + params.toString());
        return await res.json();
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    retryAuditRequest: async (id) => {
      try {
        const res = await fetch(getApiBase() + '/v1/local/audit/retry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        });
        return await res.json();
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    clearAuditConversations: async () => {
      try {
        const res = await fetch(getApiBase() + '/v1/local/audit/conversations/clear', { method: 'POST' });
        return await res.json();
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
      await invoke('applyAppMenu', { show });
    } catch (e) {
      console.error('Failed to apply app menu:', e);
    }
  };
  window.proxyManager.command = async (command) => {
    try {
      const res = await invoke('execute_proxy_command', { command });
      const out = (res.output || '').toLowerCase();
      return {
        code: res.code,
        output: res.output || '',
        ok: res.code === 0,
        message: res.output || '',
        running: out.includes('running') && !out.includes('not running')
      };
    } catch (e) {
      console.error('Proxy command failed:', e);
      return { code: -1, output: String(e), ok: false, error: String(e), message: String(e), running: false };
    }
  };
  window.proxyManager.launchCodexLoginScript = async (scriptPath) => {
    try {
      const res = await invoke('launch_codex_login_script', { scriptPath });
      return { ok: true, ...res };
    } catch (e) {
      console.error('Codex login script launch failed:', e);
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
}
