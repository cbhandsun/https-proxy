export function codexDesktopConnectionDetails(status, getElement) {
  const modelSelector = getElement('codexDesktopModel');
  const effortSelector = getElement('codexDesktopReasoningEffort');
  if (modelSelector && status.model) modelSelector.value = status.model;
  if (effortSelector && status.modelReasoningEffort) {
    effortSelector.value = status.modelReasoningEffort;
  }

  return {
    legacy:
      status.legacyBaseUrl && !status.openaiBaseUrl && !status.isCustomModern
        ? '；当前为旧 base_url 写法'
        : '',
    modelInfo: status.model
      ? `；默认模型: ${status.model}${status.modelReasoningEffort ? ` (${status.modelReasoningEffort})` : ''}`
      : '',
  };
}

export function formatClaudeDesktopStatus(status) {
  if (!status.supported) {
    return `当前平台不可写入 Claude Desktop 配置：${status.error || ''}`;
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
  const mcpInfo =
    status.mcpServersManagedCount !== undefined
      ? `；网关托管 MCP: ${status.mcpServersManagedCount} 个 (总数 ${status.mcpServersCount || 0})`
      : '';
  return `${configured}；模式：${status.mode}${desiredMode}；当前 URL：${actual}；预期 URL：${expected}${matchText}${pathText}${clientText}${mcpInfo}`;
}

export function applyClaudeDesktopBadges(status, badgeEl, dotEl) {
  if (badgeEl) {
    if (!status.supported) {
      badgeEl.textContent = '不支持';
      badgeEl.className = 'badge error';
    } else if (status.configured) {
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
    if (!status.supported) {
      dotEl.className = 'status-dot red';
    } else if (status.configured && status.mode === 'proxy') {
      dotEl.className = 'status-dot green';
    } else if (status.configured && status.mode === 'direct') {
      dotEl.className = 'status-dot amber';
    } else {
      dotEl.className = 'status-dot';
    }
  }
}

export function renderClientActivity(containerEl, records = []) {
  if (!containerEl) return;
  containerEl.innerHTML = '';

  const titleRow = document.createElement('div');
  titleRow.style.display = 'flex';
  titleRow.style.alignItems = 'center';
  titleRow.style.justifyContent = 'space-between';
  titleRow.style.marginBottom = '6px';

  const titleText = document.createElement('span');
  titleText.style.fontSize = '12px';
  titleText.style.fontWeight = '600';
  titleText.style.color = 'var(--text-muted, #666)';
  titleText.textContent = '最近交互动态 (审计流)';

  const countBadge = document.createElement('span');
  countBadge.style.fontSize = '11px';
  countBadge.style.color = 'var(--text-muted, #888)';
  countBadge.textContent = records && records.length ? `${records.length} 笔请求` : '无请求';

  titleRow.appendChild(titleText);
  titleRow.appendChild(countBadge);
  containerEl.appendChild(titleRow);

  if (!records || records.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted hint';
    empty.style.fontSize = '12px';
    empty.style.padding = '8px 12px';
    empty.style.background = 'var(--bg, rgba(0,0,0,0.02))';
    empty.style.borderRadius = 'var(--radius-sm, 6px)';
    empty.style.border = '1px dashed var(--border, #ddd)';
    empty.textContent = '暂无最近请求记录（发起对话后自动刷新）';
    containerEl.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.style.display = 'flex';
  list.style.flexDirection = 'column';
  list.style.gap = '6px';

  for (const item of records) {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.justifyContent = 'space-between';
    row.style.fontSize = '12px';
    row.style.padding = '6px 10px';
    row.style.borderRadius = 'var(--radius-sm, 6px)';
    row.style.background = 'var(--bg, rgba(0,0,0,0.03))';
    row.style.border = '1px solid var(--border, #eee)';

    const left = document.createElement('div');
    left.style.display = 'flex';
    left.style.alignItems = 'center';
    left.style.gap = '8px';
    left.style.overflow = 'hidden';

    const dot = document.createElement('span');
    dot.className = `status-dot ${item.ok ? 'green' : 'red'}`;
    dot.style.flexShrink = '0';

    const timeStr = item.time ? new Date(item.time).toLocaleTimeString() : '';
    const timeSpan = document.createElement('span');
    timeSpan.style.color = 'var(--text-muted, #888)';
    timeSpan.style.fontSize = '11px';
    timeSpan.textContent = timeStr;

    const modelSpan = document.createElement('span');
    modelSpan.style.fontWeight = '600';
    modelSpan.style.whiteSpace = 'nowrap';
    modelSpan.style.overflow = 'hidden';
    modelSpan.style.textOverflow = 'ellipsis';
    modelSpan.textContent = item.model || item.originalModel || '未知模型';

    left.appendChild(dot);
    if (timeStr) left.appendChild(timeSpan);
    left.appendChild(modelSpan);

    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.alignItems = 'center';
    right.style.gap = '8px';
    right.style.flexShrink = '0';

    const statusBadge = document.createElement('span');
    statusBadge.style.fontSize = '11px';
    statusBadge.style.fontWeight = 'bold';
    statusBadge.style.padding = '1px 5px';
    statusBadge.style.borderRadius = '3px';
    statusBadge.style.background = item.ok ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)';
    statusBadge.style.color = item.ok ? '#16a34a' : '#dc2626';
    statusBadge.textContent = item.statusCode ? `${item.statusCode}` : item.ok ? '200' : 'ERR';

    right.appendChild(statusBadge);
    if (item.elapsed) {
      const elapsedSpan = document.createElement('span');
      elapsedSpan.style.color = 'var(--text-muted, #888)';
      elapsedSpan.style.fontSize = '11px';
      elapsedSpan.textContent = `${item.elapsed}ms`;
      right.appendChild(elapsedSpan);
    }

    row.appendChild(left);
    row.appendChild(right);

    if (!item.ok && item.error) {
      const wrapper = document.createElement('div');
      wrapper.appendChild(row);
      const errEl = document.createElement('div');
      errEl.style.fontSize = '11px';
      errEl.style.color = 'var(--color-danger, #ef4444)';
      errEl.style.padding = '3px 10px';
      errEl.textContent = `异常提示: ${item.error}`;
      wrapper.appendChild(errEl);
      list.appendChild(wrapper);
    } else {
      list.appendChild(row);
    }
  }

  containerEl.appendChild(list);
}

export function populatePromptPresetsDropdown(selectEl, presets = [], currentPresetId = '') {
  if (!selectEl) return;
  selectEl.innerHTML = '';
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = '选择提示词预设注入...';
  selectEl.appendChild(defaultOption);

  if (Array.isArray(presets)) {
    for (const preset of presets) {
      const opt = document.createElement('option');
      opt.value = preset.id;
      opt.textContent = `${preset.name || preset.id} (${preset.id})`;
      if (preset.id === currentPresetId) {
        opt.selected = true;
      }
      selectEl.appendChild(opt);
    }
  }
}

export function bindToolIntegrationActions({
  $,
  showToast,
  confirmAction,
  refreshClaudeDesktopStatus,
  proxyManager = window.proxyManager,
}) {
  const syncClaudeDesktopMcpButton = $('syncClaudeDesktopMcp');
  if (syncClaudeDesktopMcpButton) {
    syncClaudeDesktopMcpButton.onclick = async () => {
      syncClaudeDesktopMcpButton.disabled = true;
      syncClaudeDesktopMcpButton.textContent = '正在同步...';
      try {
        const res = await proxyManager.claudeDesktopSyncMcp();
        if (res && res.ok) {
          showToast(res.message || '已成功增量同步 MCP Hub 到 Claude Desktop', 'success');
          await refreshClaudeDesktopStatus();
        } else {
          showToast((res && res.error) || '同步 MCP Hub 失败', 'error');
        }
      } finally {
        syncClaudeDesktopMcpButton.disabled = false;
        syncClaudeDesktopMcpButton.textContent = '同步 MCP Hub';
      }
    };
  }

  const restoreClaudeDesktopMcpBackupButton = $('restoreClaudeDesktopMcpBackup');
  if (restoreClaudeDesktopMcpBackupButton) {
    restoreClaudeDesktopMcpBackupButton.onclick = async () => {
      const confirmed = await confirmAction({
        title: '还原 Claude Desktop MCP 配置备份？',
        message: '这会将 Claude Desktop 配置还原为最后一次备份状态。',
        confirmText: '确认还原',
      });
      if (!confirmed) return;
      const res = await proxyManager.claudeDesktopRestoreBackup();
      if (res && res.ok) {
        showToast(res.message || '已从备份还原 Claude Desktop 配置', 'success');
        await refreshClaudeDesktopStatus();
      } else {
        showToast((res && res.error) || '还原配置失败', 'error');
      }
    };
  }

  const applyClaudeDesktopPromptPresetButton = $('applyClaudeDesktopPromptPreset');
  if (applyClaudeDesktopPromptPresetButton) {
    applyClaudeDesktopPromptPresetButton.onclick = async () => {
      const presetEl = $('claudeDesktopPromptPreset');
      const presetId = presetEl ? presetEl.value : '';
      if (!presetId) {
        showToast('请先选择提示词预设', 'error');
        return;
      }
      const res = await proxyManager.applyPromptPresetToClient(presetId, 'claude');
      if (res && res.ok) {
        showToast(`已成功将预设 [${presetId}] 注入到 .claude/CLAUDE.md`, 'success');
      } else {
        showToast((res && res.error) || '注入预设失败', 'error');
      }
    };
  }

  const applyCodexDesktopPromptPresetButton = $('applyCodexDesktopPromptPreset');
  if (applyCodexDesktopPromptPresetButton) {
    applyCodexDesktopPromptPresetButton.onclick = async () => {
      const presetEl = $('codexDesktopPromptPreset');
      const presetId = presetEl ? presetEl.value : '';
      if (!presetId) {
        showToast('请先选择提示词预设', 'error');
        return;
      }
      const res = await proxyManager.applyPromptPresetToClient(presetId, 'codex');
      if (res && res.ok) {
        showToast(`已成功将预设 [${presetId}] 注入到 .codex/AGENTS.md`, 'success');
      } else {
        showToast((res && res.error) || '注入预设失败', 'error');
      }
    };
  }
}
