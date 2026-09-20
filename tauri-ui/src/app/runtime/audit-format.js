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
