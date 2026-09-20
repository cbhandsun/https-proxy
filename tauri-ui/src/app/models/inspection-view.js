// Shared, dependency-free view helpers for the realtime monitor and the
// conversation audit views. Every function is pure: no DOM, no network, no
// storage. The composition root injects this module into the domain modules so
// that the domain layer keeps its import boundary.

export const INSPECTION_QUERY_MAX_CHARS = 200;
export const SLOW_REQUEST_MS = 5000;
export const VERY_SLOW_REQUEST_MS = 15000;
export const DEFAULT_MONITOR_PAGE_SIZE = 30;
export const DEFAULT_AUDIT_PAGE_SIZE = 30;
export const MAX_MONITOR_PAGE_SIZE = 500;
export const MAX_AUDIT_PAGE_SIZE = 500;

export const INSPECTION_RANGE_OPTIONS = Object.freeze([
  Object.freeze({ id: 'all', label: '全部时间', windowMs: 0 }),
  Object.freeze({ id: '15m', label: '最近 15 分钟', windowMs: 15 * 60 * 1000 }),
  Object.freeze({ id: '1h', label: '最近 1 小时', windowMs: 60 * 60 * 1000 }),
  Object.freeze({ id: '24h', label: '最近 24 小时', windowMs: 24 * 60 * 60 * 1000 }),
  Object.freeze({ id: '7d', label: '最近 7 天', windowMs: 7 * 24 * 60 * 60 * 1000 }),
]);

export const MONITOR_STATUS_OPTIONS = Object.freeze([
  Object.freeze({ id: 'all', label: '所有状态' }),
  Object.freeze({ id: 'success', label: '成功 (2xx)' }),
  Object.freeze({ id: 'error', label: '异常 (4xx/5xx)' }),
  Object.freeze({ id: 'route', label: '仅映射路由' }),
  Object.freeze({ id: 'slow', label: '慢请求 (≥5s)' }),
]);

export const AUDIT_STATUS_OPTIONS = Object.freeze([
  Object.freeze({ id: 'all', label: '所有状态' }),
  Object.freeze({ id: 'success', label: '成功 (2xx)' }),
  Object.freeze({ id: 'error', label: '异常 (非 2xx)' }),
  Object.freeze({ id: 'slow', label: '慢请求 (≥5s)' }),
  Object.freeze({ id: 'context-attention', label: '上下文异常/裁剪' }),
  Object.freeze({ id: 'context-missing', label: '缺少上下文诊断' }),
]);

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toSearchableText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function boundedSlice(value, limit) {
  const text = toSearchableText(value);
  if (text.length <= limit) return text;
  return text.slice(0, limit);
}

export function normalizeInspectionQuery(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, INSPECTION_QUERY_MAX_CHARS).toLowerCase();
}

export function normalizeInspectionRange(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return INSPECTION_RANGE_OPTIONS.some((option) => option.id === id) ? id : 'all';
}

export function normalizeMonitorStatus(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return MONITOR_STATUS_OPTIONS.some((option) => option.id === id) ? id : 'all';
}

export function normalizeAuditStatus(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return AUDIT_STATUS_OPTIONS.some((option) => option.id === id) ? id : 'all';
}

export function inspectionRangeStart(rangeId, now = Date.now()) {
  const normalized = normalizeInspectionRange(rangeId);
  const option = INSPECTION_RANGE_OPTIONS.find((item) => item.id === normalized);
  if (!option || !option.windowMs) return 0;
  const base = Number.isFinite(now) ? now : Date.now();
  return base - option.windowMs;
}

export function parseInspectionTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Records with an unparsable timestamp stay visible: filtering must never hide
// data because of a formatting problem.
export function isWithinInspectionRange(timeValue, sinceMs) {
  const since = toFiniteNumber(sinceMs);
  if (!since || since <= 0) return true;
  const parsed = parseInspectionTime(timeValue);
  if (parsed == null) return true;
  return parsed >= since;
}

