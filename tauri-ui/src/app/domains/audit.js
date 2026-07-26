import Chart from 'chart.js/auto';
import { bindDomainDependencies } from '../runtime/dependencies.js';
import { reportFrontendError } from '../runtime/frontend-errors.js';

let auditDependencies;

export function configureAudit(dependencies) {
  auditDependencies = bindDomainDependencies('audit', dependencies, [
    '$',
    'confirmAction',
    'escapeHtml',
    'showToast',
    'showView',
    'togglePromptsTab',
  ]);
}

let selectedAuditRecordId = null;
let cachedAuditRecords = [];
let usageChartInstance = null;
const AUDIT_LIST_LIMIT = 30;
const AUDIT_SNIPPET_CHARS = 180;
const AUDIT_SYSTEM_PREVIEW_CHARS = 6000;
const AUDIT_MESSAGE_PREVIEW_CHARS = 5000;
const AUDIT_TOOL_PREVIEW_CHARS = 4000;
const AUDIT_INSPECTOR_PREVIEW_CHARS = 12000;

function formatAuditTokens(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString();
}

function formatAuditCost(cost) {
  if (!cost || !cost.known) return '未匹配单价';
  const amount = Number(cost.amount || 0);
  if (!Number.isFinite(amount)) return '未匹配单价';
  if (amount > 0 && amount < 0.0001) return `< $0.0001`;
  return `$${amount.toFixed(4)}`;
}

function auditUpstreamModel(record) {
  const rewriteModel = String((record && record.rewriteModel) || '').trim();
  if (rewriteModel && rewriteModel !== '-') return rewriteModel;
  return String((record && record.originalModel) || '').trim();
}

function auditModelFlowLabel(record) {
  const originalModel = String((record && record.originalModel) || '').trim();
  const upstreamModel = auditUpstreamModel(record);
  if (!originalModel && !upstreamModel) return '未知模型';
  if (originalModel && upstreamModel && upstreamModel !== originalModel) {
    return `${originalModel} -> ${upstreamModel}`;
  }
  return upstreamModel || originalModel;
}

function formatAuditJson(value, limit = AUDIT_INSPECTOR_PREVIEW_CHARS) {
  let text;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value == null ? null : value, null, 2);
    } catch (err) {
      text = String(value);
    }
  }
  return truncateAuditText(text, limit);
}

function renderUsageMetric(label, value, sub = '') {
  return `
    <div class="usage-metric">
      <div class="usage-metric-label">${auditDependencies.escapeHtml(label)}</div>
      <div class="usage-metric-value">${auditDependencies.escapeHtml(value)}</div>
      ${sub ? `<div class="usage-metric-sub">${auditDependencies.escapeHtml(sub)}</div>` : ''}
    </div>
  `;
}

function createUsageMetricElement(label, value, sub = '') {
  const metric = document.createElement('div');
  metric.className = 'usage-metric';
  appendAuditText(metric, label, 'div', 'usage-metric-label');
  appendAuditText(metric, value, 'div', 'usage-metric-value');
  if (sub) appendAuditText(metric, sub, 'div', 'usage-metric-sub');
  return metric;
}

function createUsageEmptyElement(message = '暂无记录') {
  const empty = document.createElement('div');
  empty.className = 'usage-empty';
  empty.textContent = message;
  return empty;
}

function truncateAuditText(value, limit) {
  const text = String(value == null ? '' : value);
  if (text.length <= limit) return { text, truncated: false };
  return {
    text:
      text.slice(0, limit) +
      `\n\n...[已截断 ${text.length - limit} 字符，导出 Markdown 可查看完整内容]`,
    truncated: true,
  };
}

function auditContentToText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((block) => {
      if (!block) return '';
      if (block.type === 'text') return block.text || '';
      if (block.type === 'tool_result')
        return typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function createAuditNoticeElement(message, options = {}) {
  const box = document.createElement('div');
  box.style.padding = '20px';
  box.style.textAlign = 'center';
  box.style.color = options.danger ? 'var(--danger)' : 'var(--muted)';
  box.style.fontSize = '12px';
  if (options.breakAll) box.style.wordBreak = 'break-all';
  if (options.prefix) {
    const prefix = document.createElement('div');
    prefix.textContent = options.prefix;
    box.appendChild(prefix);
  }
  const text = document.createElement('div');
  text.textContent = message;
  box.appendChild(text);
  return box;
}

function createAuditSvgElement(attributes = {}, children = []) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  Object.entries(attributes).forEach(([key, value]) => svg.setAttribute(key, value));
  children.forEach((child) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', child.tag);
    Object.entries(child.attributes || {}).forEach(([key, value]) => node.setAttribute(key, value));
    svg.appendChild(node);
  });
  return svg;
}

