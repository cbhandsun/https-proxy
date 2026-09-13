import { bindDomainDependencies } from '../runtime/dependencies.js';
import { reportFrontendError } from '../runtime/frontend-errors.js';

let diagnosticsDependencies;

export function configureDiagnostics(dependencies) {
  diagnosticsDependencies = bindDomainDependencies('diagnostics', dependencies, [
    '$',
    'LOG_AUTO_REFRESH_VISIBLE_MS',
    'LOG_RENDER_LINE_LIMIT',
    'LOG_REQUEST_MAX_BYTES',
    'MONITOR_RENDER_WINDOW',
    'MONITOR_SEARCH_BODY_LIMIT',
    'aggregateMonitorEvents',
    'buildMonitorExportPayload',
    'checkProxyHealth',
    'classifyLatency',
    'cliSessionsTimer',
    'confirmAction',
    'config',
    'debounce',
    'exportTimestamp',
    'ensureProxyRecovered',
    'filterMonitorGroups',
    'formatElapsedMs',
    'hydrateConfigAfterStartup',
    'isCodeToolsVisible',
    'monitorGroupStatusLabel',
    'newestWindow',
    'pageSize',
    'perfStart',
    'refreshCertStatus',
    'refreshCliSessions',
    'refreshProxyStatus',
    'sanitizeExportFileName',
    'sharedAppState',
    'sharedCliState',
    'showDiagnosticsTab',
    'showToast',
    'storage',
  ]);
}

const EXTERNAL_INGRESS_STORAGE_KEY = 'hpm_external_ingress_url';

