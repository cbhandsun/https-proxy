export function formatAuditTokens(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString();
}

export function formatAuditCost(cost) {
  if (!cost || !cost.known) return '未匹配单价';
  const amount = Number(cost.amount || 0);
  if (!Number.isFinite(amount)) return '未匹配单价';
  if (amount > 0 && amount < 0.0001) return '< $0.0001';
  return `$${amount.toFixed(4)}`;
}

export function auditCacheHitRate(usage) {
  if (!usage) return 0;
  if (usage.cacheHitRate != null) return usage.cacheHitRate;
  return usage.inputTokens ? (usage.cachedInputTokens || 0) / usage.inputTokens : 0;
}

export function auditCachedInputLabel(usage) {
  if (!usage || !usage.cachedInputTokens) return '';
  return `缓存 ${formatAuditTokens(usage.cachedInputTokens)} · ${Math.round(auditCacheHitRate(usage) * 100)}%`;
}

export function auditCacheCell(cachedTokens, hitRate) {
  return cachedTokens
    ? `${Math.round((hitRate || 0) * 100)}% · ${formatAuditTokens(cachedTokens)}`
    : '-';
}

export function auditContextBudgetLabel(contextBudget) {
  if (contextBudget.droppedCount) return `丢弃 ${formatAuditTokens(contextBudget.droppedCount)} 条`;
  if (contextBudget.optimizedCount)
    return `折叠 ${formatAuditTokens(contextBudget.optimizedCount)} 条`;
  return '未触发裁剪';
}

export function auditProviderCacheState(providerCache) {
  if (!providerCache) return '';
  if (providerCache.applied) return '已应用';
  return providerCache.candidate ? '可复用' : '未应用';
}

export function auditContextHealthSummary(record) {
  const diagnostics = record && record.contextDiagnostics;
  const contextBudget = diagnostics && diagnostics.contextBudget;
  if (!contextBudget) {
    const reason = record && record.contextDiagnosticsMissingReason;
    return {
      state: 'missing',
      title: '未记录上下文诊断',
      detail: reason
        ? `该请求没有上下文预算数据 · ${reason}`
        : '该请求没有可用于排查的上下文预算数据',
      severity: 'warn',
      badges: reason ? ['no-context-diagnostics', reason] : ['no-context-diagnostics'],
    };
  }

  const providerCache = diagnostics.providerCache;
  const contextCache = contextBudget.contextCache;
  const droppedCount = Number(contextBudget.droppedCount || 0);
  const optimizedCount = Number(contextBudget.optimizedCount || 0);
  const overBudgetTokens = Number(contextBudget.overBudgetTokens || 0);
  const badges = [];
  if (droppedCount > 0) badges.push(`drop:${droppedCount}`);
  if (optimizedCount > 0) badges.push(`fold:${optimizedCount}`);
  if (overBudgetTokens > 0) badges.push(`over:${overBudgetTokens}`);
  if (contextCache && contextCache.candidate) badges.push('stable-prefix');
  if (providerCache && providerCache.applied) badges.push('provider-cache-applied');
  else if (providerCache && providerCache.candidate) badges.push('provider-cache-candidate');

  let title = '上下文未触发裁剪';
  let severity = 'ok';
  if (droppedCount > 0) {
    title = '上下文已丢弃历史消息';
    severity = 'danger';
  } else if (optimizedCount > 0 || overBudgetTokens > 0) {
    title = '上下文已折叠或接近预算';
    severity = 'warn';
  }

  const before = Number(contextBudget.estimatedBeforeTokens || 0);
  const after = Number(contextBudget.estimatedInputTokens || 0);
  const budget = Number(contextBudget.inputBudgetTokens || 0);
  const detailParts = [];
  if (before || after)
    detailParts.push(`${formatAuditTokens(before)} -> ${formatAuditTokens(after)} tok`);
  if (budget) detailParts.push(`预算 ${formatAuditTokens(budget)} tok`);
  if (contextBudget.policy) detailParts.push(contextBudget.policy);

  return {
    state: severity === 'ok' ? 'healthy' : 'attention',
    title,
    detail: detailParts.join(' · ') || '已记录上下文预算数据',
    severity,
    badges,
  };
}