export function formatElapsedMs(value) {
  const ms = toFiniteNumber(value);
  if (ms == null || ms < 0) return '未知耗时';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m${String(remainder).padStart(2, '0')}s`;
}

export function classifyLatency(value) {
  const ms = toFiniteNumber(value);
  if (ms == null || ms < 0) return 'unknown';
  if (ms >= VERY_SLOW_REQUEST_MS) return 'very-slow';
  if (ms >= SLOW_REQUEST_MS) return 'slow';
  return 'normal';
}

export function latencyLabel(value) {
  const level = classifyLatency(value);
  if (level === 'very-slow') return '极慢';
  if (level === 'slow') return '偏慢';
  return '';
}

function monitorEventKind(event) {
  return typeof event.kind === 'string' ? event.kind : '';
}

function applyMonitorEvent(group, event) {
  const kind = monitorEventKind(event);
  if (kind === 'request_start') {
    if (typeof event.method === 'string') group.method = event.method;
    if (typeof event.path === 'string') group.path = event.path;
    group.startTime = event.time || group.startTime;
    if (typeof event.clientIp === 'string') group.clientIp = event.clientIp;
    if (typeof event.profileName === 'string') group.profileName = event.profileName;
    return;
  }
  if (kind === 'route') {
    group.routed = true;
    group.routedAt = event.time || group.routedAt;
    if (typeof event.sourceModel === 'string') group.sourceModel = event.sourceModel;
    if (typeof event.targetModel === 'string') group.targetModel = event.targetModel;
    if (typeof event.profileName === 'string') group.profileName = event.profileName;
    if (typeof event.protocol === 'string') group.protocol = event.protocol;
    if (typeof event.method === 'string' && !group.method) group.method = event.method;
    if (typeof event.path === 'string' && !group.path) group.path = event.path;
    return;
  }
  if (kind === 'request_end') {
    const elapsed = toFiniteNumber(event.elapsed);
    if (elapsed != null) group.elapsed = elapsed;
    const statusCode = toFiniteNumber(event.statusCode);
    if (statusCode != null) group.statusCode = statusCode;
    group.endTime = event.time || group.endTime;
    if (typeof event.method === 'string' && !group.method) group.method = event.method;
    if (typeof event.path === 'string' && !group.path) group.path = event.path;
    group.level = statusCode != null && statusCode >= 200 && statusCode < 300 ? 'success' : 'error';
    if (typeof event.type === 'string') group.endType = event.type;
    if (isRecord(event.usage)) group.usage = event.usage;
    return;
  }
  if (kind === 'upstream_error' || kind === 'proxy_error') {
    group.level = 'error';
    group.hasErrorEvent = true;
    group.endTime = group.endTime || event.time;
    if (typeof event.method === 'string' && !group.method) group.method = event.method;
    if (typeof event.path === 'string' && !group.path) group.path = event.path;
    if (typeof event.error === 'string' && !group.error) group.error = event.error;
    else if (typeof event.code === 'string' && !group.error) group.error = event.code;
  }
}

export function aggregateMonitorEvents(events) {
  const list = Array.isArray(events) ? events : [];
  const groups = new Map();
  const order = [];
  list.forEach((event, index) => {
    if (!isRecord(event)) return;
    const rawReqId = typeof event.reqId === 'string' ? event.reqId.trim() : '';
    // `route` and some error events carry no reqId. Attach them to the request
    // that is still open so one logical request renders as a single card, and
    // fall back to an anonymous group when nothing is open.
    let key = rawReqId;
    if (!key) {
      for (let i = order.length - 1; i >= 0; i -= 1) {
        const candidate = groups.get(order[i]);
        if (candidate && !candidate.endTime) {
          key = candidate.id;
          break;
        }
      }
    }
    if (!key) key = `anon-${index}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        id: key,
        reqId: rawReqId,
        method: '',
        path: '',
        clientIp: '',
        profileName: '',
        protocol: '',
        sourceModel: '',
        targetModel: '',
        startTime: '',
        endTime: '',
        routedAt: '',
        elapsed: null,
        statusCode: null,
        level: 'unknown',
        routed: false,
        hasErrorEvent: false,
        error: '',
        endType: '',
        usage: null,
        events: [],
      };
      groups.set(key, group);
      order.push(key);
    }
    group.events.push(event);
    applyMonitorEvent(group, event);
  });
  return order.map((key) => groups.get(key));
}

