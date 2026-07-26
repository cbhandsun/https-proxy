import { bindDomainDependencies } from '../runtime/dependencies.js';

let diagnosticsDependencies;

export function configureDiagnostics(dependencies) {
  diagnosticsDependencies = bindDomainDependencies('diagnostics', dependencies, [
    '$',
    'LOG_AUTO_REFRESH_VISIBLE_MS',
    'LOG_RENDER_LINE_LIMIT',
    'LOG_REQUEST_MAX_BYTES',
    'MONITOR_RENDER_WINDOW',
    'MONITOR_SEARCH_BODY_LIMIT',
    'checkProxyHealth',
    'cliSessionsTimer',
    'confirmAction',
    'debounce',
    'ensureProxyRecovered',
    'hydrateConfigAfterStartup',
    'isCodeToolsVisible',
    'perfStart',
    'refreshCertStatus',
    'refreshCliSessions',
    'refreshProxyStatus',
    'sharedAppState',
    'sharedCliState',
    'showDiagnosticsTab',
    'showToast',
  ]);
}

function logLineClassName(line) {
  if (line.includes('-> ')) return 'info arrow';
  if (line.includes('ok ')) return 'info';
  if (line.includes('!! ')) return 'warn';
  if (line.includes('xx ')) return 'error';
  if (line.includes('[stdout]') || line.includes('[stderr]')) return 'muted';
  return '';
}

function createLogLineElement(line, className = logLineClassName(line)) {
  const span = document.createElement('span');
  span.className = `log-line ${className}`.trim();
  span.textContent = line;
  return span;
}

function createLogEmptyElement() {
  return createLogLineElement('暂无日志', 'muted');
}

function renderLogLines(target, text) {
  target.textContent = '';
  const lines = text ? text.split('\n').slice(-diagnosticsDependencies.LOG_RENDER_LINE_LIMIT) : [];
  if (!lines.length) {
    target.appendChild(createLogEmptyElement());
    return;
  }
  lines.forEach((line) => target.appendChild(createLogLineElement(line)));
}

function startHeartbeat() {
  if (diagnosticsDependencies.sharedAppState.heartbeatTimer)
    clearInterval(diagnosticsDependencies.sharedAppState.heartbeatTimer);
  diagnosticsDependencies.sharedAppState.heartbeatTimer = setInterval(
    async () => {
      if (isMonitorVisible()) {
        await Promise.allSettled([
          diagnosticsDependencies.refreshProxyStatus({ passive: true }),
          refreshMonitor({ passive: true }),
        ]);
      } else {
        await diagnosticsDependencies.refreshProxyStatus({ passive: true });
      }
      await diagnosticsDependencies.ensureProxyRecovered({ passive: true });
      // If the initial loadConfig() raced with the bundled proxy coming
      // up (Tauri launches the proxy on a background thread and the
      // page can render before 3543 is listening) the config we have
      // is still the empty fallback. Now that the heartbeat is talking
      // to the proxy, ask for a fresh config. hydrateConfigAfterStartup
      // no-ops once config is real, so this is safe to call every tick.
      if (
        typeof diagnosticsDependencies.hydrateConfigAfterStartup === 'function' &&
        typeof diagnosticsDependencies.checkProxyHealth === 'function'
      ) {
        try {
          const health = await diagnosticsDependencies.checkProxyHealth();
          if (health) {
            diagnosticsDependencies
              .hydrateConfigAfterStartup()
              .catch((e) => console.error('hydrateConfigAfterStartup in heartbeat:', e));
            // 同样的冷启动问题也会让首次证书检查超时。等代理真正
            // 起来后再被动拉一次,refreshCertStatus 的 catch 分支
            // 不会写 lastCertRefresh,所以这次调用不会被 60s 节流。
            if (typeof diagnosticsDependencies.refreshCertStatus === 'function') {
              diagnosticsDependencies
                .refreshCertStatus({ passive: true })
                .catch((e) => console.error('refreshCertStatus in heartbeat:', e));
            }
          }
        } catch (e) {
          console.error('heartbeat health probe for hydrate:', e);
        }
      }
    },
    document.hidden ? 60000 : isMonitorVisible() ? 8000 : 30000
  );
}

