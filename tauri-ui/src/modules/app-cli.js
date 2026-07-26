import {
  $,
  CLI_SESSIONS_VISIBLE_MS,
  config,
  confirmAction,
  currentViewId,
  perfStart,
  showToast,
} from './app.js';
import { getApiBase } from './app-bridge.js';

let isLaunchingCli = false;
let cliSessionsTimer = null;
let cliSessionsRefreshInFlight = false;
let lastCliSessionsSignature = '';
let lastCliSessionsPollAt = 0;
let codeToolsInitialized = false;

function clearCliElement(element) {
  if (element) element.replaceChildren();
}

function createCliLaunchIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', '4 17 10 11 4 5');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', '12');
  line.setAttribute('x2', '20');
  line.setAttribute('y1', '19');
  line.setAttribute('y2', '19');
  svg.append(polyline, line);
  return svg;
}

function setCliLaunchButtonReady() {
  const button = $('cliLaunchBtn');
  button.disabled = false;
  button.replaceChildren(createCliLaunchIcon(), document.createTextNode(' 启动 CLI 助手'));
}

function isCodeToolsVisible() {
  return currentViewId === 'codeToolsView' && $('codeToolsView').classList.contains('active');
}

function pollCliSessions() {
  if (!isCodeToolsVisible()) return;
  if (document.hidden) return;
  const now = Date.now();
  if (now - lastCliSessionsPollAt < CLI_SESSIONS_VISIBLE_MS) return;
  lastCliSessionsPollAt = now;
  refreshCliSessions({ passive: true });
}

function startCliSessionsPolling() {
  refreshCliSessions({ force: true });
  if (cliSessionsTimer) clearInterval(cliSessionsTimer);
  lastCliSessionsPollAt = Date.now();
  cliSessionsTimer = setInterval(pollCliSessions, CLI_SESSIONS_VISIBLE_MS);
}