export function monitorGroupSearchText(group) {
  if (!isRecord(group)) return '';
  const parts = [
    group.method,
    group.path,
    group.reqId,
    group.profileName,
    group.protocol,
    group.sourceModel,
    group.targetModel,
    group.statusCode == null ? '' : group.statusCode,
    group.endType,
    group.error,
    group.clientIp,
  ];
  const events = Array.isArray(group.events) ? group.events : [];
  events.forEach((event) => {
    if (!isRecord(event)) return;
    parts.push(event.__searchText || '', boundedSlice(event.body, 600));
  });
  return parts.filter(Boolean).join(' ').toLowerCase();
}

export function filterMonitorGroups(groups, options = {}) {
  const list = Array.isArray(groups) ? groups : [];
  const query = normalizeInspectionQuery(options.query);
  const status = normalizeMonitorStatus(options.status);
  const since = inspectionRangeStart(options.range, options.now);
  return list.filter((group) => {
    if (!isRecord(group)) return false;
    if (!isWithinInspectionRange(group.endTime || group.startTime, since)) return false;
    if (status === 'success' && group.level !== 'success') return false;
    if (status === 'error' && group.level !== 'error') return false;
    if (status === 'route' && group.routed !== true) return false;
    if (status === 'slow') {
      const level = classifyLatency(group.elapsed);
      if (level !== 'slow' && level !== 'very-slow') return false;
    }
    if (!query) return true;
    return monitorGroupSearchText(group).includes(query);
  });
}

export function monitorGroupStatusLabel(group) {
  if (!isRecord(group)) return '未知';
  if (group.level === 'error') return '失败';
  if (group.level === 'success') return '成功';
  if (group.routed) return '路由';
  return '进行中';
}

export function auditMessageSearchText(record) {
  if (!isRecord(record)) return '';
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const chunks = [];
  let budget = 4000;
  for (const message of messages) {
    if (budget <= 0) break;
    if (!isRecord(message)) continue;
    const content = message.content;
    if (typeof content === 'string') {
      chunks.push(boundedSlice(content, budget));
      budget -= 400;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (budget <= 0) break;
      if (!isRecord(block)) continue;
      if (typeof block.text === 'string') chunks.push(boundedSlice(block.text, budget));
      if (typeof block.name === 'string') chunks.push(block.name);
      budget -= 400;
    }
  }
  return chunks.filter(Boolean).join(' ');
}

export function auditRecordSearchText(record) {
  if (!isRecord(record)) return '';
  const diagnostics = isRecord(record.contextDiagnostics) ? record.contextDiagnostics : {};
  const contextBudget = isRecord(diagnostics.contextBudget) ? diagnostics.contextBudget : {};
  const providerCache = isRecord(diagnostics.providerCache) ? diagnostics.providerCache : {};
  const contextCache = isRecord(contextBudget.contextCache) ? contextBudget.contextCache : {};
  const parts = [
    record.id,
    record.method,
    record.path,
    record.protocol,
    record.profileName,
    record.originalModel,
    record.rewriteModel,
    record.statusCode == null ? '' : record.statusCode,
    record.error,
    contextBudget.policy,
    contextBudget.source,
    contextCache.stablePrefixHash,
    providerCache.provider,
    providerCache.policy,
    boundedSlice(record.system, 4000),
    auditMessageSearchText(record),
  ];
  return parts.filter(Boolean).join(' ').toLowerCase();
}