function syncExternalIngressUrl() {
  const input = diagnosticsDependencies.$('externalIngressUrl');
  if (!input || input.value) return;
  const stored = diagnosticsDependencies.storage.getItem(EXTERNAL_INGRESS_STORAGE_KEY);
  const configured =
    diagnosticsDependencies.config && diagnosticsDependencies.config.diagnostics
      ? diagnosticsDependencies.config.diagnostics.externalIngressUrl
      : '';
  input.value = String(stored || configured || '');
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
      // Configuration recovery must not depend on a successful health probe.
      // The controller deduplicates requests from heartbeat and manual retry.
      if (typeof diagnosticsDependencies.hydrateConfigAfterStartup === 'function') {
        diagnosticsDependencies
          .hydrateConfigAfterStartup()
          .catch((error) => reportFrontendError('heartbeat.hydrate_config', error));
      }
      if (isMonitorVisible()) {
        await Promise.allSettled([
          diagnosticsDependencies.refreshProxyStatus({ passive: true }),
          refreshMonitor({ passive: true }),
        ]);
      } else {
        await diagnosticsDependencies.refreshProxyStatus({ passive: true });
      }
      await diagnosticsDependencies.ensureProxyRecovered({ passive: true });
      if (typeof diagnosticsDependencies.checkProxyHealth === 'function') {
        try {
          const health = await diagnosticsDependencies.checkProxyHealth();
          if (health) {
            // 同样的冷启动问题也会让首次证书检查超时。等代理真正
            // 起来后再被动拉一次,refreshCertStatus 的 catch 分支
            // 不会写 lastCertRefresh,所以这次调用不会被 60s 节流。
            if (typeof diagnosticsDependencies.refreshCertStatus === 'function') {
              diagnosticsDependencies
                .refreshCertStatus({ passive: true })
                .catch((e) => reportFrontendError('heartbeat.refresh_certificate', e));
            }
          }
        } catch (e) {
          reportFrontendError('heartbeat.health_probe', e);
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
  if (diagnosticsDependencies.sharedAppState.monitorPaused) return;
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
    reportFrontendError('monitor.refresh', err);
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

function monitorGroupTitle(group) {
  const method = String(group.method || 'REQUEST').trim();
  const path = String(group.path || '').trim() || '(unknown path)';
  const status = group.statusCode == null ? '' : ` -> ${group.statusCode}`;
  return `${method} ${path}${status}`;
}

function monitorGroupDetails(group) {
  const parts = [];
  if (group.profileName) parts.push(`Profile: ${group.profileName}`);
  if (group.protocol) parts.push(`Protocol: ${group.protocol}`);
  if (group.elapsed != null)
    parts.push(`Elapsed: ${diagnosticsDependencies.formatElapsedMs(group.elapsed)}`);
  if (group.sourceModel || group.targetModel) {
    parts.push(`Model: ${group.sourceModel || '-'} -> ${group.targetModel || '-'}`);
  }
  if (group.reqId) parts.push(`Req: ${group.reqId}`);
  if (group.clientIp) parts.push(`Client: ${group.clientIp}`);
  if (group.error) parts.push(`Error: ${group.error}`);
  if (group.events.length > 1) parts.push(`${group.events.length} 条 lifecycle 事件`);
  return parts.join(' | ');
}

function monitorGroupBorderColor(group) {
  if (group.level === 'error') return 'var(--danger)';
  if (group.level === 'success') return '#10b981';
  return 'var(--border)';
}

function createMonitorGroupElement(group) {
  const item = document.createElement('div');
  item.className = 'profile monitor-request';
  item.style.cursor = 'pointer';
  item.style.padding = '10px';
  item.style.borderLeft = `4px solid ${monitorGroupBorderColor(group)}`;
  if (group.groupKey) item.dataset.monitorGroup = group.groupKey;

  const header = document.createElement('div');
  header.className = 'profile-title';
  const strong = document.createElement('strong');
  strong.style.fontSize = '13px';
  strong.textContent = monitorGroupTitle(group);
  header.appendChild(strong);

  const badge = document.createElement('span');
  badge.className = `badge ${group.level === 'error' ? 'error' : group.level === 'success' ? 'active' : 'protocol'}`;
  badge.textContent = diagnosticsDependencies.monitorGroupStatusLabel(group);
  header.appendChild(badge);

  if (group.elapsed != null) {
    const latency = document.createElement('span');
    latency.className = 'badge';
    const level = diagnosticsDependencies.classifyLatency(group.elapsed);
    latency.textContent = `${diagnosticsDependencies.formatElapsedMs(group.elapsed)}${latencySuffix(level)}`;
    if (level === 'slow' || level === 'very-slow') latency.classList.add('error');
    header.appendChild(latency);
  }

  const detail = document.createElement('div');
  detail.className = 'muted';
  detail.style.marginTop = '4px';
  detail.textContent = monitorGroupDetails(group);

  item.appendChild(header);
  item.appendChild(detail);

  const lifecycle = document.createElement('div');
  lifecycle.className = 'monitor-lifecycle';
  lifecycle.hidden = true;
  group.events.forEach((event) => lifecycle.appendChild(createMonitorEventElement(event)));
  item.appendChild(lifecycle);

  item.onclick = () => {
    lifecycle.hidden = !lifecycle.hidden;
  };
  return item;
}

function latencySuffix(level) {
  if (level === 'very-slow') return ' 极慢';
  if (level === 'slow') return ' 偏慢';
  return '';
}

function currentMonitorGroups() {
  const query = diagnosticsDependencies.$('monitorSearch').value || '';
  const status = diagnosticsDependencies.$('monitorStatusFilter').value || 'all';
  const range = diagnosticsDependencies.$('monitorRangeFilter')
    ? diagnosticsDependencies.$('monitorRangeFilter').value
    : 'all';
  const groups = diagnosticsDependencies.aggregateMonitorEvents(
    diagnosticsDependencies.sharedAppState.monitorEvents
  );
  return diagnosticsDependencies.filterMonitorGroups(groups, { query, status, range });
}

function monitorVisibleLimit() {
  return diagnosticsDependencies.pageSize(
    diagnosticsDependencies.sharedAppState.monitorVisibleCount,
    diagnosticsDependencies.MONITOR_RENDER_WINDOW,
    diagnosticsDependencies.MONITOR_RENDER_WINDOW * 10
  );
}

function syncMonitorToolbar(summary, omitted) {
  const summaryEl = diagnosticsDependencies.$('monitorStatusSummary');
  if (summaryEl) summaryEl.textContent = summary;
  const loadMore = diagnosticsDependencies.$('monitorLoadMore');
  if (loadMore) loadMore.hidden = omitted <= 0;
}

function renderMonitor() {
  const container = diagnosticsDependencies.$('monitorList');
  if (!container) return;
  const shouldScroll = diagnosticsDependencies.$('autoScrollMonitor').checked;
  const filteredGroups = currentMonitorGroups();
  const limit = monitorVisibleLimit();
  const windowed = diagnosticsDependencies.newestWindow(filteredGroups, limit).reverse();
  const omitted = Math.max(0, filteredGroups.length - windowed.length);
  syncMonitorToolbar(
    filteredGroups.length === 0
      ? '暂无符合条件的请求'
      : `共 ${filteredGroups.length} 个请求，显示最新 ${windowed.length} 个`,
    omitted
  );

  const renderSignature = JSON.stringify({
    omitted,
    groups: windowed.map((group) => ({
      id: group.id,
      title: monitorGroupTitle(group),
      details: monitorGroupDetails(group),
      status: diagnosticsDependencies.monitorGroupStatusLabel(group),
      level: group.level,
      elapsed: group.elapsed,
      count: group.events.length,
    })),
  });
  if (renderSignature === diagnosticsDependencies.sharedAppState.lastRenderedMonitorHtml) return;
  diagnosticsDependencies.sharedAppState.lastRenderedMonitorHtml = renderSignature;
  container.textContent = '';
  if (omitted > 0) container.appendChild(createMonitorSummaryElement(windowed.length, omitted));
  if (windowed.length) {
    windowed.forEach((group) => container.appendChild(createMonitorGroupElement(group)));
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
    createMonitorGroupElement,
    prepareMonitorEvent,
    renderMonitor,
    monitorGroupTitle,
    monitorGroupDetails,
    formatExternalIngressProbe,
  };
}

function bindDiagnosticsControls() {
  syncExternalIngressUrl();
  const ingressProbeButton = diagnosticsDependencies.$('probeExternalIngress');
  if (ingressProbeButton && ingressProbeButton.dataset.bound !== 'true') {
    ingressProbeButton.onclick = probeExternalIngressFromUi;
    ingressProbeButton.dataset.bound = 'true';
  }
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
  const monitorRangeFilter = diagnosticsDependencies.$('monitorRangeFilter');
  if (monitorRangeFilter) {
    monitorRangeFilter.onchange = renderMonitor;
    monitorRangeFilter.dataset.bound = 'true';
  }
  const monitorLoadMore = diagnosticsDependencies.$('monitorLoadMore');
  if (monitorLoadMore && monitorLoadMore.dataset.monitorBound !== 'true') {
    monitorLoadMore.dataset.monitorBound = 'true';
    monitorLoadMore.onclick = () => {
      const next = monitorVisibleLimit() + diagnosticsDependencies.MONITOR_RENDER_WINDOW * 3;
      diagnosticsDependencies.sharedAppState.monitorVisibleCount = next;
      diagnosticsDependencies.sharedAppState.lastRenderedMonitorHtml = null;
      renderMonitor();
    };
  }
  const pauseMonitorBtn = diagnosticsDependencies.$('pauseMonitor');
  if (pauseMonitorBtn && pauseMonitorBtn.dataset.monitorBound !== 'true') {
    pauseMonitorBtn.dataset.monitorBound = 'true';
    pauseMonitorBtn.onclick = () => {
      const paused = !diagnosticsDependencies.sharedAppState.monitorPaused;
      diagnosticsDependencies.sharedAppState.monitorPaused = paused;
      pauseMonitorBtn.textContent = paused ? '继续直播' : '暂停直播';
      pauseMonitorBtn.classList.toggle('active', paused);
      if (!paused) {
        diagnosticsDependencies.sharedAppState.lastEventTime = null;
        diagnosticsDependencies.sharedAppState.monitorEvents = [];
        refreshMonitor();
      } else {
        diagnosticsDependencies.showToast('已暂停实时监控，新事件将在恢复后加载');
      }
    };
  }
  const exportMonitorBtn = diagnosticsDependencies.$('exportMonitorJson');
  if (exportMonitorBtn && exportMonitorBtn.dataset.monitorBound !== 'true') {
    exportMonitorBtn.dataset.monitorBound = 'true';
    exportMonitorBtn.onclick = () => {
      const groups = currentMonitorGroups();
      if (groups.length === 0) {
        diagnosticsDependencies.showToast('当前没有可导出的监控记录', 'error');
        return;
      }
      const payload = diagnosticsDependencies.buildMonitorExportPayload(groups, {
        range: diagnosticsDependencies.$('monitorRangeFilter')
          ? diagnosticsDependencies.$('monitorRangeFilter').value
          : 'all',
        status: diagnosticsDependencies.$('monitorStatusFilter').value,
        query: diagnosticsDependencies.$('monitorSearch').value,
      });
      const fileName = diagnosticExportFileName('monitor', 'json');
      downloadTextFile(fileName, JSON.stringify(payload, null, 2), 'application/json');
      diagnosticsDependencies.showToast(`已导出 ${payload.requestCount} 个请求到 ${fileName}`);
    };
  }
}

function diagnosticExportFileName(prefix, extension) {
  const stamp = diagnosticsDependencies.exportTimestamp(new Date());
  const safePrefix = diagnosticsDependencies.sanitizeExportFileName(`${prefix}-${stamp}`, prefix);
  return `${safePrefix}.${extension}`;
}

// The monitor lives in the WebView, so a Blob download keeps the export local
// to the user's machine without adding a native round trip.
function downloadTextFile(fileName, text, mimeType) {
  const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  const ingress = status.externalIngress
    ? `\n外部入口：${formatExternalIngressProbe(status.externalIngress)}`
    : '';
  return `enabled=${config.enabled}，Gemini=${config.captureGemini}，OpenAI=${config.captureOpenAI}，outbound=${config.captureOutboundSse}，requestTools=${config.captureRequestToolResults}\n${files}${ingress}`;
}

function formatExternalIngressProbe(result) {
  if (!result) return '尚未探测';
  const state = result.ok ? '正常' : '异常';
  const status = result.statusCode ? `HTTP ${result.statusCode}` : result.errorCode || '';
  const elapsed = Number.isFinite(result.elapsedMs) ? `${result.elapsedMs}ms` : '';
  const details = [status, elapsed, result.classification].filter(Boolean).join(' · ');
  const message = result.message || result.error || '无详细信息';
  return `${state}：${message}${details ? `（${details}）` : ''}`;
}

async function probeExternalIngressFromUi() {
  const input = diagnosticsDependencies.$('externalIngressUrl');
  const button = diagnosticsDependencies.$('probeExternalIngress');
  const status = diagnosticsDependencies.$('externalIngressStatus');
  if (!input || !button || !status) return;
  const url = String(input.value || '').trim();
  button.disabled = true;
  status.textContent = '正在进行安全探测...';
  try {
    const result = await window.proxyManager.probeExternalIngress(url);
    if (result && result.classification !== 'invalid_target' && url) {
      diagnosticsDependencies.storage.setItem(EXTERNAL_INGRESS_STORAGE_KEY, url);
    }
    status.textContent = formatExternalIngressProbe(result);
    status.className = `notice ${result && result.ok ? 'success' : 'error'}`;
    diagnosticsDependencies.showToast(
      result && result.ok ? '外部入口正常' : '外部入口异常',
      result && result.ok ? 'success' : 'error'
    );
  } catch (error) {
    status.textContent = `探测失败：${error && error.message ? error.message : '未知错误'}`;
    status.className = 'notice error';
  } finally {
    button.disabled = false;
  }
}

async function refreshDiagnostics(options = {}) {
  if (diagnosticsDependencies.sharedAppState.diagnosticsRefreshInFlight) return;
  diagnosticsDependencies.sharedAppState.diagnosticsRefreshInFlight = true;
  syncExternalIngressUrl();
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