function createAuditMessageIcon() {
  return createAuditSvgElement(
    {
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
    [
      {
        tag: 'path',
        attributes: {
          d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
        },
      },
    ]
  );
}

function createAuditChevronIcon(size = 12) {
  return createAuditSvgElement(
    {
      width: String(size),
      height: String(size),
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
    [{ tag: 'polyline', attributes: { points: '6 9 12 15 18 9' } }]
  );
}

function createAuditToolIcon() {
  return createAuditSvgElement(
    {
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
    [
      { tag: 'circle', attributes: { cx: '12', cy: '12', r: '3' } },
      {
        tag: 'path',
        attributes: {
          d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
        },
      },
    ]
  );
}

function createAuditDetailPlaceholderElement(message = '选择左侧记录查看详情') {
  const placeholder = document.createElement('div');
  placeholder.className = 'audit-detail-placeholder';
  placeholder.appendChild(createAuditMessageIcon());
  const text = document.createElement('p');
  text.textContent = message;
  placeholder.appendChild(text);
  return placeholder;
}

function appendAuditText(parent, text, tagName = 'span', className = '') {
  const el = document.createElement(tagName);
  if (className) el.className = className;
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

function createAuditCodeTextElement(text) {
  const code = document.createElement('code');
  code.textContent = text;
  return code;
}

function setAuditDetailPlaceholder(message = '选择左侧记录查看详情') {
  const panel = auditDependencies.$('auditDetailPanel');
  if (!panel) return;
  panel.textContent = '';
  panel.appendChild(createAuditDetailPlaceholderElement(message));
}

function renderEmptyAuditState(listMessage = '暂无对话审计记录', detailMessage = '暂无对话记录') {
  cachedAuditRecords = [];
  selectedAuditRecordId = null;
  const listContainer = auditDependencies.$('auditHistoryList');
  if (listContainer) {
    listContainer.textContent = '';
    listContainer.appendChild(createAuditNoticeElement(listMessage));
  }
  setAuditDetailPlaceholder(detailMessage);
}

// 简易 Markdown 解析逻辑
function safeAuditCodeLanguage(value) {
  const lang = String(value || '')
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(lang)) return '';
  return lang;
}

function appendAuditInlineMarkdown(parent, text) {
  String(text || '')
    .split(/(`[^`]+`)/g)
    .forEach((part) => {
      if (!part) return;
      if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
        const code = document.createElement('code');
        code.textContent = part.slice(1, -1);
        parent.appendChild(code);
      } else {
        parent.appendChild(document.createTextNode(part));
      }
    });
}

function appendAuditMarkdownParagraph(container, lines) {
  if (!lines.length) return;
  const p = document.createElement('p');
  lines.forEach((line, index) => {
    if (index > 0) p.appendChild(document.createElement('br'));
    appendAuditInlineMarkdown(p, line);
  });
  container.appendChild(p);
}

function renderAuditMarkdown(text) {
  const container = document.createElement('div');
  container.className = 'audit-markdown-content';
  const lines = String(text || '').split('\n');
  let paragraphLines = [];
  let inCodeBlock = false;
  let codeLanguage = '';
  let codeLines = [];

  const flushParagraph = () => {
    appendAuditMarkdownParagraph(container, paragraphLines);
    paragraphLines = [];
  };
  const flushCodeBlock = () => {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    const safeLang = safeAuditCodeLanguage(codeLanguage);
    if (safeLang) code.className = `language-${safeLang}`;
    code.textContent = codeLines.join('\n');
    pre.appendChild(code);
    container.appendChild(pre);
    codeLines = [];
    codeLanguage = '';
  };

  lines.forEach((line) => {
    if (inCodeBlock) {
      if (line === '```') {
        flushCodeBlock();
        inCodeBlock = false;
      } else {
        codeLines.push(line);
      }
      return;
    }
    if (line.startsWith('```')) {
      flushParagraph();
      inCodeBlock = true;
      codeLanguage = line.slice(3);
      codeLines = [];
      return;
    }
    if (line.trim() === '') {
      flushParagraph();
      return;
    }
    paragraphLines.push(line);
  });

  if (inCodeBlock) flushCodeBlock();
  flushParagraph();
  return container;
}

if (typeof window !== 'undefined') {
  window.__auditTest = {
    createAuditDetailHeaderElement,
    createAuditDetailPlaceholderElement,
    createAuditHistoryItemElement,
    createAuditInspectorElement,
    createAuditMessageElement,
    createAuditNoticeElement,
    createAuditSystemPanelElement,
    createAuditToolCallElement,
    createUsageEmptyElement,
    createUsageMetricElement,
    createUsageRecentElement,
    createUsageTableElement,
    renderEmptyAuditState,
    renderAuditMarkdown,
    safeAuditCodeLanguage,
  };
}

function auditHistoryRecordView(record) {
  let userSnippet = '无输入内容';
  if (record.messages && Array.isArray(record.messages)) {
    const firstUser = record.messages.find((m) => m.role === 'user');
    if (firstUser && firstUser.content) {
      userSnippet = auditContentToText(firstUser.content) || '无输入内容';
    }
  }
  userSnippet = truncateAuditText(userSnippet, AUDIT_SNIPPET_CHARS).text;

  const date = new Date(record.time);
  const timeStr = date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const latency = record.elapsed ? `${record.elapsed}ms` : '??? ms';
  const isSuccess = record.statusCode >= 200 && record.statusCode < 300;
  const usage = record.usage || {};
  const modelFlow = auditModelFlowLabel(record);
  const upstreamModel = auditUpstreamModel(record);
  return {
    timeStr,
    statusCode: record.statusCode || '???',
    isSuccess,
    protocolLabel: record.protocol === 'claude' ? 'Claude' : 'OpenAI',
    modelFlow,
    userSnippet,
    upstreamLine: `上游: ${upstreamModel || '未指定'} · ${record.profileName || '默认'}`,
    metricsLine: `${formatAuditTokens(usage.totalTokens || 0)} tok · ${latency}`,
  };
}

function createAuditHistoryItemElement(record, index, recordId, isActive) {
  const view = auditHistoryRecordView(record);
  const item = document.createElement('div');
  item.className = 'audit-item';
  item.dataset.auditId = recordId;
  item.dataset.auditIndex = String(index);
  if (isActive) item.classList.add('active');

  const meta = document.createElement('div');
  meta.className = 'audit-item-meta';
  const time = document.createElement('span');
  time.textContent = view.timeStr;
  const badge = document.createElement('span');
  badge.className = `audit-badge ${view.isSuccess ? 'success' : 'error'}`;
  badge.textContent = String(view.statusCode);
  meta.appendChild(time);
  meta.appendChild(badge);

  const info = document.createElement('div');
  info.className = 'audit-item-info';
  const protocol = document.createElement('span');
  protocol.style.fontWeight = '600';
  protocol.style.color = 'var(--primary)';
  protocol.textContent = view.protocolLabel;
  const model = document.createElement('span');
  model.style.color = 'var(--muted)';
  model.style.fontSize = '11px';
  model.style.maxWidth = '190px';
  model.style.overflow = 'hidden';
  model.style.textOverflow = 'ellipsis';
  model.style.whiteSpace = 'nowrap';
  model.textContent = view.modelFlow;
  info.appendChild(protocol);
  info.appendChild(model);

  const snippet = document.createElement('div');
  snippet.className = 'audit-item-snippet';
  snippet.textContent = view.userSnippet;

  const footer = document.createElement('div');
  footer.style.fontSize = '10px';
  footer.style.color = 'var(--muted)';
  footer.style.marginTop = '2px';
  footer.style.display = 'flex';
  footer.style.justifyContent = 'space-between';
  const upstream = document.createElement('span');
  upstream.textContent = view.upstreamLine;
  const metrics = document.createElement('span');
  metrics.textContent = view.metricsLine;
  footer.appendChild(upstream);
  footer.appendChild(metrics);

  item.appendChild(meta);
  item.appendChild(info);
  item.appendChild(snippet);
  item.appendChild(footer);
  return item;
}