export function auditContextFilterState(record) {
  if (!isRecord(record) || !isRecord(record.contextDiagnostics)) return 'missing';
  const diagnostics = record.contextDiagnostics;
  const contextBudget = isRecord(diagnostics.contextBudget) ? diagnostics.contextBudget : null;
  if (!contextBudget) return 'missing';
  const dropped = toFiniteNumber(contextBudget.droppedCount) || 0;
  const optimized = toFiniteNumber(contextBudget.optimizedCount) || 0;
  const overBudget = toFiniteNumber(contextBudget.overBudgetTokens) || 0;
  const repaired = toFiniteNumber(diagnostics.repairedOrphanToolResults) || 0;
  return dropped > 0 || optimized > 0 || overBudget > 0 || repaired > 0 ? 'attention' : 'healthy';
}

export function auditContextListLabel(record) {
  const state = auditContextFilterState(record);
  if (state === 'missing') return '缺诊断';
  return state === 'attention' ? '上下文注意' : '';
}

export function filterAuditRecords(records, options = {}) {
  const list = Array.isArray(records) ? records : [];
  const query = normalizeInspectionQuery(options.query);
  const status = normalizeAuditStatus(options.status);
  const since = inspectionRangeStart(options.range, options.now);
  return list.filter((record) => {
    if (!isRecord(record)) return false;
    if (!isWithinInspectionRange(record.time, since)) return false;
    const code = toFiniteNumber(record.statusCode);
    const isSuccess = code != null && code >= 200 && code < 300;
    if (status === 'success' && !isSuccess) return false;
    if (status === 'error' && isSuccess) return false;
    if (status === 'slow') {
      const level = classifyLatency(record.elapsed);
      if (level !== 'slow' && level !== 'very-slow') return false;
    }
    if (status === 'context-attention' && auditContextFilterState(record) !== 'attention') {
      return false;
    }
    if (status === 'context-missing' && auditContextFilterState(record) !== 'missing') {
      return false;
    }
    if (!query) return true;
    return auditRecordSearchText(record).includes(query);
  });
}

export function auditRetryAvailability(record) {
  if (!isRecord(record)) return { available: false, reason: '记录无效，无法重试' };
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return { available: false, reason: '该记录缺少请求 ID，无法重试' };
  const request = isRecord(record.request) ? record.request : null;
  const body = request && typeof request.body === 'string' ? request.body : '';
  if (!body) return { available: false, reason: '该记录未保留请求体，无法安全重试' };
  if (request && request.truncated === true) {
    return { available: false, reason: '请求体已被截断，重试可能产生不同结果' };
  }
  return { available: true, reason: '' };
}

export function pageSize(value, fallback, max) {
  const parsed = toFiniteNumber(value);
  if (parsed == null || parsed <= 0) return fallback;
  return Math.min(Math.round(parsed), max);
}

// Newest items win when the window is smaller than the collection.
export function newestWindow(items, limit) {
  const list = Array.isArray(items) ? items : [];
  const size = toFiniteNumber(limit);
  if (size == null || size <= 0 || size >= list.length) return list.slice();
  return list.slice(list.length - Math.round(size));
}

// Same window as `newestWindow`, but keeps each item's index in the original
// collection so paged views can resolve a clicked item without recomputing the
// filter and risking an index mismatch.
export function newestIndexedWindow(items, limit) {
  const list = Array.isArray(items) ? items : [];
  const size = toFiniteNumber(limit);
  const start =
    size == null || size <= 0 || size >= list.length ? 0 : list.length - Math.round(size);
  return list.slice(start).map((item, offset) => ({ item, index: start + offset }));
}

