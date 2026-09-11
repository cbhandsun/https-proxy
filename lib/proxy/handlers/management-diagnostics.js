const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { DATA_DIR, DEFAULT_CONFIG } = require('../config');

const {
  fileSignature,
  parseBoundedInteger,
  readJsonBodyFromRequest,
  readLastLinesOfJsonl,
} = require('../management-utils');
const { probeExternalIngress: defaultProbeExternalIngress } = require('../external-ingress-probe');

const {
  GEMINI_SAMPLE_FILE,
  TOOL_AUDIT_FILE,
  RESPONSE_SAMPLE_FILE,
  DIAGNOSTICS_OUTBOUND_SSE_FILE,
  DIAGNOSTICS_REQUEST_TOOLS_FILE,
  PROXY_EVENTS_FILE,
} = require('../diagnostics');

const DEFAULT_FULL_LOG_BYTES = 2 * 1024 * 1024;
const MAX_FULL_LOG_BYTES_LIMIT = 16 * 1024 * 1024;
const DEFAULT_TAIL_LOG_BYTES = 256 * 1024;
const MAX_TAIL_LOG_BYTES = 2 * 1024 * 1024;

function clearTextFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) return false;
  fs.truncateSync(filePath, 0);
  return true;
}

function readTailText(filePath, maxLines = 300, maxBytes = DEFAULT_TAIL_LOG_BYTES) {
  if (!fs.existsSync(filePath)) return '暂无日志记录';
  const stat = fs.statSync(filePath);
  if (stat.size === 0) return '暂无日志记录';

  const safeBytes = Math.min(
    stat.size,
    parseBoundedInteger(maxBytes, DEFAULT_TAIL_LOG_BYTES, 8 * 1024, MAX_TAIL_LOG_BYTES)
  );
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(safeBytes);
    fs.readSync(fd, buffer, 0, safeBytes, stat.size - safeBytes);
    const text = buffer.toString('utf8');
    const lines = text.split('\n');
    const safeLines = parseBoundedInteger(maxLines, 300, 1, 2000);
    return lines.slice(-safeLines).join('\n');
  } finally {
    fs.closeSync(fd);
  }
}

function readBoundedFullLog(filePath, maxBytes = DEFAULT_FULL_LOG_BYTES) {
  if (!fs.existsSync(filePath)) return '暂无日志记录';
  const stat = fs.statSync(filePath);
  if (stat.size === 0) return '暂无日志记录';
  const safeBytes = Math.min(
    stat.size,
    parseBoundedInteger(maxBytes, DEFAULT_FULL_LOG_BYTES, 64 * 1024, MAX_FULL_LOG_BYTES_LIMIT)
  );
  const body = readTailText(filePath, 2000, safeBytes);
  if (stat.size <= safeBytes) return body;
  return `[log truncated: showing last ${safeBytes} of ${stat.size} bytes]\n` + body;
}

function formatRecentProxyEventsForLog(limit) {
  const events = readLastLinesOfJsonl(PROXY_EVENTS_FILE, limit, 256 * 1024);
  if (!events.length) return '';
  return events
    .map((event) => {
      const time = event.time || '-';
      if (event.kind === 'request_start') {
        return `${time} request_start ${event.method || ''} ${event.path || ''} entry=${event.entryProtocol || '-'}`;
      }
      if (event.kind === 'route') {
        const context = event.estimatedContextTokens
          ? ` context=${event.estimatedContextTokens}tok`
          : '';
        return `${time} route ${event.method || ''} ${event.path || ''} ${event.sourceModel || '-'} -> ${event.profileId || '-'}:${event.targetModel || '-'} protocol=${event.protocol || '-'}${context}`;
      }
      if (event.kind === 'request_end') {
        const endpoint = event.upstreamEndpoint ? ` upstream=${event.upstreamEndpoint}` : '';
        return `${time} request_end ${event.method || ''} ${event.path || ''} -> ${event.statusCode || '-'} elapsed=${event.elapsed || 0}ms type=${event.type || '-'}${endpoint}`;
      }
      if (event.kind === 'upstream_error') {
        return `${time} upstream_error ${event.method || ''} -> ${event.code || '-'} profile=${event.profileId || '-'}`;
      }
      if (event.kind === 'proxy_error') {
        return `${time} proxy_error ${event.method || ''} ${event.path || ''} ${event.code || ''} ${event.error || ''}`;
      }
      return `${time} ${event.kind || 'event'} ${JSON.stringify(event)}`;
    })
    .join('\n');
}