export function auditContextDiagnosticRows(record) {
  const diagnostics = record && record.contextDiagnostics;
  const contextBudget = diagnostics && diagnostics.contextBudget;
  if (!contextBudget) return [];
  const contextCache = contextBudget.contextCache;
  const providerCache = diagnostics.providerCache;
  const rows = [
    ['策略', contextBudget.policy || '未指定'],
    ['来源', contextBudget.source || 'unknown'],
    ['预算 Token', formatAuditTokens(contextBudget.inputBudgetTokens || 0)],
    ['裁剪前估算', formatAuditTokens(contextBudget.estimatedBeforeTokens || 0)],
    ['裁剪后估算', formatAuditTokens(contextBudget.estimatedInputTokens || 0)],
    ['固定输入 Token', formatAuditTokens(contextBudget.fixedInputTokens || 0)],
    ['超预算 Token', formatAuditTokens(contextBudget.overBudgetTokens || 0)],
    ['折叠条数', formatAuditTokens(contextBudget.optimizedCount || 0)],
    ['丢弃条数', formatAuditTokens(contextBudget.droppedCount || 0)],
    ['节省字符', formatAuditTokens(contextBudget.savedChars || 0)],
  ];
  if (contextCache) {
    rows.push(
      ['稳定前缀', contextCache.candidate ? '候选' : '未达阈值'],
      ['前缀 Token', formatAuditTokens(contextCache.stablePrefixTokens || 0)],
      ['动态 Token', formatAuditTokens(contextCache.dynamicTokens || 0)],
      ['前缀 Hash', contextCache.stablePrefixHash || '无']
    );
  }
  if (providerCache) {
    rows.push(
      ['Provider Cache', auditProviderCacheState(providerCache)],
      ['Provider', providerCache.provider || 'unknown'],
      ['Cache Policy', providerCache.policy || 'diagnostics-only'],
      ['Cache Reason', providerCache.reason || '']
    );
  }
  if (diagnostics.repairedOrphanToolResults) {
    rows.push(['修复孤立工具结果', formatAuditTokens(diagnostics.repairedOrphanToolResults)]);
  }
  return rows;
}

export function auditDetailMetricRows(record) {
  const usage = (record && record.usage) || {};
  const cost = (record && record.cost) || {};
  const diagnostics = record && record.contextDiagnostics;
  const contextBudget = diagnostics && diagnostics.contextBudget;
  const contextCache = contextBudget && contextBudget.contextCache;
  const providerCache = diagnostics && diagnostics.providerCache;
  const usageSource = usage.source === 'provider' ? '上游 usage' : '本地估算';
  const rows = [
    [
      '输入 Token',
      formatAuditTokens(usage.inputTokens),
      auditCachedInputLabel(usage) || usageSource,
    ],
    ['输出 Token', formatAuditTokens(usage.outputTokens), usageSource],
    ['总 Token', formatAuditTokens(usage.totalTokens), usageSource],
    [
      '估算成本',
      formatAuditCost(cost),
      cost && cost.pricing
        ? `${cost.pricing.match} · ${cost.currency || 'USD'}`
        : '可在 modelPricing 覆盖',
    ],
  ];
  if (contextBudget)
    rows.push([
      '上下文预算',
      formatAuditTokens(contextBudget.estimatedInputTokens || 0),
      auditContextBudgetLabel(contextBudget),
    ]);
  if (contextCache)
    rows.push([
      '缓存前缀',
      contextCache.candidate ? '候选' : '未达阈值',
      `${formatAuditTokens(contextCache.stablePrefixTokens || 0)} tok · ${contextCache.stablePrefixHash || '无'}`,
    ]);
  if (providerCache)
    rows.push([
      '缓存策略',
      auditProviderCacheState(providerCache),
      `${providerCache.provider || 'unknown'} · ${providerCache.policy || 'diagnostics-only'}`,
    ]);
  return rows;
}