function createAuditMetricElement(label, value, sub = '') {
  const metric = document.createElement('div');
  metric.className = 'audit-usage-metric';

  appendAuditText(metric, label, 'span');
  appendAuditText(metric, value, 'strong');
  if (sub) appendAuditText(metric, sub, 'small');

  return metric;
}

async function initPromptsAuditView() {
  // 绑定动作（如果尚未绑定）
  const refreshBtn = auditDependencies.$('refreshAudit');
  const clearBtn = auditDependencies.$('clearAudit');
  if (refreshBtn && !refreshBtn.dataset.bound) {
    refreshBtn.dataset.bound = 'true';
    refreshBtn.onclick = () => loadAuditRecords();
  }
  if (clearBtn && !clearBtn.dataset.bound) {
    clearBtn.dataset.bound = 'true';
    clearBtn.onclick = () => {
      auditDependencies.confirmAction(
        '确定要清空所有的对话审计日志吗？此操作将永久清空本地的 conversations-audit.jsonl 文件。',
        async () => {
          clearBtn.disabled = true;
          try {
            const res = await window.proxyManager.clearAuditConversations();
            if (res && res.ok !== false) {
              auditDependencies.showToast('对话审计日志已清空', 'success');
              renderEmptyAuditState();
              await loadAuditRecords();
            } else {
              auditDependencies.showToast(
                '清空日志失败: ' + ((res && res.error) || '未知错误'),
                'error'
              );
            }
          } finally {
            clearBtn.disabled = false;
          }
        }
      );
    };
  }

  await loadAuditRecords();
}

async function initUsageReportView() {
  const refreshBtn = auditDependencies.$('refreshUsageReport');
  const windowSelect = auditDependencies.$('usageReportWindow');
  if (refreshBtn && !refreshBtn.dataset.bound) {
    refreshBtn.dataset.bound = 'true';
    refreshBtn.onclick = () => loadUsageReport();
  }
  if (windowSelect && !windowSelect.dataset.bound) {
    windowSelect.dataset.bound = 'true';
    windowSelect.onchange = () => loadUsageReport();
  }
  await loadUsageReport();
}

function usageWindowAfter(value) {
  const now = new Date();
  if (value === 'today') {
    now.setHours(0, 0, 0, 0);
    return now.toISOString();
  }
  if (value === '7d') return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  if (value === '30d') return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  return '';
}

async function loadUsageReport() {
  const summary = auditDependencies.$('usageReportSummary');
  const byProfile = auditDependencies.$('usageByProfile');
  const byModel = auditDependencies.$('usageByModel');
  const recent = auditDependencies.$('usageRecent');
  if (!summary || !byProfile || !byModel || !recent) return;
  summary.textContent = '';
  summary.appendChild(createAuditNoticeElement('正在加载...'));
  byProfile.textContent = '';
  byModel.textContent = '';
  recent.textContent = '';
  try {
    const windowValue = auditDependencies.$('usageReportWindow')
      ? auditDependencies.$('usageReportWindow').value
      : '';
    const report = await window.proxyManager.readUsageReport({
      limit: 300,
      after: usageWindowAfter(windowValue),
    });
    if (!report || report.ok === false) throw new Error((report && report.error) || '读取失败');
    renderUsageReport(report);
  } catch (err) {
    summary.textContent = '';
    summary.appendChild(createUsageEmptyElement(`读取使用报告失败：${err.message}`));
  }
}

function renderUsageReport(report) {
  const total = report.total || {};
  const estimated = Number(total.estimatedRecords || 0);
  const meta = auditDependencies.$('usageReportMeta');
  if (meta) {
    meta.textContent = `生成于 ${new Date(report.generatedAt || Date.now()).toLocaleString()} · ${estimated ? `${estimated} 条为估算 Token` : '全部使用真实 usage 或可用记录'}`;
  }

  const summary = auditDependencies.$('usageReportSummary');
  const byProfile = auditDependencies.$('usageByProfile');
  const byModel = auditDependencies.$('usageByModel');
  const recent = auditDependencies.$('usageRecent');
  if (summary) {
    summary.textContent = '';
    [
      createUsageMetricElement(
        '请求数',
        formatAuditTokens(total.requests),
        `${formatAuditTokens(total.successes)} 成功 / ${formatAuditTokens(total.errors)} 异常`
      ),
      createUsageMetricElement(
        '输入 Token',
        formatAuditTokens(total.inputTokens),
        total.cachedInputTokens ? `缓存 ${formatAuditTokens(total.cachedInputTokens)}` : ''
      ),
      createUsageMetricElement('输出 Token', formatAuditTokens(total.outputTokens)),
      createUsageMetricElement(
        '估算成本',
        formatAuditCost({ known: total.cost > 0, amount: total.cost }),
        'USD'
      ),
    ].forEach((node) => summary.appendChild(node));
  }
  if (byProfile) {
    byProfile.textContent = '';
    byProfile.appendChild(createUsageTableElement(report.byProfile || [], 'profile'));
  }
  if (byModel) {
    byModel.textContent = '';
    byModel.appendChild(createUsageTableElement(report.byModel || [], 'model'));
  }
  if (recent) {
    recent.textContent = '';
    recent.appendChild(createUsageRecentElement(report.recent || []));
  }
  updateUsageChart(report.byDay || []);
}

function updateUsageChart(dayData) {
  const ctx = auditDependencies.$('usageChart');
  if (!ctx) return;

  const labels = dayData.map((d) => d.key);
  const inputTokens = dayData.map((d) => d.inputTokens);
  const outputTokens = dayData.map((d) => d.outputTokens);

  if (usageChartInstance) {
    usageChartInstance.destroy();
  }

  if (typeof Chart === 'undefined') {
    reportFrontendError('audit.chart_unavailable', new Error('Chart.js not loaded'));
    return;
  }

  usageChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: '输入 Token',
          data: inputTokens,
          backgroundColor: 'rgba(59, 130, 246, 0.6)',
          borderColor: 'rgb(59, 130, 246)',
          borderWidth: 1,
        },
        {
          label: '输出 Token',
          data: outputTokens,
          backgroundColor: 'rgba(16, 185, 129, 0.6)',
          borderColor: 'rgb(16, 185, 129)',
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true },
        y: { stacked: true, beginAtZero: true },
      },
      plugins: {
        legend: { position: 'top' },
        tooltip: { mode: 'index', intersect: false },
      },
    },
  });
}