function getFormattedDiagnosticsOutput() {
  const allEvents = [];

  const proxyEvents = readLastLinesOfJsonl(PROXY_EVENTS_FILE, 100);
  for (const item of proxyEvents) {
    const time = item.time || new Date().toISOString();
    let text;
    if (item.kind === 'request_start') {
      text = `[Proxy-Request] ${item.method} ${item.path} (clientIp: ${item.clientIp || 'unknown'}, protocol: ${item.entryProtocol || 'unknown'})`;
    } else if (item.kind === 'request_end') {
      text = `[Proxy-Response] ${item.method} ${item.path} -> ${item.statusCode} (elapsed: ${item.elapsed || 0}ms, type: ${item.type || 'unknown'})`;
    } else if (item.kind === 'upstream_error') {
      text = `[Upstream-Error] ${item.method} -> ${item.code} (profile: ${item.profileId || 'N/A'})`;
    } else if (item.kind === 'proxy_error') {
      text = `[Proxy-Error] ${item.method} ${item.path} (error: ${item.error || 'N/A'})`;
    } else {
      text = `[Event] kind=${item.kind} ${JSON.stringify(item)}`;
    }
    allEvents.push({ time, text });
  }

  const toolAudits = readLastLinesOfJsonl(TOOL_AUDIT_FILE, 20);
  for (const item of toolAudits) {
    const time = item.time || new Date().toISOString();
    const text = `[Tool-Audit] tool: ${item.toolName} (source: ${item.source}) - Status: INVALID, Error: ${item.error}`;
    allEvents.push({ time, text });
  }

  const geminiTools = readLastLinesOfJsonl(GEMINI_SAMPLE_FILE, 20);
  for (const item of geminiTools) {
    const time = item.time || new Date().toISOString();
    const text = `[Gemini-Tool] reason: ${item.reason} - payload: ${JSON.stringify(item.payload)}`;
    allEvents.push({ time, text });
  }

  const sseSamples = readLastLinesOfJsonl(DIAGNOSTICS_OUTBOUND_SSE_FILE, 20);
  for (const item of sseSamples) {
    const time = item.time || new Date().toISOString();
    const p = item.payload || {};
    const text = `[Outbound-SSE] event: ${p.event} (index: ${p.index}, toolName: ${p.toolName || 'N/A'})`;
    allEvents.push({ time, text });
  }

  const requestTools = readLastLinesOfJsonl(DIAGNOSTICS_REQUEST_TOOLS_FILE, 20);
  for (const item of requestTools) {
    const time = item.time || new Date().toISOString();
    const p = item.payload || {};
    const text = `[Request-Tools] model: ${p.model} (messageCount: ${p.messageCount || 0}, uses: ${p.toolUses ? p.toolUses.length : 0}, results: ${p.toolResults ? p.toolResults.length : 0})`;
    allEvents.push({ time, text });
  }

  allEvents.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  if (allEvents.length === 0) {
    return '暂无诊断事件。请确保 diagnostics.enabled 在配置文件中开启，并进行了一些代理请求。';
  }

  return allEvents
    .map((ev) => {
      const localTime = new Date(ev.time).toLocaleString();
      return `[${localTime}] ${ev.text}`;
    })
    .join('\n');
}