document.addEventListener('visibilitychange', () => {
  if (typeof diagnosticsDependencies.$ !== 'function') return;
  startHeartbeat();
  if (document.hidden) return;
  if (
    diagnosticsDependencies.$('autoRefreshLog') &&
    diagnosticsDependencies.$('autoRefreshLog').checked
  ) {
    diagnosticsDependencies.sharedAppState.lastLogAutoRefreshAt = 0;
    refreshActiveDiagnosticsPanel({ passive: true, forceScroll: true });
  }
  if (diagnosticsDependencies.cliSessionsTimer && diagnosticsDependencies.isCodeToolsVisible()) {
    diagnosticsDependencies.sharedCliState.lastCliSessionsPollAt = 0;
    diagnosticsDependencies.refreshCliSessions({ passive: true, force: true });
  }
});

function isMonitorVisible() {
  return diagnosticsDependencies.$('monitor').classList.contains('active');
}

function getViewDomCache() {
  if (!diagnosticsDependencies.sharedAppState.viewDomCache) {
    diagnosticsDependencies.sharedAppState.viewDomCache = {
      buttons: Array.from(document.querySelectorAll('[data-view-button]')),
      views: Array.from(document.querySelectorAll('.view')),
    };
  }
  return diagnosticsDependencies.sharedAppState.viewDomCache;
}

async function refreshMonitor(options = {}) {
  if (diagnosticsDependencies.sharedAppState.monitorRefreshInFlight) return;
  diagnosticsDependencies.sharedAppState.monitorRefreshInFlight = true;
  const finishPerf = diagnosticsDependencies.perfStart('refresh.monitor');
  try {
    const events = await window.proxyManager.readEvents({
      limit: diagnosticsDependencies.sharedAppState.lastEventTime ? 200 : 300,
      after: diagnosticsDependencies.sharedAppState.lastEventTime || '',
    });
    if (!events || events.length === 0) {
      if (diagnosticsDependencies.sharedAppState.monitorEvents.length === 0) {
        const container = diagnosticsDependencies.$('monitorList');
        container.textContent = '';
        container.appendChild(createMonitorEmptyElement('暂无请求记录...'));
      }
      return;
    }

    const preparedEvents = events.map(prepareMonitorEvent);
    diagnosticsDependencies.sharedAppState.monitorEvents = (
      diagnosticsDependencies.sharedAppState.lastEventTime
        ? diagnosticsDependencies.sharedAppState.monitorEvents.concat(preparedEvents)
        : preparedEvents
    ).slice(-500);
    diagnosticsDependencies.sharedAppState.lastEventTime =
      diagnosticsDependencies.sharedAppState.monitorEvents[
        diagnosticsDependencies.sharedAppState.monitorEvents.length - 1
      ].time;
    renderMonitor();
  } catch (err) {
    console.error('Failed to refresh monitor:', err);
  } finally {
    diagnosticsDependencies.sharedAppState.monitorRefreshInFlight = false;
    finishPerf({
      passive: !!options.passive,
      events: diagnosticsDependencies.sharedAppState.monitorEvents.length,
    });
  }
}

function prepareMonitorEvent(event) {
  if (!event) return event;
  if (event.__searchText && event.__monitorView) return event;
  const fieldsToSearch = [
    event.method,
    event.path,
    event.sourceModel,
    event.targetModel,
    event.error,
    event.reqId,
    event.profileName,
    event.statusCode,
    event.code,
    event.protocol,
  ];
  if (event.body)
    fieldsToSearch.push(
      String(event.body).slice(0, diagnosticsDependencies.MONITOR_SEARCH_BODY_LIMIT)
    );
  event.__searchText = fieldsToSearch.filter(Boolean).join(' ').toLowerCase();
  let title = '';
  let details = '';
  let badgeClass = 'protocol';
  let levelClass = '';

  if (event.kind === 'request_start') {
    title = `${event.method} ${event.path}`;
    details = `Client: ${event.clientIp}${event.reqId ? ` | Req: ${event.reqId}` : ''}`;
  } else if (event.kind === 'route') {
    title = `Route: ${event.sourceModel} → ${event.targetModel}`;
    const contextInfo = event.estimatedContextTokens
      ? ` | Context: ${event.estimatedContextTokens}tok`
      : '';
    details = `Profile: ${event.profileName} (${event.protocol})${contextInfo}`;
    badgeClass = 'active';
  } else if (event.kind === 'request_end') {
    title = `${event.method} ${event.path} -> ${event.statusCode}`;
    details = `Elapsed: ${event.elapsed}ms${event.reqId ? ` | Req: ${event.reqId}` : ''}${event.type ? ` | Type: ${event.type}` : ''}${event.usage ? ` | Tokens: ${event.usage.input_tokens}+${event.usage.output_tokens}` : ''}`;
    if (event.statusCode >= 400) levelClass = 'error';
    else if (event.statusCode >= 200) levelClass = 'success';
  } else if (event.kind === 'upstream_error' || event.kind === 'proxy_error') {
    title = `ERROR: ${event.kind === 'proxy_error' ? event.error : event.code + ' ' + (event.body || '')}`;
    details = `${event.method} ${event.path}`;
    levelClass = 'error';
  }

  event.__monitorView = {
    title,
    details,
    badgeClass,
    levelClass,
    time: new Date(event.time).toLocaleTimeString(),
  };
  return event;
}

