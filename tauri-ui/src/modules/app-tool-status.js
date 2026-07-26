import {
  $,
  CLAUDE_DESKTOP_PROCESS_VERIFICATION_PROMPT,
  STARTUP_STATUS_GRACE_MS,
  STARTUP_STATUS_RETRY_MS,
  checkProxyHealth,
  clearElement,
  config,
  ensureClaudeDesktop,
  perfStart,
  refreshCertStatusAfterProxyOnline,
  resolveClaudeDesktopModel,
  routeIdOfClaudeDesktopModel,
  sharedAppState,
  showDiagnosticsView,
  showToast,
  startupStatusStartedAt,
} from './app.js';
import { isMonitorVisible } from './app-diagnostics.js';

// Tool integration status and diagnostics UI.

function setProxyStatusElement(element, color, text) {
  clearElement(element);
  const dot = document.createElement('span');
  dot.className = `status-dot ${color}`;
  element.append(dot, document.createTextNode(text));
}

function isStartupStatusSettling(options = {}) {
  if (options.startup === false) return false;
  if (config && config.appSettings && config.appSettings.autoStartProxy === false) return false;
  return performance.now() - startupStatusStartedAt < STARTUP_STATUS_GRACE_MS;
}

function renderStartupPortDiagnostics() {
  const target = $('heroPortDiagnostics');
  if (target) target.textContent = '端口诊断：等待管理端口启动...';
}

function proxyStatusOutputLooksRunning(output) {
  const text = String(output || '');
  return (
    /\bRunning\b/i.test(text) ||
    /\bPID\s*:?\s*\d+\b/i.test(text) ||
    /Proxy already running/i.test(text) ||
    /Address:\s*https?:\/\//i.test(text)
  );
}

function proxyStatusPidFromOutput(output) {
  const match = String(output || '').match(/\bPID\s*:?\s*(\d+)\b/i);
  return match ? match[1] : '';
}

function scheduleStartupProxyRetry() {
  if (sharedAppState.startupProxyRetryTimer) return;
  sharedAppState.startupProxyRetryTimer = setTimeout(() => {
    sharedAppState.startupProxyRetryTimer = null;
    if (!isStartupStatusSettling({ startup: true })) return;
    sharedAppState.lastStatusRefresh = 0;
    refreshProxyStatus({ startup: true }).catch((err) =>
      console.error('startup refreshProxyStatus retry error:', err)
    );
  }, STARTUP_STATUS_RETRY_MS);
}

function deferStartupProxyFailure(statusElement) {
  setProxyStatusElement(statusElement, 'amber', '启动中...');
  renderStartupPortDiagnostics();
  scheduleStartupProxyRetry();
}

async function refreshProxyStatus(options = {}) {
  const now = Date.now();
  const passiveTtl = isMonitorVisible() ? 7000 : 30000;
  if (
    sharedAppState.statusRefreshInFlight ||
    (options.passive && now - sharedAppState.lastStatusRefresh < passiveTtl)
  )
    return;
  const finishPerf = perfStart('refresh.proxyStatus');
  sharedAppState.statusRefreshInFlight = true;
  sharedAppState.lastStatusRefresh = now;
  const statusElement = $('heroProxyStatus');
  try {
    const health = await checkProxyHealth();
    if (health) {
      const pid = health.pid ? ` (PID: ${health.pid})` : '';
      setProxyStatusElement(statusElement, 'green', `运行中${pid}`);
      renderPortDiagnostics(health);
      refreshCertStatusAfterProxyOnline(options);
      return;
    }

    const result = await window.proxyManager.command('status');
    const output = result.output || '';
    if (proxyStatusOutputLooksRunning(output)) {
      const pidValue = proxyStatusPidFromOutput(output);
      const pid = pidValue ? ` (PID: ${pidValue})` : '';
      setProxyStatusElement(statusElement, 'green', `运行中${pid}`);
      renderPortDiagnostics(null);
      refreshCertStatusAfterProxyOnline(options);
      return;
    }
    if (output.trim()) {
      if (isStartupStatusSettling(options)) {
        deferStartupProxyFailure(statusElement);
        return;
      }
      setProxyStatusElement(statusElement, 'amber', '未运行');
      renderPortDiagnostics(null);
      return;
    }
    if (isStartupStatusSettling(options)) {
      deferStartupProxyFailure(statusElement);
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
      refreshCertStatusAfterProxyOnline(options);
      return;
    }
    if (isStartupStatusSettling(options)) {
      deferStartupProxyFailure(statusElement);
      return;
    }
    setProxyStatusElement(statusElement, 'red', '检查失败');
    renderPortDiagnostics(null);
  } finally {
    sharedAppState.statusRefreshInFlight = false;
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
  const httpsCount = entries.filter((entry) => entry && entry.tls !== false).length;
  const httpCount = entries.filter((entry) => entry && entry.tls === false).length;
  const entryText =
    httpCount > 0
      ? `${httpsCount} 个 HTTPS 入口 + ${httpCount} 个 HTTP 备用入口在线`
      : `${httpsCount} 个入口在线`;
  const management = health.ports.management ? ` · 管理 ${health.ports.management}` : '';
  target.textContent = `端口诊断：${entryText}${management}`;
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

export {
  copyClaudeDesktopProcessPrompt,
  isStartupStatusSettling,
  lastTraeNativeDebugCommands,
  proxyStatusOutputLooksRunning,
  refreshAllToolStatuses,
  refreshAntigravityCliStatus,
  refreshClaudeCodeStatus,
  refreshClaudeDesktopStatus,
  refreshCodexDesktopStatus,
  refreshCodexStatus,
  refreshGeminiCliStatus,
  refreshProxyStatus,
  refreshTraeBridgeStatus,
  refreshTraeDebugEvents,
  refreshTraeNativeDeepDebug,
  saveTraeDebugSettingsFromUi,
  scanTraeNativeDebug,
  startTraeNativeDeepDebug,
  stopTraeNativeDeepDebug,
  testClaudeDesktopProcessOutput,
  testTraeClaudeProcessOutput,
};
