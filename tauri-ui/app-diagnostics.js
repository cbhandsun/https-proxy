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
  const lines = text ? text.split('\n').slice(-LOG_RENDER_LINE_LIMIT) : [];
  if (!lines.length) {
    target.appendChild(createLogEmptyElement());
    return;
  }
  lines.forEach((line) => target.appendChild(createLogLineElement(line)));
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(
    async () => {
      if (isMonitorVisible()) {
        await Promise.allSettled([
          refreshProxyStatus({ passive: true }),
          refreshMonitor({ passive: true }),
        ]);
      } else {
        await refreshProxyStatus({ passive: true });
      }
      await ensureProxyRecovered({ passive: true });
      // If the initial loadConfig() raced with the bundled proxy coming
      // up (Tauri launches the proxy on a background thread and the
      // page can render before 3543 is listening) the config we have
      // is still the empty fallback. Now that the heartbeat is talking
      // to the proxy, ask for a fresh config. hydrateConfigAfterStartup
      // no-ops once config is real, so this is safe to call every tick.
      if (
        typeof hydrateConfigAfterStartup === 'function' &&
        typeof checkProxyHealth === 'function'
      ) {
        try {
          const health = await checkProxyHealth();
          if (health) {
            hydrateConfigAfterStartup().catch((e) =>
              console.error('hydrateConfigAfterStartup in heartbeat:', e)
            );
            // 同样的冷启动问题也会让首次证书检查超时。等代理真正
            // 起来后再被动拉一次,refreshCertStatus 的 catch 分支
            // 不会写 lastCertRefresh,所以这次调用不会被 60s 节流。
            if (typeof refreshCertStatus === 'function') {
              refreshCertStatus({ passive: true }).catch((e) =>
                console.error('refreshCertStatus in heartbeat:', e)
              );
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
  if (typeof $ !== 'function') return;
  startHeartbeat();
  if (document.hidden) return;
  if ($('autoRefreshLog') && $('autoRefreshLog').checked) {
    lastLogAutoRefreshAt = 0;
    refreshActiveDiagnosticsPanel({ passive: true, forceScroll: true });
  }
  if (cliSessionsTimer && isCodeToolsVisible()) {
    lastCliSessionsPollAt = 0;
    refreshCliSessions({ passive: true, force: true });
  }
});

function isMonitorVisible() {
  return $('monitor').classList.contains('active');
}

function getViewDomCache() {
  if (!viewDomCache) {
    viewDomCache = {
      buttons: Array.from(document.querySelectorAll('[data-view-button]')),
      views: Array.from(document.querySelectorAll('.view')),
    };
  }
  return viewDomCache;
}

async function refreshMonitor(options = {}) {
  if (monitorRefreshInFlight) return;
  monitorRefreshInFlight = true;
  const finishPerf = perfStart('refresh.monitor');
  try {
    const events = await window.proxyManager.readEvents({
      limit: lastEventTime ? 200 : 300,
      after: lastEventTime || '',
    });
    if (!events || events.length === 0) {
      if (monitorEvents.length === 0) {
        const container = $('monitorList');
        container.textContent = '';
        container.appendChild(createMonitorEmptyElement('暂无请求记录...'));
      }
      return;
    }

    const preparedEvents = events.map(prepareMonitorEvent);
    monitorEvents = (lastEventTime ? monitorEvents.concat(preparedEvents) : preparedEvents).slice(
      -500
    );
    lastEventTime = monitorEvents[monitorEvents.length - 1].time;
    renderMonitor();
  } catch (err) {
    console.error('Failed to refresh monitor:', err);
  } finally {
    monitorRefreshInFlight = false;
    finishPerf({ passive: !!options.passive, events: monitorEvents.length });
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
    event.profileName,
    event.statusCode,
    event.code,
    event.protocol,
  ];
  if (event.body) fieldsToSearch.push(String(event.body).slice(0, MONITOR_SEARCH_BODY_LIMIT));
  event.__searchText = fieldsToSearch.filter(Boolean).join(' ').toLowerCase();
  let title = '';
  let details = '';
  let badgeClass = 'protocol';
  let levelClass = '';

  if (event.kind === 'request_start') {
    title = `${event.method} ${event.path}`;
    details = `Client: ${event.clientIp}`;
  } else if (event.kind === 'route') {
    title = `Route: ${event.sourceModel} → ${event.targetModel}`;
    const contextInfo = event.estimatedContextTokens
      ? ` | Context: ${event.estimatedContextTokens}tok`
      : '';
    details = `Profile: ${event.profileName} (${event.protocol})${contextInfo}`;
    badgeClass = 'active';
  } else if (event.kind === 'request_end') {
    title = `${event.method} ${event.path} -> ${event.statusCode}`;
    details = `Elapsed: ${event.elapsed}ms${event.usage ? ` | Tokens: ${event.usage.input_tokens}+${event.usage.output_tokens}` : ''}`;
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
  const container = $('monitorList');
  const shouldScroll = $('autoScrollMonitor').checked;
  const query = ($('monitorSearch').value || '').toLowerCase().trim();
  const statusFilter = $('monitorStatusFilter').value;

  let filteredEvents = monitorEvents;

  if (query || statusFilter !== 'all') {
    filteredEvents = monitorEvents.filter((event) => {
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

  const visibleEvents = filteredEvents.slice(-MONITOR_RENDER_WINDOW).reverse();
  const omittedEvents = Math.max(0, filteredEvents.length - visibleEvents.length);
  const viewModels = visibleEvents.map(
    (event) => event.__monitorView || prepareMonitorEvent(event).__monitorView
  );
  const renderSignature = JSON.stringify({
    omittedEvents,
    visibleEvents: viewModels,
  });
  if (renderSignature === lastRenderedMonitorHtml) return;
  lastRenderedMonitorHtml = renderSignature;
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
  const clearMonBtn = $('clearMonitor');
  if (clearMonBtn && clearMonBtn.dataset.monitorBound !== 'true') {
    clearMonBtn.dataset.monitorBound = 'true';
    clearMonBtn.onclick = async () => {
      await window.proxyManager.clearEvents();
      monitorEvents = [];
      lastEventTime = null;
      lastRenderedMonitorHtml = null;
      renderMonitor();
      showToast('监控已清空');
    };
  }

  $('refreshLog').onclick = () => {
    showDiagnosticsTab('logPanel');
  };
  $('refreshLog').dataset.bound = 'true';
  $('refreshDiagnostics').onclick = async () => {
    showDiagnosticsTab('diagnosticsPanel');
  };
  $('refreshDiagnostics').dataset.bound = 'true';
  $('scrollLogBottom').onclick = () => {
    if ($('diagnosticsPanel').classList.contains('active')) scrollLogToBottom('diagnosticsOutput');
    else {
      showDiagnosticsTab('logPanel');
      scrollLogToBottom('log');
    }
  };
  $('scrollLogBottom').dataset.bound = 'true';
  $('clearLog').onclick = clearLog;
  $('clearLog').dataset.bound = 'true';
  $('clearDiagnostics').onclick = clearDiagnostics;
  $('clearDiagnostics').dataset.bound = 'true';

  $('autoRefreshLog').onchange = () => {
    setLogAutoRefresh($('autoRefreshLog').checked);
    if ($('autoRefreshLog').checked) {
      if ($('logPanel').classList.contains('active')) refreshLog({ forceScroll: true });
      if ($('diagnosticsPanel').classList.contains('active'))
        refreshDiagnostics({ forceScroll: true });
    }
  };
  $('autoRefreshLog').dataset.bound = 'true';
  $('autoScrollLog').onchange = () => {
    if ($('autoScrollLog').checked) {
      if ($('logPanel').classList.contains('active')) scrollLogToBottom('log');
      if ($('diagnosticsPanel').classList.contains('active'))
        scrollLogToBottom('diagnosticsOutput');
    }
  };
  $('autoScrollLog').dataset.bound = 'true';
  setLogAutoRefresh($('autoRefreshLog').checked);

  document.querySelectorAll('[data-diagnostics-tab]').forEach((button) => {
    button.onclick = () => showDiagnosticsTab(button.dataset.diagnosticsTab);
    button.dataset.bound = 'true';
  });

  $('monitorSearch').oninput = debounce(renderMonitor, 180);
  $('monitorSearch').dataset.bound = 'true';
  $('monitorStatusFilter').onchange = renderMonitor;
  $('monitorStatusFilter').dataset.bound = 'true';
}

function scrollLogToBottom(targetId = 'log') {
  const log = $(targetId);
  requestAnimationFrame(() => {
    log.scrollTop = log.scrollHeight;
  });
}

function isNearBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 40;
}

function isDiagnosticsVisible() {
  return $('diagnostics').classList.contains('active');
}

async function refreshLog(options = {}) {
  if (logRefreshInFlight) return;
  logRefreshInFlight = true;
  const log = $('log');
  const shouldKeepBottom =
    options.forceScroll || ($('autoScrollLog') && $('autoScrollLog').checked) || isNearBottom(log);
  const finishPerf = perfStart('refresh.log');
  let changed = false;
  let rawLog = '';
  try {
    if (!options.passive) $('logRefreshState').textContent = '刷新中...';
    rawLog = await window.proxyManager.readLog({
      lines: LOG_RENDER_LINE_LIMIT,
      maxBytes: LOG_REQUEST_MAX_BYTES,
    });
    if (rawLog !== lastRenderedLog || options.forceRender) {
      renderLogLines(log, rawLog);
      lastRenderedLog = rawLog;
      changed = true;
    }
    if (!options.passive || changed)
      $('logRefreshState').textContent = '已刷新 ' + new Date().toLocaleTimeString();
    if (shouldKeepBottom && changed) scrollLogToBottom('log');
  } catch (err) {
    $('logRefreshState').textContent = '刷新失败';
  } finally {
    logRefreshInFlight = false;
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
  if (diagnosticsRefreshInFlight) return;
  diagnosticsRefreshInFlight = true;
  const output = $('diagnosticsOutput');
  const shouldKeepBottom =
    options.forceScroll ||
    ($('autoScrollLog') && $('autoScrollLog').checked) ||
    isNearBottom(output);
  const finishPerf = perfStart('refresh.diagnostics');
  let changed = false;
  let outputText = '';
  try {
    if (!options.passive) $('diagnosticsRefreshState').textContent = '刷新中...';
    const result = await window.proxyManager.readDiagnostics();
    const statusText = renderDiagnosticsStatus(result.status);
    outputText = result.output || '暂无诊断事件';
    if (statusText !== lastRenderedDiagnosticsStatus || options.forceRender) {
      $('diagnosticsStatus').textContent = statusText;
      lastRenderedDiagnosticsStatus = statusText;
      changed = true;
    }
    if (outputText !== lastRenderedDiagnosticsOutput || options.forceRender) {
      output.textContent = outputText;
      lastRenderedDiagnosticsOutput = outputText;
      changed = true;
    }
    if (!options.passive || changed)
      $('diagnosticsRefreshState').textContent = '已刷新 ' + new Date().toLocaleTimeString();
    if (shouldKeepBottom && changed) scrollLogToBottom('diagnosticsOutput');
  } catch (err) {
    $('diagnosticsRefreshState').textContent = '刷新失败';
  } finally {
    diagnosticsRefreshInFlight = false;
    finishPerf({ passive: !!options.passive, changed, bytes: outputText.length });
  }
}
function refreshActiveDiagnosticsPanel(options = {}) {
  if (!isDiagnosticsVisible()) return;
  if ($('logPanel').classList.contains('active')) refreshLog(options);
  if ($('diagnosticsPanel').classList.contains('active')) refreshDiagnostics(options);
}
function setLogAutoRefresh(enabled) {
  if (logRefreshTimer) {
    clearInterval(logRefreshTimer);
    logRefreshTimer = null;
  }
  if (!enabled) return;
  lastLogAutoRefreshAt = 0;
  logRefreshTimer = setInterval(() => {
    if (!isDiagnosticsVisible()) return;
    if (document.hidden) return;
    const now = Date.now();
    if (now - lastLogAutoRefreshAt < LOG_AUTO_REFRESH_VISIBLE_MS) return;
    lastLogAutoRefreshAt = now;
    refreshActiveDiagnosticsPanel({ passive: true });
  }, LOG_AUTO_REFRESH_VISIBLE_MS);
}

async function clearLog() {
  const confirmed = await confirmAction({
    title: '清理日志？',
    message: '这会直接清空当前代理日志文件，不再生成备份。',
    confirmText: '清理日志',
  });
  if (!confirmed) return;
  const result = await window.proxyManager.clearLog();
  $('output').textContent = result.output || (result.ok ? '日志已清理' : '日志清理失败');
  showDiagnosticsTab('logPanel');
  showToast($('output').textContent, result.ok ? 'success' : 'error');
  await refreshLog({ forceScroll: true });
}

async function clearDiagnostics() {
  const confirmed = await confirmAction({
    title: '清理诊断事件？',
    message: '这会直接清空当前诊断采样文件，不再生成备份。',
    confirmText: '清理诊断',
  });
  if (!confirmed) return;
  const result = await window.proxyManager.clearDiagnostics();
  const msg = result.output || (result.ok ? '诊断事件已清理' : '诊断事件清理失败');
  $('output').textContent = msg;
  showDiagnosticsTab('diagnosticsPanel');
  showToast(msg, result.ok ? 'success' : 'error');
  await refreshDiagnostics({ forceScroll: true });
}
