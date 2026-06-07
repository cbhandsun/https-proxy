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
  const rewriteModel = String(record && record.rewriteModel || '').trim();
  if (rewriteModel && rewriteModel !== '-') return rewriteModel;
  return String(record && record.originalModel || '').trim();
}

function auditModelFlowLabel(record) {
  const originalModel = String(record && record.originalModel || '').trim();
  const upstreamModel = auditUpstreamModel(record);
  if (!originalModel && !upstreamModel) return '未知模型';
  if (originalModel && upstreamModel && upstreamModel !== originalModel) {
    return `${originalModel} -> ${upstreamModel}`;
  }
  return upstreamModel || originalModel;
}

function formatAuditJson(value, limit = AUDIT_INSPECTOR_PREVIEW_CHARS) {
  let text = '';
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
      <div class="usage-metric-label">${escapeHtml(label)}</div>
      <div class="usage-metric-value">${escapeHtml(value)}</div>
      ${sub ? `<div class="usage-metric-sub">${escapeHtml(sub)}</div>` : ''}
    </div>
  `;
}

function truncateAuditText(value, limit) {
  const text = String(value == null ? '' : value);
  if (text.length <= limit) return { text, truncated: false };
  return {
    text: text.slice(0, limit) + `\n\n...[已截断 ${text.length - limit} 字符，导出 Markdown 可查看完整内容]`,
    truncated: true
  };
}

function auditContentToText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content.map((block) => {
    if (!block) return '';
    if (block.type === 'text') return block.text || '';
    if (block.type === 'tool_result') return typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
    return '';
  }).filter(Boolean).join('\n');
}

function setAuditDetailPlaceholder(message = '选择左侧记录查看详情') {
  const panel = $('auditDetailPanel');
  if (!panel) return;
  panel.innerHTML = `
    <div class="audit-detail-placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <p>${escapeHtml(message)}</p>
    </div>`;
}

// 简易 Markdown 解析逻辑
function formatAuditMarkdown(text) {
  if (!text) return '';
  // 1. 转义HTML，防御XSS
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 2. 替换三反引号代码块 ```lang\ncode\n```
  html = html.replace(/```(\w*)\n([\s\S]*?)\n```/g, (match, lang, code) => {
    return `<pre><code class="language-${lang}">${code}</code></pre>`;
  });

  // 3. 替换行内代码 `code`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // 4. 分离段落与换行，但跳过 <pre> 块
  const parts = html.split(/(<pre>[\s\S]*?<\/pre>)/g);
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].startsWith('<pre>')) {
      parts[i] = parts[i]
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>');
    }
  }
  let finalHtml = parts.join('');
  if (!finalHtml.startsWith('<pre>') && !finalHtml.startsWith('<p>')) {
    finalHtml = '<p>' + finalHtml + '</p>';
  }
  return finalHtml;
}

async function initPromptsAuditView() {
  // 绑定动作（如果尚未绑定）
  const refreshBtn = $('refreshAudit');
  const clearBtn = $('clearAudit');
  if (refreshBtn && !refreshBtn.dataset.bound) {
    refreshBtn.dataset.bound = 'true';
    refreshBtn.onclick = () => loadAuditRecords();
  }
  if (clearBtn && !clearBtn.dataset.bound) {
    clearBtn.dataset.bound = 'true';
    clearBtn.onclick = () => {
      confirmAction('确定要清空所有的对话审计日志吗？此操作将永久清空本地的 conversations-audit.jsonl 文件。', async () => {
        const res = await window.proxyManager.clearAuditConversations();
        if (res && res.ok !== false) {
          showToast('对话审计日志已清空', 'success');
          selectedAuditRecordId = null;
          loadAuditRecords();
        } else {
          showToast('清空日志失败: ' + (res.error || '未知错误'), 'error');
        }
      });
    };
  }

  await loadAuditRecords();
}

async function initUsageReportView() {
  const refreshBtn = $('refreshUsageReport');
  const windowSelect = $('usageReportWindow');
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
  const summary = $('usageReportSummary');
  const byProfile = $('usageByProfile');
  const byModel = $('usageByModel');
  const recent = $('usageRecent');
  if (!summary || !byProfile || !byModel || !recent) return;
  summary.innerHTML = '<div class="muted">正在加载...</div>';
  byProfile.innerHTML = '';
  byModel.innerHTML = '';
  recent.innerHTML = '';
  try {
    const windowValue = $('usageReportWindow') ? $('usageReportWindow').value : '';
    const report = await window.proxyManager.readUsageReport({ limit: 300, after: usageWindowAfter(windowValue) });
    if (!report || report.ok === false) throw new Error((report && report.error) || '读取失败');
    renderUsageReport(report);
  } catch (err) {
    summary.innerHTML = `<div class="usage-empty">读取使用报告失败：${escapeHtml(err.message)}</div>`;
  }
}

function renderUsageReport(report) {
  const total = report.total || {};
  const estimated = Number(total.estimatedRecords || 0);
  $('usageReportMeta').textContent = `生成于 ${new Date(report.generatedAt || Date.now()).toLocaleString()} · ${estimated ? `${estimated} 条为估算 Token` : '全部使用真实 usage 或可用记录'}`;
  $('usageReportSummary').innerHTML = [
    renderUsageMetric('请求数', formatAuditTokens(total.requests), `${formatAuditTokens(total.successes)} 成功 / ${formatAuditTokens(total.errors)} 异常`),
    renderUsageMetric('输入 Token', formatAuditTokens(total.inputTokens), total.cachedInputTokens ? `缓存 ${formatAuditTokens(total.cachedInputTokens)}` : ''),
    renderUsageMetric('输出 Token', formatAuditTokens(total.outputTokens)),
    renderUsageMetric('估算成本', formatAuditCost({ known: total.cost > 0, amount: total.cost }), 'USD'),
  ].join('');
  $('usageByProfile').innerHTML = renderUsageTable(report.byProfile || [], 'profile');
  $('usageByModel').innerHTML = renderUsageTable(report.byModel || [], 'model');
  $('usageRecent').innerHTML = renderUsageRecent(report.recent || []);
  updateUsageChart(report.byDay || []);
}

function updateUsageChart(dayData) {
  const ctx = $('usageChart');
  if (!ctx) return;

  const labels = dayData.map(d => d.key);
  const inputTokens = dayData.map(d => d.inputTokens);
  const outputTokens = dayData.map(d => d.outputTokens);

  if (usageChartInstance) {
    usageChartInstance.destroy();
  }

  if (typeof Chart === 'undefined') {
    console.warn('Chart.js not loaded');
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
          borderWidth: 1
        },
        {
          label: '输出 Token',
          data: outputTokens,
          backgroundColor: 'rgba(16, 185, 129, 0.6)',
          borderColor: 'rgb(16, 185, 129)',
          borderWidth: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true },
        y: { stacked: true, beginAtZero: true }
      },
      plugins: {
        legend: { position: 'top' },
        tooltip: { mode: 'index', intersect: false }
      }
    }
  });
}

function renderUsageTable(rows, type) {
  if (!rows.length) return '<div class="usage-empty">暂无记录</div>';
  return `
    <table class="usage-table">
      <thead><tr><th>${type === 'profile' ? '上游目标' : '模型'}</th><th>请求</th><th>输入</th><th>输出</th><th>成本</th></tr></thead>
      <tbody>
        ${rows.map((row) => `
          <tr>
            <td><strong>${escapeHtml(row.label || row.key)}</strong>${row.estimatedRecords ? `<div class="muted">${row.estimatedRecords} 条估算</div>` : ''}</td>
            <td>${formatAuditTokens(row.requests)}</td>
            <td>${formatAuditTokens(row.inputTokens)}</td>
            <td>${formatAuditTokens(row.outputTokens)}</td>
            <td>${formatAuditCost({ known: row.cost > 0, amount: row.cost })}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderUsageRecent(rows) {
  if (!rows.length) return '<div class="usage-empty">暂无记录</div>';
  return `
    <table class="usage-table usage-table-recent">
      <thead><tr><th>时间</th><th>上游</th><th>模型</th><th>Token</th><th>成本</th><th>状态</th></tr></thead>
      <tbody>
        ${rows.map((row) => `
          <tr>
            <td>${escapeHtml(new Date(row.time).toLocaleString())}</td>
            <td>${escapeHtml(row.profileName || '-')}</td>
            <td><code>${escapeHtml(row.model || '-')}</code></td>
            <td>${formatAuditTokens((row.usage && row.usage.totalTokens) || 0)}</td>
            <td>${formatAuditCost(row.cost)}</td>
            <td><span class="audit-badge ${row.statusCode >= 200 && row.statusCode < 300 ? 'success' : 'error'}">${escapeHtml(row.statusCode || '???')}</span></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function loadAuditRecords() {
  const listContainer = $('auditHistoryList');
  if (!listContainer) return;
  listContainer.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--muted); font-size: 12px;">正在加载对话审计日志...</div>';

  try {
    const rawRes = await window.proxyManager.readAuditConversations(AUDIT_LIST_LIMIT);
    const res = rawRes && Array.isArray(rawRes.conversations) ? rawRes.conversations : rawRes;
    if (!res || !Array.isArray(res)) {
      let errMsg = '未知错误';
      if (rawRes) {
        if (rawRes.error) {
          errMsg = typeof rawRes.error === 'object' ? (rawRes.error.message || JSON.stringify(rawRes.error)) : rawRes.error;
        } else {
          errMsg = JSON.stringify(rawRes);
        }
      }
      listContainer.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--danger); font-size: 12px; word-break: break-all;">读取审计日志失败：<br>${escapeHtml(errMsg)}</div>`;
      return;
    }

    cachedAuditRecords = res;
    listContainer.innerHTML = '';
    if (!listContainer.dataset.delegated) {
      listContainer.dataset.delegated = 'true';
      listContainer.onclick = (event) => {
        const item = event.target.closest('.audit-item[data-audit-index]');
        if (!item || !listContainer.contains(item)) return;
        const record = cachedAuditRecords[Number(item.dataset.auditIndex)];
        if (!record) return;
        document.querySelectorAll('.audit-item').forEach(el => el.classList.remove('active'));
        item.classList.add('active');
        selectedAuditRecordId = item.dataset.auditId;
        setAuditDetailPlaceholder('正在渲染详情...');
        requestAnimationFrame(() => renderAuditDetail(record));
      };
    }

    if (res.length === 0) {
      listContainer.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--muted); font-size: 12px;">暂无对话审计记录</div>';
      $('auditDetailPanel').innerHTML = `
        <div class="audit-detail-placeholder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <p>暂无对话记录</p>
        </div>`;
      return;
    }

    res.forEach((record, index) => {
      const recordId = record.time + '_' + index;
      const item = document.createElement('div');
      item.className = 'audit-item';
      item.dataset.auditId = recordId;
      item.dataset.auditIndex = String(index);
      if (selectedAuditRecordId === recordId) {
        item.classList.add('active');
      }

      // 提取 User 首条消息摘要
      let userSnippet = '无输入内容';
      if (record.messages && Array.isArray(record.messages)) {
        const firstUser = record.messages.find(m => m.role === 'user');
        if (firstUser && firstUser.content) {
          userSnippet = auditContentToText(firstUser.content) || '无输入内容';
        }
      }
      userSnippet = truncateAuditText(userSnippet, AUDIT_SNIPPET_CHARS).text;

      const date = new Date(record.time);
      const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const latency = record.elapsed ? `${record.elapsed}ms` : '??? ms';
      const isSuccess = record.statusCode >= 200 && record.statusCode < 300;
      const usage = record.usage || {};
      const modelFlow = auditModelFlowLabel(record);
      const upstreamModel = auditUpstreamModel(record);

      item.innerHTML = `
        <div class="audit-item-meta">
          <span>${timeStr}</span>
          <span class="audit-badge ${isSuccess ? 'success' : 'error'}">${record.statusCode || '???'}</span>
        </div>
        <div class="audit-item-info">
          <span style="font-weight: 600; color: var(--primary);">${escapeHtml(record.protocol === 'claude' ? 'Claude' : 'OpenAI')}</span>
          <span style="color: var(--muted); font-size: 11px; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(modelFlow)}</span>
        </div>
        <div class="audit-item-snippet">${escapeHtml(userSnippet)}</div>
        <div style="font-size: 10px; color: var(--muted); margin-top: 2px; display: flex; justify-content: space-between;">
          <span>上游: ${escapeHtml(upstreamModel || '未指定')} · ${escapeHtml(record.profileName || '默认')}</span>
          <span>${formatAuditTokens(usage.totalTokens || 0)} tok · ${escapeHtml(latency)}</span>
        </div>
      `;

      listContainer.appendChild(item);
    });

    // 默认选中第一个或保持之前的选中项
    if (selectedAuditRecordId) {
      const found = res.find((r, idx) => (r.time + '_' + idx) === selectedAuditRecordId);
      if (found) {
        const foundIndex = res.findIndex((r, idx) => (r.time + '_' + idx) === selectedAuditRecordId);
        if (foundIndex >= 0 && listContainer.children[foundIndex]) listContainer.children[foundIndex].classList.add('active');
        setAuditDetailPlaceholder('正在渲染详情...');
        requestAnimationFrame(() => renderAuditDetail(found));
        return;
      }
    }

    selectedAuditRecordId = null;
    setAuditDetailPlaceholder(`已加载最近 ${res.length} 条记录，选择一条查看详情`);
  } catch (err) {
    listContainer.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--danger); font-size: 12px; word-break: break-all;">渲染审计日志失败：<br>${escapeHtml(err.message)}</div>`;
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
      let toolCalls = [];

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
          let inputObj = tc.input || (tc.function ? tc.function.arguments : null);
          if (inputObj) {
            if (typeof inputObj === 'string') {
              try {
                argsStr = JSON.stringify(JSON.parse(inputObj), null, 2);
              } catch(e) {
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

  if (record.response && record.response.tool_calls && Array.isArray(record.response.tool_calls) && record.response.tool_calls.length > 0) {
    md += `### Assistant (Streaming Tool Calls)\n\n`;
    record.response.tool_calls.forEach((tc) => {
      const name = tc.name || (tc.function ? tc.function.name : '未知工具');
      let argsStr = '';
      let inputObj = tc.input || (tc.function ? tc.function.arguments : null);
      if (inputObj) {
        if (typeof inputObj === 'string') {
          try {
            argsStr = JSON.stringify(JSON.parse(inputObj), null, 2);
          } catch(e) {
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

function renderAuditDetail(record) {
  const panel = $('auditDetailPanel');
  if (!panel) return;

  const date = new Date(record.time);
  const fullTimeStr = date.toLocaleString();
  const latencyStr = record.elapsed ? `${record.elapsed}ms` : '未知耗时';
  const isSuccess = record.statusCode >= 200 && record.statusCode < 300;
  const usage = record.usage || {};
  const cost = record.cost || {};
  const upstreamModel = auditUpstreamModel(record);
  const usageSource = usage.source === 'provider' ? '上游 usage' : '本地估算';

  // 1. 详情头部
  let headerHtml = `
    <div class="audit-detail-header">
      <div class="audit-detail-title">
        <span class="audit-badge info">${escapeHtml(record.protocol === 'claude' ? 'Claude SSE' : 'OpenAI Protocol')}</span>
        <span>目标上游: <strong>${escapeHtml(record.profileName || '默认')}</strong></span>
        <span class="audit-badge ${isSuccess ? 'success' : 'error'}">${record.statusCode || '???'}</span>
        <button id="retryAuditRequestBtn" class="secondary" style="margin-left: 12px; font-size: 11px; padding: 2px 8px; min-height: 24px; border-radius: var(--radius-sm);" ${record.id ? '' : 'disabled'}>重试</button>
        <button id="exportAuditMarkdownBtn" class="secondary" style="margin-left: 12px; font-size: 11px; padding: 2px 8px; min-height: 24px; border-radius: var(--radius-sm);">导出 Markdown</button>
        <span style="font-size: 12px; color: var(--muted); font-weight: normal; margin-left: auto;">${escapeHtml(fullTimeStr)}</span>
      </div>
      <div class="audit-detail-meta">
        <span>请求模型: <code>${escapeHtml(record.originalModel || '未指定')}</code></span>
        <span>上游模型: <code>${escapeHtml(upstreamModel || '未指定')}</code></span>
        ${(record.rewriteModel && record.rewriteModel !== '-') ? `<span>重写转发: <code>${escapeHtml(record.rewriteModel)}</code></span>` : ''}
        <span>延迟耗时: <strong style="color: var(--primary);">${escapeHtml(latencyStr)}</strong></span>
      </div>
      <div class="audit-usage-strip">
        ${renderUsageMetric('输入 Token', formatAuditTokens(usage.inputTokens), usage.cachedInputTokens ? `缓存 ${formatAuditTokens(usage.cachedInputTokens)}` : usageSource)}
        ${renderUsageMetric('输出 Token', formatAuditTokens(usage.outputTokens), usageSource)}
        ${renderUsageMetric('总 Token', formatAuditTokens(usage.totalTokens), usageSource)}
        ${renderUsageMetric('估算成本', formatAuditCost(cost), cost && cost.pricing ? `${cost.pricing.match} · ${cost.currency || 'USD'}` : '可在 modelPricing 覆盖')}
      </div>
    </div>
  `;

  // 2. System Prompt 折叠面板
  let systemHtml = '';
  if (record.system) {
    const systemPreview = truncateAuditText(record.system, AUDIT_SYSTEM_PREVIEW_CHARS);
    systemHtml = `
      <div class="audit-system-panel collapsed" id="auditSystemPanel">
        <div class="audit-system-header" data-audit-toggle-system>
          <span>System Prompt (系统预设背景指令)${systemPreview.truncated ? ' · 已截断显示' : ''}</span>
          <div style="margin-left: auto; display: flex; gap: 8px; align-items: center;">
            <button id="saveSystemPromptToTemplatesBtn" class="secondary" style="font-size: 11px; padding: 2px 8px; min-height: 24px; border-radius: var(--radius-sm); pointer-events: auto;">另存为模板</button>
            <svg class="audit-system-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
        </div>
        <div class="audit-system-content">${escapeHtml(systemPreview.text)}</div>
      </div>
    `;
  }

  // 3. 对话流渲染
  let chatFlowHtml = '<div class="audit-chat-flow">';
  if (record.messages && Array.isArray(record.messages)) {
    record.messages.forEach((msg) => {
      const isUser = msg.role === 'user';
      const isSystem = msg.role === 'system';
      const roleClass = isUser ? 'user' : (isSystem ? 'system' : 'assistant');
      const roleName = isUser ? 'User (IDE / CLI)' : (isSystem ? 'System Context' : 'Assistant (LLM)');

      let contentStr = '';
      let toolCallsHtml = '';

      // 处理复合 content
      if (msg.content) {
        if (typeof msg.content === 'string') {
          contentStr = msg.content;
        } else if (Array.isArray(msg.content)) {
          msg.content.forEach((block) => {
            if (block.type === 'text') {
              contentStr += block.text || '';
            } else if (block.type === 'tool_use') {
              toolCallsHtml += renderSingleToolCall(block);
            }
          });
        }
      }

      // 处理 OpenAI tool_calls
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        msg.tool_calls.forEach((tc) => {
          toolCallsHtml += renderSingleToolCall(tc);
        });
      }

      const contentPreview = truncateAuditText(contentStr.trim(), AUDIT_MESSAGE_PREVIEW_CHARS);
      if (contentPreview.text.trim() || toolCallsHtml) {
        chatFlowHtml += `
          <div class="audit-bubble-container ${roleClass}">
            <div class="audit-bubble-meta">${roleName}</div>
            ${contentPreview.text.trim() ? `<div class="audit-bubble">${formatAuditMarkdown(contentPreview.text)}</div>` : ''}
            ${toolCallsHtml}
          </div>
        `;
      }
    });
  }

  // 处理流式传输中单独追加的 tool_calls
  if (record.response && record.response.tool_calls && Array.isArray(record.response.tool_calls) && record.response.tool_calls.length > 0) {
    let extraToolsHtml = '';
    record.response.tool_calls.forEach((tc) => {
      extraToolsHtml += renderSingleToolCall(tc);
    });
    if (extraToolsHtml) {
      chatFlowHtml += `
        <div class="audit-bubble-container assistant">
          <div class="audit-bubble-meta">Assistant (Streaming Tool Calls)</div>
          ${extraToolsHtml}
        </div>
      `;
    }
  }

  chatFlowHtml += '</div>';
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
  const inspectorHtml = `
    <div class="audit-inspector">
      <div class="audit-inspector-tabs">
        <button class="audit-inspector-tab active" data-audit-inspector-tab="request">Request</button>
        <button class="audit-inspector-tab" data-audit-inspector-tab="upstream">Upstream</button>
        <button class="audit-inspector-tab" data-audit-inspector-tab="response">Response</button>
      </div>
      <div class="audit-inspector-panel active" data-audit-inspector-panel="request">
        <pre><code>${escapeHtml(requestPreview.text)}</code></pre>
        ${requestPreview.truncated ? '<div class="muted">内容已截断显示</div>' : ''}
      </div>
      <div class="audit-inspector-panel" data-audit-inspector-panel="upstream">
        <pre><code>${escapeHtml(upstreamPreview.text)}</code></pre>
        ${upstreamPreview.truncated ? '<div class="muted">内容已截断显示</div>' : ''}
      </div>
      <div class="audit-inspector-panel" data-audit-inspector-panel="response">
        <pre><code>${escapeHtml(responsePreview.text)}</code></pre>
        ${responsePreview.truncated ? '<div class="muted">内容已截断显示</div>' : ''}
      </div>
    </div>
  `;

  panel.innerHTML = `
    ${headerHtml}
    <div class="audit-detail-body">
      ${systemHtml}
      ${inspectorHtml}
      ${chatFlowHtml}
    </div>
  `;
  bindAuditDetailDelegates(panel);

  // 绑定导出按钮事件
  const exportBtn = $('exportAuditMarkdownBtn');
  if (exportBtn) {
    exportBtn.onclick = () => {
      const mdText = formatRecordToMarkdown(record);
      navigator.clipboard.writeText(mdText).then(() => {
        showToast('已复制完整 Markdown 对话纪要到剪贴板', 'success');
      }).catch(err => {
        showToast('复制失败: ' + err.message, 'error');
      });
    };
  }

  const retryBtn = $('retryAuditRequestBtn');
  if (retryBtn) {
    retryBtn.onclick = async () => {
      if (!record.id) return;
      retryBtn.disabled = true;
      retryBtn.textContent = '重试中...';
      try {
        const result = await window.proxyManager.retryAuditRequest(record.id);
        if (result && result.ok) {
          showToast(`重试完成：HTTP ${result.statusCode}`, 'success');
        } else {
          showToast(`重试失败：${(result && (result.error || result.statusCode)) || '未知错误'}`, 'error');
        }
        await loadAuditRecords();
      } catch (err) {
        showToast('重试失败: ' + err.message, 'error');
      } finally {
        retryBtn.disabled = false;
        retryBtn.textContent = '重试';
      }
    };
  }

  // 绑定另存为模板按钮事件
  const saveSysBtn = $('saveSystemPromptToTemplatesBtn');
  if (saveSysBtn) {
    saveSysBtn.onclick = (e) => {
      e.stopPropagation();
      const systemText = record.system;
      showView('promptsView');

      const promptContent = $('promptContent');
      if (promptContent) {
        promptContent.value = systemText;
      }

      const templateNameInput = $('templateNameInput');
      if (templateNameInput) {
        const now = new Date();
        const timeStr = `${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}`;
        templateNameInput.value = `从审计导入_${timeStr}`;
        templateNameInput.focus();
        templateNameInput.select();
      }

      togglePromptsTab('tabCustomPrompts');
      showToast('已成功逆向提纯该系统提示词并载入编辑器，可输入名称保存为本地插件。', 'success');
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
  const panel = $('auditSystemPanel');
  if (panel) {
    panel.classList.toggle('collapsed');
  }
}

function toggleAuditToolCall(id) {
  const el = $('tool_call_' + id);
  if (el) {
    el.classList.toggle('collapsed');
  }
}

// 渲染单个 Tool Call 与 Result
function renderSingleToolCall(tc) {
  const id = String(tc.id || Math.random().toString(36).substring(2, 9)).replace(/[^a-zA-Z0-9_-]/g, '_');
  const name = tc.name || (tc.function ? tc.function.name : '未知工具');

  let argsStr = '';
  let inputObj = tc.input || (tc.function ? tc.function.arguments : null);
  if (inputObj) {
    if (typeof inputObj === 'string') {
      try {
        argsStr = JSON.stringify(JSON.parse(inputObj), null, 2);
      } catch(e) {
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
      const toolResultMsg = currentRecord.messages.find(m => m.role === 'tool' && m.tool_call_id === tc.id);
      if (toolResultMsg) {
        resultStr = typeof toolResultMsg.content === 'string'
          ? toolResultMsg.content
          : JSON.stringify(toolResultMsg.content, null, 2);
      } else {
        // Claude: 查找 tool_result
        currentRecord.messages.forEach(m => {
          if (Array.isArray(m.content)) {
            const block = m.content.find(b => b.type === 'tool_result' && b.tool_use_id === tc.id);
            if (block) {
              resultStr = typeof block.content === 'string'
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
          Tool Call: ${escapeHtml(name)}
        </span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="audit-tool-body">
        <div class="audit-tool-args">
          <div class="audit-tool-args-label">调用参数 (Arguments)${argsPreview.truncated ? ' · 已截断显示' : ''}:</div>
          <pre><code>${escapeHtml(argsPreview.text)}</code></pre>
        </div>
        ${resultStr ? `
        <div class="audit-tool-result">
          <div class="audit-tool-result-label">执行输出 (Result)${resultPreview.truncated ? ' · 已截断显示' : ''}:</div>
          <pre><code>${escapeHtml(resultPreview.text)}</code></pre>
        </div>
        ` : `
        <div class="audit-tool-result">
          <div class="audit-tool-result-label" style="opacity: 0.6;">(尚无输出结果，或在后续对话中呈现)</div>
        </div>
        `}
      </div>
    </div>
  `;
}