function monitorBorderColor(levelClass) {
  if (levelClass === 'error') return 'var(--danger)';
  if (levelClass === 'success') return '#10b981';
  return 'var(--border)';
}

function createMonitorEmptyElement(text) {
  const empty = document.createElement('div');
  empty.className = 'muted';
  empty.textContent = text;
  return empty;
}

function createMonitorSummaryElement(visibleCount, omittedCount) {
  const summary = document.createElement('div');
  summary.className = 'muted';
  summary.style.fontSize = '11px';
  summary.style.padding = '0 2px';
  summary.textContent = `显示最新 ${visibleCount} 条，已隐藏较早 ${omittedCount} 条匹配记录`;
  return summary;
}

function createMonitorEventElement(event) {
  const view = event.__monitorView || prepareMonitorEvent(event).__monitorView;
  const { title, details, badgeClass, levelClass, time } = view;
  const item = document.createElement('div');
  item.className = 'profile';
  item.style.cursor = 'default';
  item.style.padding = '10px';
  item.style.borderLeft = `4px solid ${monitorBorderColor(levelClass)}`;

  const header = document.createElement('div');
  header.className = 'profile-title';
  const strong = document.createElement('strong');
  strong.style.fontSize = '13px';
  strong.textContent = title;
  const badge = document.createElement('span');
  badge.className = `badge ${badgeClass}`;
  badge.textContent = time;
  header.appendChild(strong);
  header.appendChild(badge);

  const detail = document.createElement('div');
  detail.className = 'muted';
  detail.style.marginTop = '4px';
  detail.textContent = details;

  item.appendChild(header);
  item.appendChild(detail);
  return item;
}

function renderMonitor() {
  const container = diagnosticsDependencies.$('monitorList');
  const shouldScroll = diagnosticsDependencies.$('autoScrollMonitor').checked;
  const query = (diagnosticsDependencies.$('monitorSearch').value || '').toLowerCase().trim();
  const statusFilter = diagnosticsDependencies.$('monitorStatusFilter').value;

  let filteredEvents = diagnosticsDependencies.sharedAppState.monitorEvents;

  if (query || statusFilter !== 'all') {
    filteredEvents = diagnosticsDependencies.sharedAppState.monitorEvents.filter((event) => {
      // Status filter
      if (statusFilter === 'success') {
        if (event.kind === 'request_end' && (event.statusCode < 200 || event.statusCode >= 300))
          return false;
        if (event.kind !== 'request_end') return false;
      } else if (statusFilter === 'error') {
        if (event.kind === 'upstream_error' || event.kind === 'proxy_error') {
          // matched
        } else if (event.kind === 'request_end' && event.statusCode >= 400) {
          // matched
        } else {
          return false;
        }
      } else if (statusFilter === 'route') {
        if (event.kind !== 'route') return false;
      }

      if (query) {
        const searchText = event.__searchText || prepareMonitorEvent(event).__searchText || '';
        if (!searchText.includes(query)) return false;
      }

      return true;
    });
  }

  const visibleEvents = filteredEvents
    .slice(-diagnosticsDependencies.MONITOR_RENDER_WINDOW)
    .reverse();
  const omittedEvents = Math.max(0, filteredEvents.length - visibleEvents.length);
  const viewModels = visibleEvents.map(
    (event) => event.__monitorView || prepareMonitorEvent(event).__monitorView
  );
  const renderSignature = JSON.stringify({
    omittedEvents,
    visibleEvents: viewModels,
  });
  if (renderSignature === diagnosticsDependencies.sharedAppState.lastRenderedMonitorHtml) return;
  diagnosticsDependencies.sharedAppState.lastRenderedMonitorHtml = renderSignature;
  container.textContent = '';
  if (omittedEvents)
    container.appendChild(createMonitorSummaryElement(visibleEvents.length, omittedEvents));
  if (visibleEvents.length) {
    visibleEvents.forEach((event) => container.appendChild(createMonitorEventElement(event)));
  } else {
    container.appendChild(createMonitorEmptyElement('暂无符合条件的请求记录...'));
  }

  if (shouldScroll) {
    container.scrollTop = container.scrollHeight;
  }
}