function appendUsageHeaderRow(thead, labels) {
  const tr = document.createElement('tr');
  labels.forEach((label) => appendAuditText(tr, label, 'th'));
  thead.appendChild(tr);
}

function appendUsageCell(row, value, options = {}) {
  const td = document.createElement('td');
  if (options.code) {
    td.appendChild(createAuditCodeTextElement(value));
  } else if (options.strong) {
    appendAuditText(td, value, 'strong');
  } else {
    td.textContent = value;
  }
  row.appendChild(td);
  return td;
}

function createUsageTableElement(rows, type) {
  if (!rows.length) return createUsageEmptyElement('暂无记录');

  const table = document.createElement('table');
  table.className = 'usage-table';
  const thead = document.createElement('thead');
  appendUsageHeaderRow(thead, [
    type === 'profile' ? '上游目标' : '模型',
    '请求',
    '输入',
    '输出',
    '成本',
  ]);
  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    const labelCell = appendUsageCell(tr, row.label || row.key || '-', { strong: true });
    if (row.estimatedRecords) {
      appendAuditText(labelCell, `${row.estimatedRecords} 条估算`, 'div', 'muted');
    }
    appendUsageCell(tr, formatAuditTokens(row.requests));
    appendUsageCell(tr, formatAuditTokens(row.inputTokens));
    appendUsageCell(tr, formatAuditTokens(row.outputTokens));
    appendUsageCell(tr, formatAuditCost({ known: row.cost > 0, amount: row.cost }));
    tbody.appendChild(tr);
  });
  table.appendChild(thead);
  table.appendChild(tbody);
  return table;
}