async function initCodeToolsView() {
  if (codeToolsInitialized) {
    startCliSessionsPolling();
    return;
  }
  codeToolsInitialized = true;

  // 1. 从 localStorage 加载配置预设
  let profiles = window.UX.storage.parseCliProfiles(
    localStorage.getItem('hpm_cli_profiles') || '[]'
  );

  if (!Array.isArray(profiles) || profiles.length === 0) {
    profiles = [
      {
        id: 'cli-prof-default',
        name: '默认配置预设',
        toolId: 'claude-code',
        model: 'default',
        customArgs: '',
        cwd: '',
        envs: '',
        terminal: 'PowerShell',
        upgrade: false,
      },
    ];
    localStorage.setItem('hpm_cli_profiles', JSON.stringify(profiles));
  }

  let activeId = localStorage.getItem('hpm_cli_active_profile_id');
  if (!activeId || !profiles.some((p) => p.id === activeId)) {
    activeId = profiles[0].id;
    localStorage.setItem('hpm_cli_active_profile_id', activeId);
  }
  let cliProfilesSaveTimer = null;
  let cliProfilesRenderFrame = 0;

  function persistCliProfilesNow() {
    if (cliProfilesSaveTimer) {
      clearTimeout(cliProfilesSaveTimer);
      cliProfilesSaveTimer = null;
    }
    profiles = window.UX.storage.normalizeCliProfiles(profiles);
    localStorage.setItem('hpm_cli_profiles', JSON.stringify(profiles));
  }

  function scheduleCliProfilesPersist() {
    if (cliProfilesSaveTimer) clearTimeout(cliProfilesSaveTimer);
    cliProfilesSaveTimer = setTimeout(() => {
      cliProfilesSaveTimer = null;
      profiles = window.UX.storage.normalizeCliProfiles(profiles);
      localStorage.setItem('hpm_cli_profiles', JSON.stringify(profiles));
    }, 300);
  }

  function scheduleCliProfilesListRender() {
    if (cliProfilesRenderFrame) return;
    cliProfilesRenderFrame = requestAnimationFrame(() => {
      cliProfilesRenderFrame = 0;
      renderCliProfilesList();
    });
  }

  // 2. 左侧配置预设列表渲染
  function renderCliProfilesList() {
    const listContainer = $('cliProfilesList');
    if (!listContainer.dataset.delegated) {
      listContainer.dataset.delegated = 'true';
      listContainer.onclick = (event) => {
        const item = event.target.closest('[data-profile-id]');
        if (!item || !listContainer.contains(item)) return;
        const nextId = item.dataset.profileId;
        if (!profiles.some((profile) => profile.id === nextId)) return;
        persistCliProfilesNow();
        activeId = nextId;
        localStorage.setItem('hpm_cli_active_profile_id', activeId);
        renderCliProfilesList();
        loadActiveProfileToForm();
      };
    }
    clearCliElement(listContainer);
    profiles.forEach((p) => {
      const item = document.createElement('div');
      item.className = 'tool-item' + (p.id === activeId ? ' selected' : '');
      item.dataset.profileId = p.id;

      let toolName = '未知工具';
      if (p.toolId === 'claude-code') toolName = 'Claude Code';
      else if (p.toolId === 'antigravity-cli') toolName = 'Antigravity CLI';
      else if (p.toolId === 'codex') toolName = 'Codex CLI';
      else if (p.toolId === 'opencode') toolName = 'OpenCode';
      else if (p.toolId === 'openclaw') toolName = 'OpenClaw';
      else if (p.toolId === 'hermes') toolName = 'Hermes';

      const info = document.createElement('div');
      info.className = 'tool-item-info';
      const title = document.createElement('span');
      title.className = 'tool-item-title';
      title.textContent = p.name || '';
      const desc = document.createElement('span');
      desc.className = 'tool-item-desc';
      desc.textContent = `${toolName} · ${p.model || ''}`;
      info.appendChild(title);
      info.appendChild(desc);
      item.appendChild(info);
      listContainer.appendChild(item);
    });
  }

  // 3. 将当前选中预设填充进表单
  function loadActiveProfileToForm() {
    const p = profiles.find((x) => x.id === activeId);
    if (!p) return;
    $('cliProfileNameInput').value = p.name || '';
    $('cliToolSelect').value = p.toolId || 'claude-code';
    $('cliModelSelect').value = p.model || 'default';
    $('cliCustomArgsInput').value = p.customArgs || '';
    $('cliCwdInput').value = p.cwd || '';
    $('cliEnvsInput').value = p.envs || '';
    $('cliTerminalSelect').value = p.terminal || 'PowerShell';
    $('cliUpgradeCheck').checked = !!p.upgrade;

    updateUpgradeCheckboxState();
  }

  // 4. 从表单实时同步回预设并持久化保存
  function saveCurrentProfileFromForm(options = {}) {
    const p = profiles.find((x) => x.id === activeId);
    if (!p) return;
    p.name = $('cliProfileNameInput').value.trim() || '未命名预设';
    p.toolId = $('cliToolSelect').value;
    p.model = $('cliModelSelect').value;
    p.customArgs = $('cliCustomArgsInput').value.trim();
    p.cwd = $('cliCwdInput').value.trim();
    p.envs = $('cliEnvsInput').value;
    p.terminal = $('cliTerminalSelect').value;
    p.upgrade = $('cliUpgradeCheck').checked;

    if (options.persistNow) {
      persistCliProfilesNow();
      renderCliProfilesList();
    } else {
      scheduleCliProfilesPersist();
      scheduleCliProfilesListRender();
    }
  }

  // 绑定表单输入事件以实现即时修改即时保存
  $('cliProfileNameInput').oninput = saveCurrentProfileFromForm;
  $('cliToolSelect').onchange = () => {
    saveCurrentProfileFromForm();
    updateUpgradeCheckboxState();
  };
  $('cliModelSelect').onchange = saveCurrentProfileFromForm;
  $('cliCustomArgsInput').oninput = saveCurrentProfileFromForm;
  $('cliCwdInput').oninput = saveCurrentProfileFromForm;
  $('cliEnvsInput').oninput = saveCurrentProfileFromForm;
  $('cliTerminalSelect').onchange = saveCurrentProfileFromForm;
  $('cliUpgradeCheck').onchange = saveCurrentProfileFromForm;

  // 5. 绑定左侧管理按钮事件
  $('cliAddProfileBtn').onclick = () => {
    const newId = 'cli-prof-' + Math.random().toString(36).substring(2, 10);
    const newProfile = {
      id: newId,
      name: '新配置预设',
      toolId: 'claude-code',
      model: 'default',
      customArgs: '',
      cwd: '',
      envs: '',
      terminal: 'PowerShell',
      upgrade: false,
    };
    profiles.push(newProfile);
    activeId = newId;
    persistCliProfilesNow();
    localStorage.setItem('hpm_cli_active_profile_id', activeId);
    renderCliProfilesList();
    loadActiveProfileToForm();
    $('cliProfileNameInput').focus();
    showToast('已创建新预设', 'success');
  };

  $('cliCopyProfileBtn').onclick = () => {
    const current = profiles.find((x) => x.id === activeId);
    if (!current) return;
    const newId = 'cli-prof-' + Math.random().toString(36).substring(2, 10);
    const copy = JSON.parse(JSON.stringify(current));
    copy.id = newId;
    copy.name = current.name + ' 副本';
    profiles.push(copy);
    activeId = newId;
    persistCliProfilesNow();
    localStorage.setItem('hpm_cli_active_profile_id', activeId);
    renderCliProfilesList();
    loadActiveProfileToForm();
    showToast('已复制预设', 'success');
  };

  $('cliDeleteProfileBtn').onclick = async () => {
    if (profiles.length <= 1) {
      showToast('必须要保留至少一个配置预设', 'error');
      return;
    }
    const idx = profiles.findIndex((x) => x.id === activeId);
    if (idx < 0) return;
    const confirmed = await confirmAction({
      title: '确认删除',
      message: `您确定要删除配置预设“${profiles[idx].name}”吗？`,
      confirmText: '删除',
    });
    if (!confirmed) return;
    profiles.splice(idx, 1);
    activeId = profiles[0].id;
    persistCliProfilesNow();
    localStorage.setItem('hpm_cli_active_profile_id', activeId);
    renderCliProfilesList();
    loadActiveProfileToForm();
    showToast('已删除配置预设', 'success');
  };

  // 6. 绑定文件夹选择与启动 CLI 按钮事件
  $('cliSelectFolderBtn').onclick = async () => {
    const button = $('cliSelectFolderBtn');
    button.disabled = true;
    try {
      let data;
      if (window.proxyManager && typeof window.proxyManager.selectDirectory === 'function') {
        data = await window.proxyManager.selectDirectory();
      } else {
        const res = await fetch(getApiBase() + '/v1/local/select-directory', { method: 'POST' });
        data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
      }
      if (!data || !data.ok) {
        throw new Error((data && data.error) || '未能打开文件夹选择器');
      }
      if (data.path) {
        $('cliCwdInput').value = data.path;
        saveCurrentProfileFromForm({ persistNow: true });
      } else if (data.cancelled) {
        showToast('已取消选择文件夹', 'info');
      }
    } catch (err) {
      showToast('选择文件夹出错: ' + err.message, 'error');
    } finally {
      button.disabled = false;
    }
  };

  $('cliLaunchBtn').onclick = async () => {
    if (isLaunchingCli) return;

    saveCurrentProfileFromForm({ persistNow: true });
    const current = profiles.find((x) => x.id === activeId);
    if (!current) return;

    isLaunchingCli = true;
    $('cliLaunchBtn').disabled = true;
    $('cliLaunchBtn').textContent = '正在启动...';

    try {
      const res = await fetch(getApiBase() + '/v1/local/cli/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolId: current.toolId,
          model: current.model,
          cwd: current.cwd,
          envs: current.envs,
          terminal: current.terminal,
          upgrade: current.upgrade,
          customArgs: current.customArgs,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        showToast('启动指令已下发，新控制台窗口已拉起！', 'success');
        setTimeout(() => refreshCliSessions({ force: true }), 800);
      } else {
        showToast('启动失败: ' + (data.error || '未知错误'), 'error');
      }
    } catch (err) {
      showToast('启动出错: ' + err.message, 'error');
    } finally {
      isLaunchingCli = false;
      setCliLaunchButtonReady();
    }
  };

  // 7. 动态拉取数据与初始化
  renderCliProfilesList();

  const checkEnvPromise = (async () => {
    try {
      const res = await fetch(getApiBase() + '/v1/local/env/check');
      const data = await res.json();
      if (data.ok && Array.isArray(data.tools)) {
        const select = $('cliToolSelect');
        clearCliElement(select);
        data.tools.forEach((t) => {
          const opt = document.createElement('option');
          opt.value = t.id;
          const isInstalled = !!t.current;
          opt.textContent = isInstalled ? `${t.name} (v${t.current})` : `${t.name} (未安装)`;
          opt.dataset.installed = isInstalled ? 'true' : 'false';
          select.appendChild(opt);
        });
        updateUpgradeCheckboxState();
      }
    } catch (err) {
      console.error('加载 CLI 状态失败:', err);
    }
  })();

  const loadConfigPromise = (async () => {
    try {
      const res = await fetch(getApiBase() + '/v1/local/config');
      const data = await res.json();
      if (data.ok || data.profiles) {
        const select = $('cliModelSelect');
        const modelsSet = new Set();

        // Always ensure 'default' is present
        modelsSet.add('default');

        const routesSource = (data && data.modelRoutes) || (config && config.modelRoutes) || [];
        if (Array.isArray(routesSource)) {
          routesSource.forEach((r) => {
            if (r && r.from) modelsSet.add(r.from);
          });
        }

        clearCliElement(select);
        modelsSet.forEach((m) => {
          const opt = document.createElement('option');
          opt.value = m;

          if (m === 'default') {
            opt.textContent = 'default | 默认上游 (不重定向)';
          } else {
            const route = routesSource.find((r) => r && r.from === m);
            if (route) {
              const profile =
                data.profiles && Array.isArray(data.profiles)
                  ? data.profiles.find((p) => p.id === route.profileId)
                  : null;
              const profileName = profile ? profile.name || profile.id : route.profileId;
              opt.textContent = `${m} | 路由到 ${profileName} -> ${route.to}`;
            } else {
              if (m === 'deepseek-v4-flash') {
                opt.textContent = 'deepseek-v4-flash | 深度求索 (推荐)';
              } else if (m === 'deepseek-chat') {
                opt.textContent = 'deepseek-chat | 深度求索';
              } else if (m === 'deepseek-reasoner') {
                opt.textContent = 'deepseek-reasoner | 深度求索 (R1)';
              } else if (m === 'gpt-4o') {
                opt.textContent = 'gpt-4o | OpenAI';
              } else if (m === 'gpt-4o-mini') {
                opt.textContent = 'gpt-4o-mini | OpenAI';
              } else if (m === 'claude-sonnet-4-6') {
                opt.textContent = 'claude-sonnet-4-6 | Anthropic';
              } else if (m === 'claude-haiku-4-5') {
                opt.textContent = 'claude-haiku-4-5 | Anthropic';
              } else if (m === 'gemini-2.5-flash') {
                opt.textContent = 'gemini-2.5-flash | Google';
              } else if (m === 'gemini-2.5-pro') {
                opt.textContent = 'gemini-2.5-pro | Google';
              } else {
                opt.textContent = m;
              }
            }
          }
          select.appendChild(opt);
        });
      }
    } catch (err) {
      console.error('加载模型配置失败:', err);
    }
  })();

  // Wait for both options lists to be populated, then apply active preset
  Promise.all([checkEnvPromise, loadConfigPromise]).then(() => {
    loadActiveProfileToForm();
  });

  // 8. 启动可视化活动会话轮询
  startCliSessionsPolling();
}