if (typeof window !== 'undefined') {
  window.__diagnosticsTest = {
    createLogLineElement,
    logLineClassName,
    renderLogLines,
    createMonitorEventElement,
    prepareMonitorEvent,
    renderMonitor,
  };
}

function bindDiagnosticsControls() {
  const clearMonBtn = diagnosticsDependencies.$('clearMonitor');
  if (clearMonBtn && clearMonBtn.dataset.monitorBound !== 'true') {
    clearMonBtn.dataset.monitorBound = 'true';
    clearMonBtn.onclick = async () => {
      await window.proxyManager.clearEvents();
      diagnosticsDependencies.sharedAppState.monitorEvents = [];
      diagnosticsDependencies.sharedAppState.lastEventTime = null;
      diagnosticsDependencies.sharedAppState.lastRenderedMonitorHtml = null;
      renderMonitor();
      diagnosticsDependencies.showToast('监控已清空');
    };
  }

  diagnosticsDependencies.$('refreshLog').onclick = () => {
    diagnosticsDependencies.showDiagnosticsTab('logPanel');
  };
  diagnosticsDependencies.$('refreshLog').dataset.bound = 'true';
  diagnosticsDependencies.$('refreshDiagnostics').onclick = async () => {
    diagnosticsDependencies.showDiagnosticsTab('diagnosticsPanel');
  };
  diagnosticsDependencies.$('refreshDiagnostics').dataset.bound = 'true';
  diagnosticsDependencies.$('scrollLogBottom').onclick = () => {
    if (diagnosticsDependencies.$('diagnosticsPanel').classList.contains('active'))
      scrollLogToBottom('diagnosticsOutput');
    else {
      diagnosticsDependencies.showDiagnosticsTab('logPanel');
      scrollLogToBottom('log');
    }
  };
  diagnosticsDependencies.$('scrollLogBottom').dataset.bound = 'true';
  diagnosticsDependencies.$('clearLog').onclick = clearLog;
  diagnosticsDependencies.$('clearLog').dataset.bound = 'true';
  diagnosticsDependencies.$('clearDiagnostics').onclick = clearDiagnostics;
  diagnosticsDependencies.$('clearDiagnostics').dataset.bound = 'true';

  diagnosticsDependencies.$('autoRefreshLog').onchange = () => {
    setLogAutoRefresh(diagnosticsDependencies.$('autoRefreshLog').checked);
    if (diagnosticsDependencies.$('autoRefreshLog').checked) {
      if (diagnosticsDependencies.$('logPanel').classList.contains('active'))
        refreshLog({ forceScroll: true });
      if (diagnosticsDependencies.$('diagnosticsPanel').classList.contains('active'))
        refreshDiagnostics({ forceScroll: true });
    }
  };
  diagnosticsDependencies.$('autoRefreshLog').dataset.bound = 'true';
  diagnosticsDependencies.$('autoScrollLog').onchange = () => {
    if (diagnosticsDependencies.$('autoScrollLog').checked) {
      if (diagnosticsDependencies.$('logPanel').classList.contains('active'))
        scrollLogToBottom('log');
      if (diagnosticsDependencies.$('diagnosticsPanel').classList.contains('active'))
        scrollLogToBottom('diagnosticsOutput');
    }
  };
  diagnosticsDependencies.$('autoScrollLog').dataset.bound = 'true';
  setLogAutoRefresh(diagnosticsDependencies.$('autoRefreshLog').checked);

  document.querySelectorAll('[data-diagnostics-tab]').forEach((button) => {
    button.onclick = () =>
      diagnosticsDependencies.showDiagnosticsTab(button.dataset.diagnosticsTab);
    button.dataset.bound = 'true';
  });

  diagnosticsDependencies.$('monitorSearch').oninput = diagnosticsDependencies.debounce(
    renderMonitor,
    180
  );
  diagnosticsDependencies.$('monitorSearch').dataset.bound = 'true';
  diagnosticsDependencies.$('monitorStatusFilter').onchange = renderMonitor;
  diagnosticsDependencies.$('monitorStatusFilter').dataset.bound = 'true';
}