function csvCell(value) {
  const raw = value == null ? '' : String(value);
  if (raw === '') return '';
  const neutralised = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/[",\r\n]/.test(neutralised)) return `"${neutralised.replace(/"/g, '""')}"`;
  return neutralised;
}

export function buildCsv(columns, rows) {
  const safeColumns = Array.isArray(columns) ? columns : [];
  const safeRows = Array.isArray(rows) ? rows : [];
  if (safeColumns.length === 0) return '';
  const header = safeColumns.map((column) => csvCell(column && column.label)).join(',');
  const lines = safeRows.map((row) => {
    const source = isRecord(row) ? row : {};
    return safeColumns.map((column) => csvCell(source[column && column.id])).join(',');
  });
  return [header, ...lines].join('\r\n');
}

export function sanitizeExportFileName(value, fallback = 'hpm-export') {
  const base = typeof value === 'string' ? value : '';
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

export function exportTimestamp(date = new Date()) {
  const value = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
  return value.toISOString().replace(/[:.]/g, '-');
}

export function buildAuditExportRows(records) {
  const list = Array.isArray(records) ? records : [];
  return list.map((record) => {
    const source = isRecord(record) ? record : {};
    const usage = isRecord(source.usage) ? source.usage : {};
    const cost = isRecord(source.cost) ? source.cost : {};
    const diagnostics = isRecord(source.contextDiagnostics) ? source.contextDiagnostics : {};
    const contextBudget = isRecord(diagnostics.contextBudget) ? diagnostics.contextBudget : {};
    const providerCache = isRecord(diagnostics.providerCache) ? diagnostics.providerCache : {};
    const contextCache = isRecord(contextBudget.contextCache) ? contextBudget.contextCache : {};
    return {
      time: toSearchableText(source.time),
      method: toSearchableText(source.method),
      path: toSearchableText(source.path),
      protocol: toSearchableText(source.protocol),
      profileName: toSearchableText(source.profileName),
      originalModel: toSearchableText(source.originalModel),
      rewriteModel: toSearchableText(source.rewriteModel),
      statusCode: source.statusCode == null ? '' : toSearchableText(source.statusCode),
      elapsed: source.elapsed == null ? '' : toSearchableText(source.elapsed),
      inputTokens: usage.inputTokens == null ? '' : toSearchableText(usage.inputTokens),
      outputTokens: usage.outputTokens == null ? '' : toSearchableText(usage.outputTokens),
      totalTokens: usage.totalTokens == null ? '' : toSearchableText(usage.totalTokens),
      cost: cost.amount == null ? '' : toSearchableText(cost.amount),
      contextDiagnostics: isRecord(source.contextDiagnostics) ? 'yes' : 'no',
      contextBudgetPolicy: toSearchableText(contextBudget.policy),
      contextDroppedCount:
        contextBudget.droppedCount == null ? '' : toSearchableText(contextBudget.droppedCount),
      contextOptimizedCount:
        contextBudget.optimizedCount == null ? '' : toSearchableText(contextBudget.optimizedCount),
      contextStablePrefixTokens:
        contextCache.stablePrefixTokens == null
          ? ''
          : toSearchableText(contextCache.stablePrefixTokens),
      providerCacheState: providerCache.applied
        ? 'applied'
        : providerCache.candidate
          ? 'candidate'
          : providerCache.enabled
            ? 'enabled'
            : '',
    };
  });
}

export const AUDIT_EXPORT_COLUMNS = Object.freeze([
  Object.freeze({ id: 'time', label: 'time' }),
  Object.freeze({ id: 'method', label: 'method' }),
  Object.freeze({ id: 'path', label: 'path' }),
  Object.freeze({ id: 'protocol', label: 'protocol' }),
  Object.freeze({ id: 'profileName', label: 'profileName' }),
  Object.freeze({ id: 'originalModel', label: 'originalModel' }),
  Object.freeze({ id: 'rewriteModel', label: 'rewriteModel' }),
  Object.freeze({ id: 'statusCode', label: 'statusCode' }),
  Object.freeze({ id: 'elapsed', label: 'elapsedMs' }),
  Object.freeze({ id: 'inputTokens', label: 'inputTokens' }),
  Object.freeze({ id: 'outputTokens', label: 'outputTokens' }),
  Object.freeze({ id: 'totalTokens', label: 'totalTokens' }),
  Object.freeze({ id: 'cost', label: 'estimatedCost' }),
  Object.freeze({ id: 'contextDiagnostics', label: 'contextDiagnostics' }),
  Object.freeze({ id: 'contextBudgetPolicy', label: 'contextBudgetPolicy' }),
  Object.freeze({ id: 'contextDroppedCount', label: 'contextDroppedCount' }),
  Object.freeze({ id: 'contextOptimizedCount', label: 'contextOptimizedCount' }),
  Object.freeze({ id: 'contextStablePrefixTokens', label: 'contextStablePrefixTokens' }),
  Object.freeze({ id: 'providerCacheState', label: 'providerCacheState' }),
]);

export function buildAuditExportCsv(records) {
  return buildCsv(AUDIT_EXPORT_COLUMNS, buildAuditExportRows(records));
}

function usageContextExportFields(context) {
  const source = isRecord(context) ? context : {};
  return {
    contextRecords: toSearchableText(source.records || 0),
    contextMissingDiagnostics: toSearchableText(source.missingDiagnostics || 0),
    contextAttentionRecords: toSearchableText(source.attentionRecords || 0),
    contextOverBudgetRecords: toSearchableText(source.overBudgetRecords || 0),
    contextOptimizedRecords: toSearchableText(source.optimizedRecords || 0),
    contextDroppedRecords: toSearchableText(source.droppedRecords || 0),
    contextOptimizedMessages: toSearchableText(source.optimizedMessages || 0),
    contextDroppedMessages: toSearchableText(source.droppedMessages || 0),
    contextOverBudgetTokens: toSearchableText(source.overBudgetTokens || 0),
    contextSavedChars: toSearchableText(source.savedChars || 0),
    contextStablePrefixCandidates: toSearchableText(source.stablePrefixCandidates || 0),
    providerCacheEnabled: toSearchableText(source.providerCacheEnabled || 0),
    providerCacheCandidates: toSearchableText(source.providerCacheCandidates || 0),
    providerCacheApplied: toSearchableText(source.providerCacheApplied || 0),
  };
}

export function buildUsageReportExportRows(report) {
  const groups = [
    ['total', [isRecord(report) ? report.total : null]],
    ['profile', isRecord(report) && Array.isArray(report.byProfile) ? report.byProfile : []],
    ['model', isRecord(report) && Array.isArray(report.byModel) ? report.byModel : []],
    ['day', isRecord(report) && Array.isArray(report.byDay) ? report.byDay : []],
  ];
  return groups.flatMap(([groupType, rows]) =>
    rows.filter(isRecord).map((row) => ({
      groupType,
      key: toSearchableText(row.key),
      label: toSearchableText(row.label),
      requests: toSearchableText(row.requests || 0),
      successes: toSearchableText(row.successes || 0),
      errors: toSearchableText(row.errors || 0),
      inputTokens: toSearchableText(row.inputTokens || 0),
      cachedInputTokens: toSearchableText(row.cachedInputTokens || 0),
      outputTokens: toSearchableText(row.outputTokens || 0),
      totalTokens: toSearchableText(row.totalTokens || 0),
      estimatedRecords: toSearchableText(row.estimatedRecords || 0),
      providerRecords: toSearchableText(row.providerRecords || 0),
      cacheHitRate: toSearchableText(row.cacheHitRate || 0),
      estimatedCost: toSearchableText(row.cost || 0),
      ...usageContextExportFields(row.context),
    }))
  );
}

export const USAGE_REPORT_EXPORT_COLUMNS = Object.freeze([
  Object.freeze({ id: 'groupType', label: 'groupType' }),
  Object.freeze({ id: 'key', label: 'key' }),
  Object.freeze({ id: 'label', label: 'label' }),
  Object.freeze({ id: 'requests', label: 'requests' }),
  Object.freeze({ id: 'successes', label: 'successes' }),
  Object.freeze({ id: 'errors', label: 'errors' }),
  Object.freeze({ id: 'inputTokens', label: 'inputTokens' }),
  Object.freeze({ id: 'cachedInputTokens', label: 'cachedInputTokens' }),
  Object.freeze({ id: 'outputTokens', label: 'outputTokens' }),
  Object.freeze({ id: 'totalTokens', label: 'totalTokens' }),
  Object.freeze({ id: 'estimatedRecords', label: 'estimatedRecords' }),
  Object.freeze({ id: 'providerRecords', label: 'providerRecords' }),
  Object.freeze({ id: 'cacheHitRate', label: 'cacheHitRate' }),
  Object.freeze({ id: 'estimatedCost', label: 'estimatedCost' }),
  Object.freeze({ id: 'contextRecords', label: 'contextRecords' }),
  Object.freeze({ id: 'contextMissingDiagnostics', label: 'contextMissingDiagnostics' }),
  Object.freeze({ id: 'contextAttentionRecords', label: 'contextAttentionRecords' }),
  Object.freeze({ id: 'contextOverBudgetRecords', label: 'contextOverBudgetRecords' }),
  Object.freeze({ id: 'contextOptimizedRecords', label: 'contextOptimizedRecords' }),
  Object.freeze({ id: 'contextDroppedRecords', label: 'contextDroppedRecords' }),
  Object.freeze({ id: 'contextOptimizedMessages', label: 'contextOptimizedMessages' }),
  Object.freeze({ id: 'contextDroppedMessages', label: 'contextDroppedMessages' }),
  Object.freeze({ id: 'contextOverBudgetTokens', label: 'contextOverBudgetTokens' }),
  Object.freeze({ id: 'contextSavedChars', label: 'contextSavedChars' }),
  Object.freeze({ id: 'contextStablePrefixCandidates', label: 'contextStablePrefixCandidates' }),
  Object.freeze({ id: 'providerCacheEnabled', label: 'providerCacheEnabled' }),
  Object.freeze({ id: 'providerCacheCandidates', label: 'providerCacheCandidates' }),
  Object.freeze({ id: 'providerCacheApplied', label: 'providerCacheApplied' }),
]);

export function buildUsageReportExportCsv(report) {
  return buildCsv(USAGE_REPORT_EXPORT_COLUMNS, buildUsageReportExportRows(report));
}

export function buildMonitorExportPayload(groups, options = {}) {
  const list = Array.isArray(groups) ? groups : [];
  return {
    exportedAt: new Date().toISOString(),
    source: 'https-proxy-manager/monitor',
    filters: {
      range: normalizeInspectionRange(options.range),
      status: normalizeMonitorStatus(options.status),
      query: typeof options.query === 'string' ? options.query : '',
    },
    requestCount: list.length,
    requests: list.map((group) => {
      const source = isRecord(group) ? group : {};
      return {
        reqId: toSearchableText(source.reqId),
        method: toSearchableText(source.method),
        path: toSearchableText(source.path),
        statusCode: source.statusCode == null ? null : toFiniteNumber(source.statusCode),
        elapsed: source.elapsed == null ? null : toFiniteNumber(source.elapsed),
        latency: classifyLatency(source.elapsed),
        profileName: toSearchableText(source.profileName),
        protocol: toSearchableText(source.protocol),
        sourceModel: toSearchableText(source.sourceModel),
        targetModel: toSearchableText(source.targetModel),
        routed: source.routed === true,
        error: toSearchableText(source.error),
        events: Array.isArray(source.events) ? source.events : [],
      };
    }),
  };
}