function createUsageRecentElement(rows) {
  if (!rows.length) return createUsageEmptyElement('暂无记录');

  const table = document.createElement('table');
  table.className = 'usage-table usage-table-recent';
  const thead = document.createElement('thead');
  appendUsageHeaderRow(thead, ['时间', '上游', '模型', 'Token', '成本', '状态']);
  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    appendUsageCell(tr, new Date(row.time).toLocaleString());
    appendUsageCell(tr, row.profileName || '-');
    appendUsageCell(tr, row.model || '-', { code: true });
    appendUsageCell(tr, formatAuditTokens((row.usage && row.usage.totalTokens) || 0));
    appendUsageCell(tr, formatAuditCost(row.cost));
    const statusCell = document.createElement('td');
    appendAuditText(
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

async function loadAuditRecords() {
  const listContainer = auditDependencies.$('auditHistoryList');
  if (!listContainer) return;
  listContainer.textContent = '';
  listContainer.appendChild(createAuditNoticeElement('正在加载对话审计日志...'));

  try {
    const rawRes = await window.proxyManager.readAuditConversations(AUDIT_LIST_LIMIT);
    const res = rawRes && Array.isArray(rawRes.conversations) ? rawRes.conversations : rawRes;
    if (!res || !Array.isArray(res)) {
      let errMsg = '未知错误';
      if (rawRes) {
        if (rawRes.error) {
          errMsg =
            typeof rawRes.error === 'object'
              ? rawRes.error.message || JSON.stringify(rawRes.error)
              : rawRes.error;
        } else {
          errMsg = JSON.stringify(rawRes);
        }
      }
      listContainer.textContent = '';
      listContainer.appendChild(
        createAuditNoticeElement(errMsg, {
          danger: true,
          breakAll: true,
          prefix: '读取审计日志失败：',
        })
      );
      return;
    }

    cachedAuditRecords = res;
    listContainer.textContent = '';
    if (!listContainer.dataset.delegated) {
      listContainer.dataset.delegated = 'true';
      listContainer.onclick = (event) => {
        const item = event.target.closest('.audit-item[data-audit-index]');
        if (!item || !listContainer.contains(item)) return;
        const record = cachedAuditRecords[Number(item.dataset.auditIndex)];
        if (!record) return;
        document.querySelectorAll('.audit-item').forEach((el) => el.classList.remove('active'));
        item.classList.add('active');
        selectedAuditRecordId = item.dataset.auditId;
        setAuditDetailPlaceholder('正在渲染详情...');
        requestAnimationFrame(() => renderAuditDetail(record));
      };
    }

    if (res.length === 0) {
      renderEmptyAuditState();
      return;
    }

    res.forEach((record, index) => {
      const recordId = record.time + '_' + index;
      const item = createAuditHistoryItemElement(
        record,
        index,
        recordId,
        selectedAuditRecordId === recordId
      );
      listContainer.appendChild(item);
    });

    // 默认选中第一个或保持之前的选中项
    if (selectedAuditRecordId) {
      const found = res.find((r, idx) => r.time + '_' + idx === selectedAuditRecordId);
      if (found) {
        const foundIndex = res.findIndex((r, idx) => r.time + '_' + idx === selectedAuditRecordId);
        if (foundIndex >= 0 && listContainer.children[foundIndex])
          listContainer.children[foundIndex].classList.add('active');
        setAuditDetailPlaceholder('正在渲染详情...');
        requestAnimationFrame(() => renderAuditDetail(found));
        return;
      }
    }

    selectedAuditRecordId = null;
    setAuditDetailPlaceholder(`已加载最近 ${res.length} 条记录，选择一条查看详情`);
  } catch (err) {
    listContainer.textContent = '';
    listContainer.appendChild(
      createAuditNoticeElement(err.message, {
        danger: true,
        breakAll: true,
        prefix: '渲染审计日志失败：',
      })
    );
  }
}

function formatRecordToMarkdown(record) {
  let md = '';
  const date = new Date(record.time);
  md += `# 对话审计纪要 (${date.toLocaleString()})\n\n`;
  md += `- **协议**: ${record.protocol === 'claude' ? 'Claude SSE' : 'OpenAI Protocol'}\n`;
  md += `- **目标上游**: ${record.profileName || '默认'}\n`;
  md += `- **请求模型**: ${record.originalModel || '未指定'}\n`;
  md += `- **上游模型**: ${auditUpstreamModel(record) || '未指定'}\n`;
  if (record.rewriteModel && record.rewriteModel !== '-') {
    md += `- **重写转发**: ${record.rewriteModel}\n`;
  }
  md += `- **状态码**: ${record.statusCode || '???'}\n`;
  md += `- **耗时**: ${record.elapsed ? record.elapsed + 'ms' : '未知'}\n\n`;

  if (record.system) {
    md += `## System Prompt (系统指令)\n\n\`\`\`\n${record.system}\n\`\`\`\n\n`;
  }

  md += `## 对话流\n\n`;

  if (record.messages && Array.isArray(record.messages)) {
    record.messages.forEach((msg) => {
      let roleName = 'Assistant';
      if (msg.role === 'user') roleName = 'User';
      else if (msg.role === 'system') roleName = 'System';

      md += `### ${roleName}\n\n`;

      let contentStr = '';
      const toolCalls = [];

      if (msg.content) {
        if (typeof msg.content === 'string') {
          contentStr = msg.content;
        } else if (Array.isArray(msg.content)) {
          msg.content.forEach((block) => {
            if (block.type === 'text') {
              contentStr += block.text || '';
            } else if (block.type === 'tool_use') {
              toolCalls.push(block);
            }
          });
        }
      }

      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        msg.tool_calls.forEach((tc) => {
          toolCalls.push(tc);
        });
      }

      if (contentStr.trim()) {
        md += `${contentStr.trim()}\n\n`;
      }

      if (toolCalls.length > 0) {
        md += `**调用工具**:\n\n`;
        toolCalls.forEach((tc) => {
          const name = tc.name || (tc.function ? tc.function.name : '未知工具');
          let argsStr = '';
          const inputObj = tc.input || (tc.function ? tc.function.arguments : null);
          if (inputObj) {
            if (typeof inputObj === 'string') {
              try {
                argsStr = JSON.stringify(JSON.parse(inputObj), null, 2);
              } catch (e) {
                argsStr = inputObj;
              }
            } else {
              argsStr = JSON.stringify(inputObj, null, 2);
            }
          }
          md += `#### Tool: \`${name}\`\n\n\`\`\`json\n${argsStr}\n\`\`\`\n\n`;
        });
      }
    });
  }

  if (
    record.response &&
    record.response.tool_calls &&
    Array.isArray(record.response.tool_calls) &&
    record.response.tool_calls.length > 0
  ) {
    md += `### Assistant (Streaming Tool Calls)\n\n`;
    record.response.tool_calls.forEach((tc) => {
      const name = tc.name || (tc.function ? tc.function.name : '未知工具');
      let argsStr = '';
      const inputObj = tc.input || (tc.function ? tc.function.arguments : null);
      if (inputObj) {
        if (typeof inputObj === 'string') {
          try {
            argsStr = JSON.stringify(JSON.parse(inputObj), null, 2);
          } catch (e) {
            argsStr = inputObj;
          }
        } else {
          argsStr = JSON.stringify(inputObj, null, 2);
        }
      }
      md += `#### Tool: \`${name}\`\n\n\`\`\`json\n${argsStr}\n\`\`\`\n\n`;
    });
  }

  return md;
}

function createAuditDetailHeaderElement(record) {
  const date = new Date(record.time);
  const fullTimeStr = date.toLocaleString();
  const latencyStr = record.elapsed ? `${record.elapsed}ms` : '未知耗时';
  const isSuccess = record.statusCode >= 200 && record.statusCode < 300;
  const usage = record.usage || {};
  const cost = record.cost || {};
  const upstreamModel = auditUpstreamModel(record);
  const usageSource = usage.source === 'provider' ? '上游 usage' : '本地估算';

  const header = document.createElement('div');
  header.className = 'audit-detail-header';

  const title = document.createElement('div');
  title.className = 'audit-detail-title';

  appendAuditText(
    title,
    record.protocol === 'claude' ? 'Claude SSE' : 'OpenAI Protocol',
    'span',
    'audit-badge info'
  );
  const upstream = appendAuditText(title, '目标上游: ', 'span');
  upstream.appendChild(createAuditCodeTextElement(record.profileName || '默认'));
  appendAuditText(
    title,
    String(record.statusCode || '???'),
    'span',
    `audit-badge ${isSuccess ? 'success' : 'error'}`
  );

  const retry = document.createElement('button');
  retry.id = 'retryAuditRequestBtn';
  retry.className = 'secondary';
  retry.style.marginLeft = '12px';
  retry.style.fontSize = '11px';
  retry.style.padding = '2px 8px';
  retry.style.minHeight = '24px';
  retry.style.borderRadius = 'var(--radius-sm)';
  retry.disabled = !record.id;
  retry.textContent = '重试';
  title.appendChild(retry);

  const exportBtn = document.createElement('button');
  exportBtn.id = 'exportAuditMarkdownBtn';
  exportBtn.className = 'secondary';
  exportBtn.style.marginLeft = '12px';
  exportBtn.style.fontSize = '11px';
  exportBtn.style.padding = '2px 8px';
  exportBtn.style.minHeight = '24px';
  exportBtn.style.borderRadius = 'var(--radius-sm)';
  exportBtn.textContent = '导出 Markdown';
  title.appendChild(exportBtn);

  const time = appendAuditText(title, fullTimeStr, 'span');
  time.style.fontSize = '12px';
  time.style.color = 'var(--muted)';
  time.style.fontWeight = 'normal';
  time.style.marginLeft = 'auto';

  const meta = document.createElement('div');
  meta.className = 'audit-detail-meta';

  const original = appendAuditText(meta, '请求模型: ', 'span');
  original.appendChild(createAuditCodeTextElement(record.originalModel || '未指定'));
  const upstreamModelEl = appendAuditText(meta, '上游模型: ', 'span');
  upstreamModelEl.appendChild(createAuditCodeTextElement(upstreamModel || '未指定'));
  if (record.rewriteModel && record.rewriteModel !== '-') {
    const rewrite = appendAuditText(meta, '重写转发: ', 'span');
    rewrite.appendChild(createAuditCodeTextElement(record.rewriteModel));
  }
  const latency = appendAuditText(meta, '延迟耗时: ', 'span');
  const latencyValue = appendAuditText(latency, latencyStr, 'strong');
  latencyValue.style.color = 'var(--primary)';

  const metrics = document.createElement('div');
  metrics.className = 'audit-usage-strip';
  metrics.appendChild(
    createAuditMetricElement(
      '输入 Token',
      formatAuditTokens(usage.inputTokens),
      usage.cachedInputTokens ? `缓存 ${formatAuditTokens(usage.cachedInputTokens)}` : usageSource
    )
  );
  metrics.appendChild(
    createAuditMetricElement('输出 Token', formatAuditTokens(usage.outputTokens), usageSource)
  );
  metrics.appendChild(
    createAuditMetricElement('总 Token', formatAuditTokens(usage.totalTokens), usageSource)
  );
  metrics.appendChild(
    createAuditMetricElement(
      '估算成本',
      formatAuditCost(cost),
      cost && cost.pricing
        ? `${cost.pricing.match} · ${cost.currency || 'USD'}`
        : '可在 modelPricing 覆盖'
    )
  );

  header.appendChild(title);
  header.appendChild(meta);
  header.appendChild(metrics);
  return header;
}

function createAuditSystemPanelElement(system) {
  const systemPreview = truncateAuditText(system, AUDIT_SYSTEM_PREVIEW_CHARS);
  const panel = document.createElement('div');
  panel.className = 'audit-system-panel collapsed';
  panel.id = 'auditSystemPanel';

  const header = document.createElement('div');
  header.className = 'audit-system-header';
  header.dataset.auditToggleSystem = '';
  appendAuditText(
    header,
    `System Prompt (系统预设背景指令)${systemPreview.truncated ? ' · 已截断显示' : ''}`,
    'span'
  );

  const actions = document.createElement('div');
  actions.style.marginLeft = 'auto';
  actions.style.display = 'flex';
  actions.style.gap = '8px';
  actions.style.alignItems = 'center';

  const save = document.createElement('button');
  save.id = 'saveSystemPromptToTemplatesBtn';
  save.className = 'secondary';
  save.style.fontSize = '11px';
  save.style.padding = '2px 8px';
  save.style.minHeight = '24px';
  save.style.borderRadius = 'var(--radius-sm)';
  save.style.pointerEvents = 'auto';
  save.textContent = '另存为模板';
  actions.appendChild(save);

  const arrow = document.createElement('span');
  arrow.className = 'audit-system-arrow';
  arrow.appendChild(createAuditChevronIcon(12));
  actions.appendChild(arrow);
  header.appendChild(actions);

  const content = document.createElement('div');
  content.className = 'audit-system-content';
  content.textContent = systemPreview.text;

  panel.appendChild(header);
  panel.appendChild(content);
  return panel;
}

function createAuditInspectorPanelElement(id, preview, active) {
  const panel = document.createElement('div');
  panel.className = `audit-inspector-panel${active ? ' active' : ''}`;
  panel.dataset.auditInspectorPanel = id;

  const pre = document.createElement('pre');
  pre.appendChild(createAuditCodeTextElement(preview.text));
  panel.appendChild(pre);
  if (preview.truncated) appendAuditText(panel, '内容已截断显示', 'div', 'muted');
  return panel;
}

function createAuditInspectorElement(record) {
  const inspector = document.createElement('div');
  inspector.className = 'audit-inspector';

  const tabs = document.createElement('div');
  tabs.className = 'audit-inspector-tabs';
  [
    ['request', 'Request'],
    ['upstream', 'Upstream'],
    ['response', 'Response'],
  ].forEach(([id, label], index) => {
    const tab = document.createElement('button');
    tab.className = `audit-inspector-tab${index === 0 ? ' active' : ''}`;
    tab.dataset.auditInspectorTab = id;
    tab.textContent = label;
    tabs.appendChild(tab);
  });

  const requestPreview = formatAuditJson({
    method: record.method,
    path: record.path,
    headers: record.request && record.request.headers,
    body: record.request && record.request.body,
    truncated: record.request && record.request.truncated,
  });
  const upstreamPreview = formatAuditJson(record.upstream || {});
  const responsePreview = formatAuditJson({
    statusCode: record.statusCode,
    headers: record.responseHeaders || {},
    usage: record.usage || null,
    cost: record.cost || null,
    response: record.response || {},
  });

  inspector.appendChild(tabs);
  inspector.appendChild(createAuditInspectorPanelElement('request', requestPreview, true));
  inspector.appendChild(createAuditInspectorPanelElement('upstream', upstreamPreview, false));
  inspector.appendChild(createAuditInspectorPanelElement('response', responsePreview, false));
  return inspector;
}

function collectAuditMessageView(msg) {
  const isUser = msg.role === 'user';
  const isSystem = msg.role === 'system';
  const roleClass = isUser ? 'user' : isSystem ? 'system' : 'assistant';
  const roleName = isUser ? 'User (IDE / CLI)' : isSystem ? 'System Context' : 'Assistant (LLM)';
  let contentStr = '';
  const toolCalls = [];

  if (msg.content) {
    if (typeof msg.content === 'string') {
      contentStr = msg.content;
    } else if (Array.isArray(msg.content)) {
      msg.content.forEach((block) => {
        if (block.type === 'text') {
          contentStr += block.text || '';
        } else if (block.type === 'tool_use') {
          toolCalls.push(block);
        }
      });
    }
  }

  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    msg.tool_calls.forEach((tc) => toolCalls.push(tc));
  }

  return {
    contentPreview: truncateAuditText(contentStr.trim(), AUDIT_MESSAGE_PREVIEW_CHARS),
    roleClass,
    roleName,
    toolCalls,
  };
}