function scrollLogToBottom(targetId = 'log') {
  const log = diagnosticsDependencies.$(targetId);
  requestAnimationFrame(() => {
    log.scrollTop = log.scrollHeight;
  });
}

function isNearBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 40;
}

function isDiagnosticsVisible() {
  return diagnosticsDependencies.$('diagnostics').classList.contains('active');
}

async function refreshLog(options = {}) {
  if (diagnosticsDependencies.sharedAppState.logRefreshInFlight) return;
  diagnosticsDependencies.sharedAppState.logRefreshInFlight = true;
  const log = diagnosticsDependencies.$('log');
  const shouldKeepBottom =
    options.forceScroll ||
    (diagnosticsDependencies.$('autoScrollLog') &&
      diagnosticsDependencies.$('autoScrollLog').checked) ||
    isNearBottom(log);
  const finishPerf = diagnosticsDependencies.perfStart('refresh.log');
  let changed = false;
  let rawLog = '';
  try {
    if (!options.passive) diagnosticsDependencies.$('logRefreshState').textContent = '刷新中...';
    rawLog = await window.proxyManager.readLog({
      lines: diagnosticsDependencies.LOG_RENDER_LINE_LIMIT,
      maxBytes: diagnosticsDependencies.LOG_REQUEST_MAX_BYTES,
    });
    if (rawLog !== diagnosticsDependencies.sharedAppState.lastRenderedLog || options.forceRender) {
      renderLogLines(log, rawLog);
      diagnosticsDependencies.sharedAppState.lastRenderedLog = rawLog;
      changed = true;
    }
    if (!options.passive || changed)
      diagnosticsDependencies.$('logRefreshState').textContent =
        '已刷新 ' + new Date().toLocaleTimeString();
    if (shouldKeepBottom && changed) scrollLogToBottom('log');
  } catch (err) {
    diagnosticsDependencies.$('logRefreshState').textContent = '刷新失败';
  } finally {
    diagnosticsDependencies.sharedAppState.logRefreshInFlight = false;
    finishPerf({ passive: !!options.passive, changed, bytes: rawLog.length });
  }
}

function renderDiagnosticsStatus(status) {
  if (!status || !status.config) return '诊断状态不可用';
  const config = status.config;
  const files = (status.files || [])
    .map((item) => `${item.label}:${item.exists ? item.bytes + 'B' : '无'}`)
    .join(' / ');
  return `enabled=${config.enabled}，Gemini=${config.captureGemini}，OpenAI=${config.captureOpenAI}，outbound=${config.captureOutboundSse}，requestTools=${config.captureRequestToolResults}\n${files}`;
}