function buildDiagnosticsConfig(currentConfigSnapshot) {
  const configSource =
    typeof currentConfigSnapshot === 'function' ? currentConfigSnapshot() || {} : {};
  const user = configSource.diagnostics || {};
  const defaults = DEFAULT_CONFIG.diagnostics;
  return {
    enabled: user.enabled === true,
    captureGemini: user.captureGemini !== false,
    captureOpenAI: user.captureOpenAI === true,
    captureOutboundSse: user.captureOutboundSse !== false,
    captureRequestToolResults: user.captureRequestToolResults !== false,
    maxFileBytes: parseBoundedInteger(
      user.maxFileBytes,
      defaults.maxFileBytes,
      1024,
      64 * 1024 * 1024
    ),
    maxTextBytes: parseBoundedInteger(user.maxTextBytes, defaults.maxTextBytes, 100, 1024 * 1024),
    externalIngressUrl:
      typeof user.externalIngressUrl === 'string' ? user.externalIngressUrl.trim() : '',
    externalIngressTimeoutMs: parseBoundedInteger(
      user.externalIngressTimeoutMs,
      defaults.externalIngressTimeoutMs,
      1000,
      15000
    ),
  };
}

function createManagementDiagnosticsHandlers({
  sendJson,
  currentConfigSnapshot,
  probeExternalIngress = defaultProbeExternalIngress,
}) {
  if (typeof sendJson !== 'function') {
    throw new TypeError('createManagementDiagnosticsHandlers requires sendJson');
  }

  let localEventsResponseCache = { key: '', body: '' };
  let localLogResponseCache = { key: '', body: '' };
  let localDiagnosticsResponseCache = { key: '', body: '' };
  let lastExternalIngressProbe = null;
  const maxFullLogBytes = parseBoundedInteger(
    process.env.PROXY_FULL_LOG_MAX_BYTES,
    DEFAULT_FULL_LOG_BYTES,
    64 * 1024,
    MAX_FULL_LOG_BYTES_LIMIT
  );

  function resetCaches() {
    localEventsResponseCache = { key: '', body: '' };
    localLogResponseCache = { key: '', body: '' };
    localDiagnosticsResponseCache = { key: '', body: '' };
  }

  function handleLocalEventsRequest(clientReq, clientRes) {
    try {
      const eventsFile = path.join(DATA_DIR, 'proxy-events.jsonl');
      const parsedUrl = new URL(clientReq.url, `http://${clientReq.headers.host || 'localhost'}`);
      const limit = parseBoundedInteger(parsedUrl.searchParams.get('limit'), 200, 1, 1000);
      const after = parsedUrl.searchParams.get('after');
      const afterTime = after ? Date.parse(after) : NaN;
      const readLimit = Number.isFinite(afterTime) ? Math.min(5000, limit * 5) : limit;
      const cacheKey = [eventsFile, fileSignature(eventsFile), limit, after || '', readLimit].join(
        '|'
      );
      if (cacheKey === localEventsResponseCache.key) {
        clientRes.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
        });
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
      clientRes.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
      });
      clientRes.end(body);
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalEventsClearRequest(clientReq, clientRes) {
    try {
      clearTextFileIfExists(path.join(DATA_DIR, 'proxy-events.jsonl'));
      resetCaches();
      sendJson(clientRes, 200, { ok: true });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalDiagnosticsGetRequest(clientReq, clientRes) {
    try {
      const config = buildDiagnosticsConfig(currentConfigSnapshot);
      const filesMeta = [
        { label: 'Gemini采样', path: GEMINI_SAMPLE_FILE },
        { label: '工具审计', path: TOOL_AUDIT_FILE },
        { label: '响应采样', path: RESPONSE_SAMPLE_FILE },
        { label: '出站SSE', path: DIAGNOSTICS_OUTBOUND_SSE_FILE },
        { label: '请求工具', path: DIAGNOSTICS_REQUEST_TOOLS_FILE },
        { label: '代理事件', path: PROXY_EVENTS_FILE },
      ];

      const cacheKey = [
        JSON.stringify(config),
        ...filesMeta.map((item) => `${item.path}:${fileSignature(item.path)}`),
      ].join('|');
      if (cacheKey === localDiagnosticsResponseCache.key) {
        clientRes.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
        });
        clientRes.end(localDiagnosticsResponseCache.body);
        return;
      }

      const files = filesMeta.map((item) => {
        const exists = fs.existsSync(item.path);
        const bytes = exists ? fs.statSync(item.path).size : 0;
        return { label: item.label, exists, bytes };
      });

      const body = JSON.stringify({
        ok: true,
        status: {
          config,
          files,
          externalIngress: lastExternalIngressProbe,
        },
        output: getFormattedDiagnosticsOutput(),
      });
      localDiagnosticsResponseCache = { key: cacheKey, body };

      clientRes.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
      });
      clientRes.end(body);
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalDiagnosticsClearRequest(clientReq, clientRes) {
    try {
      for (const file of [
        GEMINI_SAMPLE_FILE,
        TOOL_AUDIT_FILE,
        RESPONSE_SAMPLE_FILE,
        DIAGNOSTICS_OUTBOUND_SSE_FILE,
        DIAGNOSTICS_REQUEST_TOOLS_FILE,
        PROXY_EVENTS_FILE,
      ]) {
        clearTextFileIfExists(file);
      }
      lastExternalIngressProbe = null;
      resetCaches();
      sendJson(clientRes, 200, { ok: true });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalIngressProbeRequest(clientReq, clientRes) {
    readJsonBodyFromRequest(
      clientReq,
      async (bodyErr, body) => {
        if (bodyErr) {
          sendJson(clientRes, 400, { ok: false, error: bodyErr.message });
          return;
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(clientRes, 400, { ok: false, error: 'Request body must be an object' });
          return;
        }
        const config = buildDiagnosticsConfig(currentConfigSnapshot);
        const url = typeof body.url === 'string' ? body.url.trim() : config.externalIngressUrl;
        const timeoutMs = parseBoundedInteger(
          body.timeoutMs,
          config.externalIngressTimeoutMs,
          1000,
          15000
        );
        try {
          lastExternalIngressProbe = await probeExternalIngress(url, { timeoutMs });
          localDiagnosticsResponseCache = { key: '', body: '' };
          sendJson(clientRes, 200, lastExternalIngressProbe);
        } catch (error) {
          sendJson(clientRes, 400, {
            ok: false,
            classification: 'invalid_target',
            error: error.message,
          });
        }
      },
      { maxBytes: 8 * 1024 }
    );
  }

  function handleLocalLogRequest(clientReq, clientRes) {
    clientRes.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'access-control-allow-origin': '*',
    });
    const logFile = path.join(DATA_DIR, 'proxy.log');
    const parsedUrl = new URL(clientReq.url, `http://${clientReq.headers.host || 'localhost'}`);
    const full = parsedUrl.searchParams.get('full') === '1';
    if (full && fs.existsSync(logFile)) {
      const requestedMaxBytes = parseBoundedInteger(
        parsedUrl.searchParams.get('maxBytes'),
        maxFullLogBytes,
        64 * 1024,
        MAX_FULL_LOG_BYTES_LIMIT
      );
      clientRes.end(readBoundedFullLog(logFile, requestedMaxBytes));
      return;
    }
    const maxLines = parseBoundedInteger(parsedUrl.searchParams.get('lines'), 300, 1, 2000);
    const maxBytes = parseBoundedInteger(
      parsedUrl.searchParams.get('maxBytes'),
      DEFAULT_TAIL_LOG_BYTES,
      8 * 1024,
      MAX_TAIL_LOG_BYTES
    );
    const cacheKey = [
      logFile,
      fileSignature(logFile),
      fileSignature(PROXY_EVENTS_FILE),
      maxLines,
      maxBytes,
    ].join('|');
    if (cacheKey === localLogResponseCache.key) {
      clientRes.end(localLogResponseCache.body);
      return;
    }
    let body = readTailText(logFile, maxLines, maxBytes);
    const recentEvents = formatRecentProxyEventsForLog(30);
    if (recentEvents) {
      body +=
        (body && !body.endsWith('\n') ? '\n' : '') +
        '\n--- recent proxy events ---\n' +
        recentEvents;
    }
    localLogResponseCache = { key: cacheKey, body };
    clientRes.end(body);
  }

  return {
    handleLocalEventsRequest,
    handleLocalEventsClearRequest,
    handleLocalDiagnosticsGetRequest,
    handleLocalDiagnosticsClearRequest,
    handleLocalIngressProbeRequest,
    handleLocalLogRequest,
  };
}

module.exports = {
  createManagementDiagnosticsHandlers,
  clearTextFileIfExists,
  formatRecentProxyEventsForLog,
  getFormattedDiagnosticsOutput,
  readBoundedFullLog,
  readTailText,
};