function createAuditMessageElement(msg) {
  const view = collectAuditMessageView(msg);
  if (!view.contentPreview.text.trim() && view.toolCalls.length === 0) return null;

  const container = document.createElement('div');
  container.className = `audit-bubble-container ${view.roleClass}`;
  appendAuditText(container, view.roleName, 'div', 'audit-bubble-meta');

  if (view.contentPreview.text.trim()) {
    const bubble = document.createElement('div');
    bubble.className = 'audit-bubble';
    bubble.appendChild(renderAuditMarkdown(view.contentPreview.text));
    container.appendChild(bubble);
  }

  view.toolCalls.forEach((tc) => container.appendChild(createAuditToolCallElement(tc)));
  return container;
}

function createAuditToolCallElement(tc) {
  const id = String(tc.id || Math.random().toString(36).substring(2, 9)).replace(
    /[^a-zA-Z0-9_-]/g,
    '_'
  );
  const name = tc.name || (tc.function ? tc.function.name : '未知工具');

  let argsStr = '';
  const inputObj = tc.input || (tc.function ? tc.function.arguments : null);
  if (inputObj) {
    if (typeof inputObj === 'string') {
      try {
        argsStr = JSON.stringify(JSON.parse(inputObj), null, 2);
      } catch (e) {
        argsStr = inputObj;
      }
    } else {
      argsStr = JSON.stringify(inputObj, null, 2);
    }
  }

  let resultStr = '';
  if (selectedAuditRecordId && cachedAuditRecords && cachedAuditRecords.length > 0) {
    const idx = selectedAuditRecordId.split('_').pop();
    const currentRecord = cachedAuditRecords[Number(idx)];
    if (currentRecord && currentRecord.messages) {
      const toolResultMsg = currentRecord.messages.find(
        (m) => m.role === 'tool' && m.tool_call_id === tc.id
      );
      if (toolResultMsg) {
        resultStr =
          typeof toolResultMsg.content === 'string'
            ? toolResultMsg.content
            : JSON.stringify(toolResultMsg.content, null, 2);
      } else {
        currentRecord.messages.forEach((m) => {
          if (Array.isArray(m.content)) {
            const block = m.content.find(
              (b) => b.type === 'tool_result' && b.tool_use_id === tc.id
            );
            if (block) {
              resultStr =
                typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content, null, 2);
            }
          }
        });
      }
    }
  }

  const argsPreview = truncateAuditText(argsStr || '{}', AUDIT_TOOL_PREVIEW_CHARS);
  const resultPreview = truncateAuditText(resultStr, AUDIT_TOOL_PREVIEW_CHARS);
  const tool = document.createElement('div');
  tool.className = 'audit-tool-call collapsed';
  tool.id = `tool_call_${id}`;

  const header = document.createElement('div');
  header.className = 'audit-tool-header';
  header.dataset.auditToggleTool = id;
  const title = document.createElement('span');
  title.className = 'audit-tool-title';
  title.appendChild(createAuditToolIcon());
  title.appendChild(document.createTextNode(`Tool Call: ${name}`));
  header.appendChild(title);
  const arrow = document.createElement('span');
  arrow.appendChild(createAuditChevronIcon(10));
  header.appendChild(arrow);

  const body = document.createElement('div');
  body.className = 'audit-tool-body';
  const args = document.createElement('div');
  args.className = 'audit-tool-args';
  appendAuditText(
    args,
    `调用参数 (Arguments)${argsPreview.truncated ? ' · 已截断显示' : ''}:`,
    'div',
    'audit-tool-args-label'
  );
  const argsPre = document.createElement('pre');
  argsPre.appendChild(createAuditCodeTextElement(argsPreview.text));
  args.appendChild(argsPre);
  body.appendChild(args);

  const result = document.createElement('div');
  result.className = 'audit-tool-result';
  if (resultStr) {
    appendAuditText(
      result,
      `执行输出 (Result)${resultPreview.truncated ? ' · 已截断显示' : ''}:`,
      'div',
      'audit-tool-result-label'
    );
    const resultPre = document.createElement('pre');
    resultPre.appendChild(createAuditCodeTextElement(resultPreview.text));
    result.appendChild(resultPre);
  } else {
    const label = appendAuditText(
      result,
      '(尚无输出结果，或在后续对话中呈现)',
      'div',
      'audit-tool-result-label'
    );
    label.style.opacity = '0.6';
  }
  body.appendChild(result);

  tool.appendChild(header);
  tool.appendChild(body);
  return tool;
}