async function refreshDiagnostics(options = {}) {
  if (diagnosticsDependencies.sharedAppState.diagnosticsRefreshInFlight) return;
  diagnosticsDependencies.sharedAppState.diagnosticsRefreshInFlight = true;
  const output = diagnosticsDependencies.$('diagnosticsOutput');
  const shouldKeepBottom =
    options.forceScroll ||
    (diagnosticsDependencies.$('autoScrollLog') &&
      diagnosticsDependencies.$('autoScrollLog').checked) ||
    isNearBottom(output);
  const finishPerf = diagnosticsDependencies.perfStart('refresh.diagnostics');
  let changed = false;
  let outputText = '';
  try {
    if (!options.passive)
      diagnosticsDependencies.$('diagnosticsRefreshState').textContent = '刷新中...';
    const result = await window.proxyManager.readDiagnostics();
    const statusText = renderDiagnosticsStatus(result.status);
    outputText = result.output || '暂无诊断事件';
    if (
      statusText !== diagnosticsDependencies.sharedAppState.lastRenderedDiagnosticsStatus ||
      options.forceRender
    ) {
      diagnosticsDependencies.$('diagnosticsStatus').textContent = statusText;
      diagnosticsDependencies.sharedAppState.lastRenderedDiagnosticsStatus = statusText;
      changed = true;
    }
    if (
      outputText !== diagnosticsDependencies.sharedAppState.lastRenderedDiagnosticsOutput ||
      options.forceRender
    ) {
      output.textContent = outputText;
      diagnosticsDependencies.sharedAppState.lastRenderedDiagnosticsOutput = outputText;
      changed = true;
    }
    if (!options.passive || changed)
      diagnosticsDependencies.$('diagnosticsRefreshState').textContent =
        '已刷新 ' + new Date().toLocaleTimeString();
    if (shouldKeepBottom && changed) scrollLogToBottom('diagnosticsOutput');
  } catch (err) {
    diagnosticsDependencies.$('diagnosticsRefreshState').textContent = '刷新失败';
  } finally {
    diagnosticsDependencies.sharedAppState.diagnosticsRefreshInFlight = false;
    finishPerf({ passive: !!options.passive, changed, bytes: outputText.length });
  }
}
function refreshActiveDiagnosticsPanel(options = {}) {
  if (!isDiagnosticsVisible()) return;
  if (diagnosticsDependencies.$('logPanel').classList.contains('active')) refreshLog(options);
  if (diagnosticsDependencies.$('diagnosticsPanel').classList.contains('active'))
    refreshDiagnostics(options);
}
function setLogAutoRefresh(enabled) {
  if (diagnosticsDependencies.sharedAppState.logRefreshTimer) {
    clearInterval(diagnosticsDependencies.sharedAppState.logRefreshTimer);
    diagnosticsDependencies.sharedAppState.logRefreshTimer = null;
  }
  if (!enabled) return;
  diagnosticsDependencies.sharedAppState.lastLogAutoRefreshAt = 0;
  diagnosticsDependencies.sharedAppState.logRefreshTimer = setInterval(() => {
    if (!isDiagnosticsVisible()) return;
    if (document.hidden) return;
    const now = Date.now();
    if (
      now - diagnosticsDependencies.sharedAppState.lastLogAutoRefreshAt <
      diagnosticsDependencies.LOG_AUTO_REFRESH_VISIBLE_MS
    )
      return;
    diagnosticsDependencies.sharedAppState.lastLogAutoRefreshAt = now;
    refreshActiveDiagnosticsPanel({ passive: true });
  }, diagnosticsDependencies.LOG_AUTO_REFRESH_VISIBLE_MS);
}

async function clearLog() {
  const confirmed = await diagnosticsDependencies.confirmAction({
    title: '清理日志？',
    message: '这会直接清空当前代理日志文件，不再生成备份。',
    confirmText: '清理日志',
  });
  if (!confirmed) return;
  const result = await window.proxyManager.clearLog();
  diagnosticsDependencies.$('output').textContent =
    result.output || (result.ok ? '日志已清理' : '日志清理失败');
  diagnosticsDependencies.showDiagnosticsTab('logPanel');
  diagnosticsDependencies.showToast(
    diagnosticsDependencies.$('output').textContent,
    result.ok ? 'success' : 'error'
  );
  await refreshLog({ forceScroll: true });
}

async function clearDiagnostics() {
  const confirmed = await diagnosticsDependencies.confirmAction({
    title: '清理诊断事件？',
    message: '这会直接清空当前诊断采样文件，不再生成备份。',
    confirmText: '清理诊断',
  });
  if (!confirmed) return;
  const result = await window.proxyManager.clearDiagnostics();
  const msg = result.output || (result.ok ? '诊断事件已清理' : '诊断事件清理失败');
  diagnosticsDependencies.$('output').textContent = msg;
  diagnosticsDependencies.showDiagnosticsTab('diagnosticsPanel');
  diagnosticsDependencies.showToast(msg, result.ok ? 'success' : 'error');
  await refreshDiagnostics({ forceScroll: true });
}

export {
  bindDiagnosticsControls,
  getViewDomCache,
  isMonitorVisible,
  refreshDiagnostics,
  refreshLog,
  refreshMonitor,
  startHeartbeat,
};
