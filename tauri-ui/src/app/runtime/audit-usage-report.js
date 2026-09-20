import {
  auditCacheCell,
  auditCachedInputLabel,
  auditCacheHitRate,
  formatAuditCost,
  formatAuditTokens,
} from './audit-format.js';

function appendText(parent, text, tagName = 'span', className = '') {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text == null ? '' : String(text);
  parent.appendChild(element);
  return element;
}

function createCodeTextElement(text) {
  const code = document.createElement('code');
  code.textContent = text == null ? '' : String(text);
  return code;
}

export function createUsageMetricElement(label, value, sub = '') {
  const metric = document.createElement('div');
  metric.className = 'usage-metric';
  appendText(metric, label, 'div', 'usage-metric-label');
  appendText(metric, value, 'div', 'usage-metric-value');
  if (sub) appendText(metric, sub, 'div', 'usage-metric-sub');
  return metric;
}

export function createUsageEmptyElement(message = '暂无记录') {
  const empty = document.createElement('div');
  empty.className = 'usage-empty';
  empty.textContent = message;
  return empty;
}

function usageContextLabel(context = {}) {
  const attention = Number(context.attentionRecords || 0);
  const missing = Number(context.missingDiagnostics || 0);
  if (attention > 0) return `${formatAuditTokens(attention)} 注意`;
  if (missing > 0) return `${formatAuditTokens(missing)} 缺诊断`;
  return '健康';
}

function usageContextSubLabel(context = {}) {
  const parts = [];
  const optimized = Number(context.optimizedMessages || 0);
  const dropped = Number(context.droppedMessages || 0);
  const overBudget = Number(context.overBudgetRecords || 0);
  const providerApplied = Number(context.providerCacheApplied || 0);
  const providerCandidates = Number(context.providerCacheCandidates || 0);
  if (optimized > 0) parts.push(`折叠 ${formatAuditTokens(optimized)}`);
  if (dropped > 0) parts.push(`丢弃 ${formatAuditTokens(dropped)}`);
  if (overBudget > 0) parts.push(`超预算 ${formatAuditTokens(overBudget)}`);
  if (providerApplied > 0 || providerCandidates > 0) {
    parts.push(
      `Provider Cache ${formatAuditTokens(providerApplied)}/${formatAuditTokens(providerCandidates)}`
    );
  }
  return parts.length ? parts.join(' · ') : '无裁剪或缺失';
}

export function createUsageSummaryElements(total = {}) {
  return [
    createUsageMetricElement(
      '请求数',
      formatAuditTokens(total.requests),
      `${formatAuditTokens(total.successes)} 成功 / ${formatAuditTokens(total.errors)} 异常`
    ),
    createUsageMetricElement(
      '输入 Token',
      formatAuditTokens(total.inputTokens),
      auditCachedInputLabel(total)
    ),
    createUsageMetricElement('输出 Token', formatAuditTokens(total.outputTokens)),
    createUsageMetricElement(
      '估算成本',
      formatAuditCost({ known: total.cost > 0, amount: total.cost }),
      'USD'
    ),
    createUsageMetricElement(
      '上下文',
      usageContextLabel(total.context),
      usageContextSubLabel(total.context)
    ),
  ];
}

function appendUsageHeaderRow(thead, labels) {
  const tr = document.createElement('tr');
  labels.forEach((label) => appendText(tr, label, 'th'));
  thead.appendChild(tr);
}

function appendUsageCell(row, value, options = {}) {
  const td = document.createElement('td');
  if (options.code) {
    td.appendChild(createCodeTextElement(value));
  } else if (options.strong) {
    appendText(td, value, 'strong');
  } else {
    td.textContent = value;
  }
  row.appendChild(td);
  return td;
}

export function createUsageTableElement(rows, type) {
  if (!rows.length) return createUsageEmptyElement('暂无记录');

  const table = document.createElement('table');
  table.className = 'usage-table';
  const thead = document.createElement('thead');
  appendUsageHeaderRow(thead, [
    type === 'profile' ? '上游目标' : '模型',
    '请求',
    '输入',
    '缓存命中',
    '上下文',
    '输出',
    '成本',
  ]);
  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    const labelCell = appendUsageCell(tr, row.label || row.key || '-', { strong: true });
    if (row.estimatedRecords) {
      appendText(labelCell, `${row.estimatedRecords} 条估算`, 'div', 'muted');
    }
    appendUsageCell(tr, formatAuditTokens(row.requests));
    appendUsageCell(tr, formatAuditTokens(row.inputTokens));
    appendUsageCell(tr, auditCacheCell(row.cachedInputTokens, row.cacheHitRate));
    appendUsageCell(tr, usageContextLabel(row.context));
    appendUsageCell(tr, formatAuditTokens(row.outputTokens));
    appendUsageCell(tr, formatAuditCost({ known: row.cost > 0, amount: row.cost }));
    tbody.appendChild(tr);
  });
  table.appendChild(thead);
  table.appendChild(tbody);
  return table;
}

export function createUsageRecentElement(rows) {
  if (!rows.length) return createUsageEmptyElement('暂无记录');

  const table = document.createElement('table');
  table.className = 'usage-table usage-table-recent';
  const thead = document.createElement('thead');
  appendUsageHeaderRow(thead, ['时间', '上游', '模型', 'Token', '缓存', '成本', '状态']);
  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    appendUsageCell(tr, new Date(row.time).toLocaleString());
    appendUsageCell(tr, row.profileName || '-');
    appendUsageCell(tr, row.model || '-', { code: true });
    appendUsageCell(tr, formatAuditTokens((row.usage && row.usage.totalTokens) || 0));
    appendUsageCell(
      tr,
      row.usage && row.usage.cachedInputTokens
        ? `${Math.round(auditCacheHitRate(row.usage) * 100)}%`
        : '-'
    );
    appendUsageCell(tr, formatAuditCost(row.cost));
    const statusCell = document.createElement('td');
    appendText(
      statusCell,
      String(row.statusCode || '???'),
      'span',
      `audit-badge ${row.statusCode >= 200 && row.statusCode < 300 ? 'success' : 'error'}`
    );
    tr.appendChild(statusCell);
    tbody.appendChild(tr);
  });
  table.appendChild(thead);
  table.appendChild(tbody);
  return table;
}