function createAuditChatFlowElement(record) {
  const flow = document.createElement('div');
  flow.className = 'audit-chat-flow';

  if (record.messages && Array.isArray(record.messages)) {
    record.messages.forEach((msg) => {
      const message = createAuditMessageElement(msg);
      if (message) flow.appendChild(message);
    });
  }

  if (
    record.response &&
    record.response.tool_calls &&
    Array.isArray(record.response.tool_calls) &&
    record.response.tool_calls.length > 0
  ) {
    const container = document.createElement('div');
    container.className = 'audit-bubble-container assistant';
    appendAuditText(container, 'Assistant (Streaming Tool Calls)', 'div', 'audit-bubble-meta');
    record.response.tool_calls.forEach((tc) =>
      container.appendChild(createAuditToolCallElement(tc))
    );
    flow.appendChild(container);
  }

  return flow;
}

function renderAuditDetail(record) {
  const panel = auditDependencies.$('auditDetailPanel');
  if (!panel) return;

  panel.textContent = '';
  panel.appendChild(createAuditDetailHeaderElement(record));

  const body = document.createElement('div');
  body.className = 'audit-detail-body';
  if (record.system) body.appendChild(createAuditSystemPanelElement(record.system));
  body.appendChild(createAuditInspectorElement(record));
  body.appendChild(createAuditChatFlowElement(record));
  panel.appendChild(body);
  bindAuditDetailDelegates(panel);

  // 绑定导出按钮事件
  const exportBtn = auditDependencies.$('exportAuditMarkdownBtn');
  if (exportBtn) {
    exportBtn.onclick = () => {
      const mdText = formatRecordToMarkdown(record);
      navigator.clipboard
        .writeText(mdText)
        .then(() => {
          auditDependencies.showToast('已复制完整 Markdown 对话纪要到剪贴板', 'success');
        })
        .catch((err) => {
          auditDependencies.showToast('复制失败: ' + err.message, 'error');
        });
    };
  }

  const retryBtn = auditDependencies.$('retryAuditRequestBtn');
  if (retryBtn) {
    retryBtn.onclick = async () => {
      if (!record.id) return;
      retryBtn.disabled = true;
      retryBtn.textContent = '重试中...';
      try {
        const result = await window.proxyManager.retryAuditRequest(record.id);
        if (result && result.ok) {
          auditDependencies.showToast(`重试完成：HTTP ${result.statusCode}`, 'success');
        } else {
          auditDependencies.showToast(
            `重试失败：${(result && (result.error || result.statusCode)) || '未知错误'}`,
            'error'
          );
        }
        await loadAuditRecords();
      } catch (err) {
        auditDependencies.showToast('重试失败: ' + err.message, 'error');
      } finally {
        retryBtn.disabled = false;
        retryBtn.textContent = '重试';
      }
    };
  }

  // 绑定另存为模板按钮事件
  const saveSysBtn = auditDependencies.$('saveSystemPromptToTemplatesBtn');
  if (saveSysBtn) {
    saveSysBtn.onclick = (e) => {
      e.stopPropagation();
      const systemText = record.system;
      auditDependencies.showView('promptsView');

      const promptContent = auditDependencies.$('promptContent');
      if (promptContent) {
        promptContent.value = systemText;
      }

      const templateNameInput = auditDependencies.$('templateNameInput');
      if (templateNameInput) {
        const now = new Date();
        const timeStr = `${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}`;
        templateNameInput.value = `从审计导入_${timeStr}`;
        templateNameInput.focus();
        templateNameInput.select();
      }

      auditDependencies.togglePromptsTab('tabCustomPrompts');
      auditDependencies.showToast(
        '已成功逆向提纯该系统提示词并载入编辑器，可输入名称保存为本地插件。',
        'success'
      );
    };
  }
}