async function refreshCliSessions(options = {}) {
  if (cliSessionsRefreshInFlight) return;
  if (!options.force && !isCodeToolsVisible()) return;
  cliSessionsRefreshInFlight = true;
  const finishPerf = perfStart('refresh.cliSessions');
  let changed = false;
  let sessionCount = 0;
  try {
    const res = await fetch(getApiBase() + '/v1/local/cli/sessions');
    const data = await res.json();
    if (data.ok && Array.isArray(data.sessions)) {
      sessionCount = data.sessions.length;
      const tbody = $('cliSessionsTableBody');
      if (!tbody.dataset.delegated) {
        tbody.dataset.delegated = 'true';
        tbody.onclick = async (event) => {
          const button = event.target.closest('.delete-btn-soft[data-token]');
          if (!button || !tbody.contains(button)) return;
          const sessionToken = button.dataset.token;
          const confirmed = await confirmAction({
            title: '销毁会话',
            message:
              '您确定要注销此 CLI 会话吗？注销后该客户端发送的请求将不再被代理信任并被拒绝接管。',
            confirmText: '销毁',
          });
          if (!confirmed) return;
          try {
            const deleteRes = await fetch(getApiBase() + '/v1/local/cli/sessions/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionToken }),
            });
            const deleteData = await deleteRes.json();
            if (deleteData.ok) {
              showToast('会话已成功销毁', 'success');
              lastCliSessionsSignature = '';
              refreshCliSessions({ force: true });
            } else {
              showToast('销毁失败', 'error');
            }
          } catch (e) {
            showToast('注销请求出错: ' + e.message, 'error');
          }
        };
      }
      if (data.sessions.length === 0) {
        if (lastCliSessionsSignature !== 'empty') {
          clearCliElement(tbody);
          lastCliSessionsSignature = 'empty';
          changed = true;
        }
        $('cliNoSessionsTip').style.display = 'block';
        return;
      }
      $('cliNoSessionsTip').style.display = 'none';

      const now = Date.now();
      const rows = data.sessions.map((s) => {
        let relativeTime = '未活跃';
        if (s.lastUsedAt > 0) {
          const diffSec = Math.floor((now - s.lastUsedAt) / 1000);
          if (diffSec < 5) relativeTime = '刚刚';
          else if (diffSec < 60) relativeTime = `${Math.floor(diffSec / 5) * 5}秒前`;
          else if (diffSec < 3600) relativeTime = `${Math.floor(diffSec / 60)}分钟前`;
          else relativeTime = new Date(s.lastUsedAt).toLocaleTimeString();
        }

        const token = String(s.sessionToken || '');
        const requestCount = Number(s.requestCount || 0);
        return {
          signature: [
            token,
            s.toolName || '',
            s.modelOverride || '',
            requestCount,
            relativeTime,
          ].join('\u001f'),
          token,
          toolName: s.toolName || '',
          modelOverride: s.modelOverride || '',
          requestCount,
          relativeTime,
        };
      });
      const nextSignature = rows.map((row) => row.signature).join('\u001e');
      if (nextSignature === lastCliSessionsSignature) return;

      lastCliSessionsSignature = nextSignature;
      changed = true;
      clearCliElement(tbody);
      rows.forEach((row) => {
        const tr = document.createElement('tr');

        const toolCell = document.createElement('td');
        const toolName = document.createElement('strong');
        toolName.textContent = row.toolName;
        const tokenHint = document.createElement('div');
        tokenHint.className = 'muted';
        tokenHint.style.fontSize = '10px';
        tokenHint.textContent = `Token: ${row.token.substring(0, 15)}...`;
        toolCell.appendChild(toolName);
        toolCell.appendChild(tokenHint);

        const modelCell = document.createElement('td');
        const modelBadge = document.createElement('span');
        modelBadge.className = 'badge';
        modelBadge.style.background = 'var(--primary-soft)';
        modelBadge.style.color = 'var(--primary)';
        modelBadge.style.fontWeight = '500';
        modelBadge.style.borderColor = 'var(--border)';
        modelBadge.textContent = row.modelOverride;
        modelCell.appendChild(modelBadge);

        const countCell = document.createElement('td');
        const countBadge = document.createElement('span');
        countBadge.className = 'badge';
        countBadge.style.fontWeight = '600';
        countBadge.style.borderColor = 'var(--border)';
        countBadge.textContent = String(row.requestCount);
        countCell.appendChild(countBadge);

        const timeCell = document.createElement('td');
        timeCell.className = 'muted';
        timeCell.textContent = row.relativeTime;

        const actionCell = document.createElement('td');
        actionCell.style.textAlign = 'right';
        actionCell.style.paddingRight = '8px';
        const deleteButton = document.createElement('button');
        deleteButton.className = 'delete-btn-soft';
        deleteButton.dataset.token = row.token;
        deleteButton.textContent = '销毁';
        actionCell.appendChild(deleteButton);

        tr.appendChild(toolCell);
        tr.appendChild(modelCell);
        tr.appendChild(countCell);
        tr.appendChild(timeCell);
        tr.appendChild(actionCell);
        tbody.appendChild(tr);
      });
    }
  } catch (err) {
    console.error('刷新活动会话失败:', err);
  } finally {
    cliSessionsRefreshInFlight = false;
    finishPerf({
      passive: !!options.passive,
      force: !!options.force,
      changed,
      sessions: sessionCount,
    });
  }
}

function bindCliSessionControls() {
  const refreshBtn = $('cliRefreshSessionsBtn');
  if (refreshBtn && refreshBtn.dataset.cliBound !== 'true') {
    refreshBtn.dataset.cliBound = 'true';
    refreshBtn.onclick = () => refreshCliSessions({ force: true });
  }
}

function updateUpgradeCheckboxState() {
  const select = $('cliToolSelect');
  const selectedOpt = select.options[select.selectedIndex];
  if (selectedOpt && selectedOpt.dataset.installed === 'false') {
    $('cliUpgradeCheck').checked = true;
  }
}

function stopCodeToolsPolling() {
  if (cliSessionsTimer) {
    clearInterval(cliSessionsTimer);
    cliSessionsTimer = null;
  }
}

window.initCodeToolsView = initCodeToolsView;
window.stopCodeToolsPolling = stopCodeToolsPolling;

const sharedCliState = {
  get lastCliSessionsPollAt() {
    return lastCliSessionsPollAt;
  },
  set lastCliSessionsPollAt(value) {
    lastCliSessionsPollAt = value;
  },
};

export {
  bindCliSessionControls,
  cliSessionsTimer,
  isCodeToolsVisible,
  refreshCliSessions,
  sharedCliState,
};