function bindAuditDetailDelegates(panel) {
  if (panel.dataset.auditDelegated === 'true') return;
  panel.dataset.auditDelegated = 'true';
  panel.onclick = (event) => {
    if (event.target.closest('[data-audit-toggle-system]')) {
      toggleAuditSystemPanel();
      return;
    }
    const toolToggle = event.target.closest('[data-audit-toggle-tool]');
    if (toolToggle) {
      toggleAuditToolCall(toolToggle.dataset.auditToggleTool);
      return;
    }
    const inspectorTab = event.target.closest('[data-audit-inspector-tab]');
    if (inspectorTab) {
      switchAuditInspectorTab(inspectorTab.dataset.auditInspectorTab);
    }
  };
}

function switchAuditInspectorTab(tabId) {
  document.querySelectorAll('[data-audit-inspector-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.auditInspectorTab === tabId);
  });
  document.querySelectorAll('[data-audit-inspector-panel]').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.auditInspectorPanel === tabId);
  });
}

function toggleAuditSystemPanel() {
  const panel = auditDependencies.$('auditSystemPanel');
  if (panel) {
    panel.classList.toggle('collapsed');
  }
}

function toggleAuditToolCall(id) {
  const el = auditDependencies.$('tool_call_' + id);
  if (el) {
    el.classList.toggle('collapsed');
  }
}

// 渲染单个 Tool Call 与 Result
function renderSingleToolCall(tc) {
  const id = String(tc.id || Math.random().toString(36).substring(2, 9)).replace(
    /[^a-zA-Z0-9_-]/g,
    '_'
  );
  const name = tc.name || (tc.function ? tc.function.name : '未知工具');

  let argsStr = '';
  const inputObj = tc.input || (tc.function ? tc.function.arguments : null);
  if (inputObj) {
    if (typeof inputObj === 'string') {
      try {
        argsStr = JSON.stringify(JSON.parse(inputObj), null, 2);
      } catch (e) {
        argsStr = inputObj;
      }
    } else {
      argsStr = JSON.stringify(inputObj, null, 2);
    }
  }

  // 寻找对应的执行结果
  let resultStr = '';
  if (selectedAuditRecordId && cachedAuditRecords && cachedAuditRecords.length > 0) {
    const idx = selectedAuditRecordId.split('_').pop();
    const currentRecord = cachedAuditRecords[Number(idx)];
    if (currentRecord && currentRecord.messages) {
      // OpenAI: 查找 role === 'tool'
      const toolResultMsg = currentRecord.messages.find(
        (m) => m.role === 'tool' && m.tool_call_id === tc.id
      );
      if (toolResultMsg) {
        resultStr =
          typeof toolResultMsg.content === 'string'
            ? toolResultMsg.content
            : JSON.stringify(toolResultMsg.content, null, 2);
      } else {
        // Claude: 查找 tool_result
        currentRecord.messages.forEach((m) => {
          if (Array.isArray(m.content)) {
            const block = m.content.find(
              (b) => b.type === 'tool_result' && b.tool_use_id === tc.id
            );
            if (block) {
              resultStr =
                typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content, null, 2);
            }
          }
        });
      }
    }
  }
  const argsPreview = truncateAuditText(argsStr || '{}', AUDIT_TOOL_PREVIEW_CHARS);
  const resultPreview = truncateAuditText(resultStr, AUDIT_TOOL_PREVIEW_CHARS);

  return `
    <div class="audit-tool-call collapsed" id="tool_call_${id}">
      <div class="audit-tool-header" data-audit-toggle-tool="${id}">
        <span class="audit-tool-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          Tool Call: ${auditDependencies.escapeHtml(name)}
        </span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="audit-tool-body">
        <div class="audit-tool-args">
          <div class="audit-tool-args-label">调用参数 (Arguments)${argsPreview.truncated ? ' · 已截断显示' : ''}:</div>
          <pre><code>${auditDependencies.escapeHtml(argsPreview.text)}</code></pre>
        </div>
        ${
          resultStr
            ? `
        <div class="audit-tool-result">
          <div class="audit-tool-result-label">执行输出 (Result)${resultPreview.truncated ? ' · 已截断显示' : ''}:</div>
          <pre><code>${auditDependencies.escapeHtml(resultPreview.text)}</code></pre>
        </div>
        `
            : `
        <div class="audit-tool-result">
          <div class="audit-tool-result-label" style="opacity: 0.6;">(尚无输出结果，或在后续对话中呈现)</div>
        </div>
        `
        }
      </div>
    </div>
  `;
}
export { initPromptsAuditView, initUsageReportView };
