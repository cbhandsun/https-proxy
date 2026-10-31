const { decodeBodyBuffer, estimateTokens } = require('./request-utils');
const { parseBoundedInteger } = require('./management-utils');

const SENSITIVE_HEADER_RE =
  /^(authorization|proxy-authorization|x-api-key|x-goog-api-key|api-key|cookie|set-cookie|x-hpm-evidence-token)$/i;
const MAX_AUDIT_BODY_CHARS = parseBoundedInteger(
  process.env.PROXY_AUDIT_BODY_TEXT_CHARS,
  120000,
  1024,
  1024 * 1024
);
const MAX_USAGE_TOKENS = 1000000000;
const MAX_PRICE_PER_MILLION = 1000000;
const MAX_COST_AMOUNT = 1000000000;

const DEFAULT_MODEL_PRICING = [
  { match: 'gpt-5.2-pro', inputPerMillion: 21, cachedInputPerMillion: null, outputPerMillion: 168 },
  { match: 'gpt-5-pro', inputPerMillion: 15, cachedInputPerMillion: null, outputPerMillion: 120 },
  { match: 'gpt-5.2', inputPerMillion: 1.75, cachedInputPerMillion: 0.175, outputPerMillion: 14 },
  { match: 'gpt-5.1', inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 },
  { match: 'gpt-5-mini', inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 2 },
  {
    match: 'gpt-5-nano',
    inputPerMillion: 0.05,
    cachedInputPerMillion: 0.005,
    outputPerMillion: 0.4,
  },
  { match: 'gpt-5', inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 },
  {
    match: 'gpt-4.1-mini',
    inputPerMillion: 0.4,
    cachedInputPerMillion: 0.1,
    outputPerMillion: 1.6,
  },
  {
    match: 'gpt-4.1-nano',
    inputPerMillion: 0.1,
    cachedInputPerMillion: 0.025,
    outputPerMillion: 0.4,
  },
  { match: 'gpt-4.1', inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8 },
  {
    match: 'gpt-4o-mini',
    inputPerMillion: 0.15,
    cachedInputPerMillion: 0.075,
    outputPerMillion: 0.6,
  },
  { match: 'gpt-4o', inputPerMillion: 2.5, cachedInputPerMillion: 1.25, outputPerMillion: 10 },
  {
    match: 'codex-mini-latest',
    inputPerMillion: 1.5,
    cachedInputPerMillion: 0.375,
    outputPerMillion: 6,
  },
  { match: 'gpt-5.4', inputPerMillion: 2.5, cachedInputPerMillion: 0.25, outputPerMillion: 10 },
  { match: 'gpt-5.3', inputPerMillion: 2.0, cachedInputPerMillion: 0.2, outputPerMillion: 8 },
  { match: 'o3', inputPerMillion: 2.0, cachedInputPerMillion: 0.5, outputPerMillion: 8 },
  { match: 'o4-mini', inputPerMillion: 1.1, cachedInputPerMillion: 0.275, outputPerMillion: 4.4 },
  { match: 'claude-opus-4', inputPerMillion: 15, cachedInputPerMillion: 1.5, outputPerMillion: 75 },
  { match: 'claude-sonnet-4', inputPerMillion: 3, cachedInputPerMillion: 0.3, outputPerMillion: 15 },
  { match: 'claude-haiku-4', inputPerMillion: 0.8, cachedInputPerMillion: 0.08, outputPerMillion: 4 },
  { match: 'claude-3-7-sonnet', inputPerMillion: 3, cachedInputPerMillion: 0.3, outputPerMillion: 15 },
  { match: 'claude-3-5-sonnet', inputPerMillion: 3, cachedInputPerMillion: 0.3, outputPerMillion: 15 },
  { match: 'claude-3-5-haiku', inputPerMillion: 0.8, cachedInputPerMillion: 0.08, outputPerMillion: 4 },
  { match: 'deepseek-reasoner', inputPerMillion: 0.55, cachedInputPerMillion: 0.14, outputPerMillion: 2.19 },
  { match: 'deepseek-r1', inputPerMillion: 0.55, cachedInputPerMillion: 0.14, outputPerMillion: 2.19 },
  { match: 'deepseek-chat', inputPerMillion: 0.27, cachedInputPerMillion: 0.07, outputPerMillion: 1.1 },
  { match: 'deepseek-v3', inputPerMillion: 0.27, cachedInputPerMillion: 0.07, outputPerMillion: 1.1 },
  { match: 'deepseek-v4', inputPerMillion: 0.3, cachedInputPerMillion: 0.075, outputPerMillion: 1.2 },
  { match: 'kimi-for-coding', inputPerMillion: 0.6, cachedInputPerMillion: 0.15, outputPerMillion: 2.5 },
  { match: 'kimi-k2', inputPerMillion: 0.6, cachedInputPerMillion: 0.15, outputPerMillion: 2.5 },
  { match: 'kimi-thinking', inputPerMillion: 1.0, cachedInputPerMillion: 0.25, outputPerMillion: 3.0 },
  { match: 'glm-5', inputPerMillion: 0.5, cachedInputPerMillion: 0.1, outputPerMillion: 2.0 },
  { match: 'glm-4.7', inputPerMillion: 0.4, cachedInputPerMillion: 0.08, outputPerMillion: 1.6 },
  { match: 'glm-4.5', inputPerMillion: 0.15, cachedInputPerMillion: 0.03, outputPerMillion: 0.6 },
  { match: 'qwen3-coder', inputPerMillion: 0.3, cachedInputPerMillion: 0.06, outputPerMillion: 1.2 },
  { match: 'qwen-max', inputPerMillion: 0.8, cachedInputPerMillion: 0.16, outputPerMillion: 2.4 },
  { match: 'qwq', inputPerMillion: 0.3, cachedInputPerMillion: 0.06, outputPerMillion: 1.2 },
  { match: 'minimax-m2', inputPerMillion: 0.3, cachedInputPerMillion: 0.06, outputPerMillion: 1.2 },
  { match: 'minimax-m3', inputPerMillion: 0.4, cachedInputPerMillion: 0.08, outputPerMillion: 1.6 },
  { match: 'gemini-3-pro', inputPerMillion: 1.25, cachedInputPerMillion: 0.31, outputPerMillion: 10 },
  { match: 'gemini-3-flash', inputPerMillion: 0.15, cachedInputPerMillion: 0.0375, outputPerMillion: 0.6 },
  { match: 'gemini-2.5-pro', inputPerMillion: 1.25, cachedInputPerMillion: 0.31, outputPerMillion: 10 },
  { match: 'gemini-2.5-flash', inputPerMillion: 0.15, cachedInputPerMillion: 0.0375, outputPerMillion: 0.6 },
];

function redactHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (SENSITIVE_HEADER_RE.test(key)) {
      result[key] = '[redacted]';
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => String(item));
    } else {
      result[key] = value == null ? '' : String(value);
    }
  }
  return result;
}

function headersForReplay(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (SENSITIVE_HEADER_RE.test(lower)) continue;
    if (lower === 'host' || lower === 'content-length' || lower === 'connection') continue;
    if (lower.startsWith('access-control-')) continue;
    result[key] = value;
  }
  return result;
}

function truncateText(value, limit = MAX_AUDIT_BODY_CHARS) {
  const text = String(value == null ? '' : value);
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true, originalLength: text.length };
}

function captureRequestBody(buffer, encoding) {
  const body = decodeBodyBuffer(buffer || Buffer.alloc(0), encoding);
  const captured = truncateText(body);
  return {
    body: captured.text,
    truncated: captured.truncated,
    originalLength: captured.originalLength || body.length,
  };
}

function parseJsonText(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}

function normalizeUsage(value) {
  if (!value || typeof value !== 'object') return null;
  let input = parseBoundedInteger(
    value.input_tokens ?? value.prompt_tokens ?? value.promptTokenCount ?? value.inputTokens,
    0,
    0,
    MAX_USAGE_TOKENS
  );
  let output = parseBoundedInteger(
    value.output_tokens ??
      value.completion_tokens ??
      value.candidatesTokenCount ??
      value.outputTokens,
    0,
    0,
    MAX_USAGE_TOKENS
  );
  // Gemini candidates exclude thought tokens; OpenAI/converted output totals already include them.
  if (
    value.output_tokens == null &&
    value.completion_tokens == null &&
    value.outputTokens == null &&
    value.candidatesTokenCount != null
  ) {
    output = Math.min(
      MAX_USAGE_TOKENS,
      output + parseBoundedInteger(value.thoughtsTokenCount, 0, 0, MAX_USAGE_TOKENS)
    );
  }
  const cachedInput = parseBoundedInteger(
    value.cached_input_tokens ??
      value.cachedInputTokens ??
      value.prompt_tokens_details?.cached_tokens ??
      // Anthropic-compatible upstreams (and DeepSeek/GLM in Claude mode) report the
      // cache hit as cache_read_input_tokens; OpenAI Responses reports
      // input_tokens_details.cached_tokens. The previous singular
      // `input_token_details.cache_read` matched neither, so every record from either
      // provider reported cachedInputTokens: 0 and cost/cache reporting was wrong.
      value.cache_read_input_tokens ??
      value.input_tokens_details?.cached_tokens ??
      value.prompt_cache_hit_tokens ??
      value.cachedContentTokenCount ??
      value.cached_content_token_count ??
      value.input_token_details?.cache_read,
    0,
    0,
    MAX_USAGE_TOKENS
  );
  // Anthropic-compatible upstreams (Claude API, and DeepSeek/GLM in Claude mode)
  // report cache hits separately from input_tokens instead of folding them in, so
  // input_tokens alone understates the real prompt. estimateCost() subtracts the
  // cached portion from inputTokens, so without this the cached tokens are dropped
  // from cost entirely and total_tokens looks far smaller than the real prompt.
  // Only Anthropic-style payloads report cache reads outside input_tokens. Providers
  // that include them (DeepSeek prompt_cache_hit_tokens, OpenAI cached_tokens) must not
  // be summed again or the prompt would be double-counted.
  const claudeStyleCacheAccounting =
    value.cache_read_input_tokens != null || value.cache_creation_input_tokens != null;
  if (cachedInput > 0 && claudeStyleCacheAccounting) {
    input = Math.min(MAX_USAGE_TOKENS, input + cachedInput);
  }
  const total = parseBoundedInteger(
    value.total_tokens ??
      value.totalTokenCount ??
      (typeof value.totalTokens === 'number' &&
      Number.isFinite(value.totalTokens) &&
      value.totalTokens >= 0 &&
      value.totalTokens <= MAX_USAGE_TOKENS
        ? value.totalTokens
        : undefined),
    input + output,
    0,
    MAX_USAGE_TOKENS
  );
  if (!input && !output && !total) return null;
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cachedInput,
    totalTokens: total,
    source: value.source === 'estimated' ? 'estimated' : 'provider',
  };
}

function extractUsageFromJsonPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return normalizeUsage(payload.usage || payload.usageMetadata || payload);
}

function usageFromSsePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.usage || payload.usageMetadata) return extractUsageFromJsonPayload(payload);
  if (payload.type === 'message_start' && payload.message && payload.message.usage) {
    return normalizeUsage(payload.message.usage);
  }
  if (payload.type === 'message_delta' && payload.usage) {
    return normalizeUsage(payload.usage);
  }
  if (payload.type === 'response.done' && payload.response && payload.response.usage) {
    return normalizeUsage(payload.response.usage);
  }
  // Official Responses streams terminate with response.completed (or
  // response.incomplete); without these branches provider usage is never seen and
  // every audit record falls back to a rough local estimate.
  if (
    (payload.type === 'response.completed' || payload.type === 'response.incomplete') &&
    payload.response &&
    payload.response.usage
  ) {
    return normalizeUsage(payload.response.usage);
  }
  return null;
}

function mergeUsage(base, next) {
  if (!next) return base;
  if (!base) return { ...next };
  return {
    inputTokens: Math.max(
      parseBoundedInteger(base.inputTokens, 0, 0, MAX_USAGE_TOKENS),
      parseBoundedInteger(next.inputTokens, 0, 0, MAX_USAGE_TOKENS)
    ),
    outputTokens: Math.max(
      parseBoundedInteger(base.outputTokens, 0, 0, MAX_USAGE_TOKENS),
      parseBoundedInteger(next.outputTokens, 0, 0, MAX_USAGE_TOKENS)
    ),
    cachedInputTokens: Math.max(
      parseBoundedInteger(base.cachedInputTokens, 0, 0, MAX_USAGE_TOKENS),
      parseBoundedInteger(next.cachedInputTokens, 0, 0, MAX_USAGE_TOKENS)
    ),
    totalTokens: Math.max(
      parseBoundedInteger(base.totalTokens, 0, 0, MAX_USAGE_TOKENS),
      parseBoundedInteger(next.totalTokens, 0, 0, MAX_USAGE_TOKENS)
    ),
    source:
      base.source === 'provider' || next.source === 'provider'
        ? 'provider'
        : next.source || base.source || 'estimated',
  };
}

// The captured request body is truncated for storage (default 120000 chars), so
// estimating from it undercounts badly: live records show a 2.6 MB request being
// estimated as 30000 input tokens against an actual 2.6 MB payload. When the body was
// truncated, estimate from the true serialized byte count instead.
const ESTIMATE_BYTES_PER_TOKEN = 4;

function estimateRequestTokens(record) {
  const request = record && record.request;
  const bodyBytes =
    request && Number.isFinite(Number(request.bodyBytes)) ? Number(request.bodyBytes) : 0;
  const bodyChars = request && typeof request.body === 'string' ? request.body.length : 0;
  const truncated = request && request.truncated === true;
  // Prefer bytes when the stored body is incomplete; otherwise the stored body may be
  // the only copy (some records only carry one of the two fields).
  const useBytes = truncated ? bodyBytes > 0 : bodyBytes > bodyChars;
  const requestTokens = useBytes
    ? Math.ceil(bodyBytes / ESTIMATE_BYTES_PER_TOKEN)
    : estimateTokens(request && request.body);
  return (
    requestTokens +
    estimateTokens({ system: record && record.system, messages: record && record.messages })
  );
}

function estimateUsageForRecord(record) {
  const inputTokens = estimateRequestTokens(record);
  const outputTokens = estimateTokens(record.response);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: 0,
    totalTokens: inputTokens + outputTokens,
    source: 'estimated',
  };
}

function configuredPricingEntries(config) {
  const raw = config && config.modelPricing;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object') {
    return Object.entries(raw).map(([match, value]) => ({ match, ...(value || {}) }));
  }
  return [];
}

function normalizePricing(entry) {
  if (!entry) return null;
  const inputPerMillion = Number(entry.inputPerMillion ?? entry.input ?? entry.prompt ?? 0);
  const outputPerMillion = Number(entry.outputPerMillion ?? entry.output ?? entry.completion ?? 0);
  const cachedInputPerMillion =
    entry.cachedInputPerMillion == null ? null : Number(entry.cachedInputPerMillion);
  if (
    !Number.isFinite(inputPerMillion) ||
    !Number.isFinite(outputPerMillion) ||
    inputPerMillion < 0 ||
    outputPerMillion < 0 ||
    inputPerMillion > MAX_PRICE_PER_MILLION ||
    outputPerMillion > MAX_PRICE_PER_MILLION
  )
    return null;
  if (
    cachedInputPerMillion != null &&
    (!Number.isFinite(cachedInputPerMillion) ||
      cachedInputPerMillion < 0 ||
      cachedInputPerMillion > MAX_PRICE_PER_MILLION)
  )
    return null;
  return {
    match: String(entry.match || entry.model || ''),
    inputPerMillion,
    cachedInputPerMillion: Number.isFinite(cachedInputPerMillion) ? cachedInputPerMillion : null,
    outputPerMillion,
    currency: entry.currency || 'USD',
    source: entry.source || 'config',
  };
}

function pricingMatches(entry, model) {
  const match = String(entry.match || '').toLowerCase();
  const value = String(model || '').toLowerCase();
  if (!match || !value) return false;
  if (match.startsWith('/') && match.endsWith('/')) {
    try {
      return new RegExp(match.slice(1, -1), 'i').test(value);
    } catch (err) {
      return false;
    }
  }
  const baseName = value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value;
  return (
    value === match ||
    value.startsWith(match + '-') ||
    value.startsWith(match + '.') ||
    baseName === match ||
    baseName.startsWith(match + '-') ||
    baseName.startsWith(match + '.')
  );
}

function resolveModelPricing(model, config) {
  const configured = configuredPricingEntries(config).map(normalizePricing).filter(Boolean);
  const defaults = DEFAULT_MODEL_PRICING.map((entry) =>
    normalizePricing({ ...entry, source: 'default' })
  );
  return [...configured, ...defaults].find((entry) => pricingMatches(entry, model)) || null;
}

function estimateCost(usage, model, config) {
  const normalized = normalizeUsage(usage);
  const pricing = resolveModelPricing(model, config);
  if (!normalized || !pricing) {
    return { amount: 0, currency: 'USD', known: false, pricing: null };
  }
  const cached = Math.min(normalized.cachedInputTokens || 0, normalized.inputTokens || 0);
  const uncached = Math.max(0, (normalized.inputTokens || 0) - cached);
  const inputCost = (uncached / 1000000) * pricing.inputPerMillion;
  const cachedInputCost =
    pricing.cachedInputPerMillion == null ? 0 : (cached / 1000000) * pricing.cachedInputPerMillion;
  const outputCost = ((normalized.outputTokens || 0) / 1000000) * pricing.outputPerMillion;
  return {
    amount: inputCost + cachedInputCost + outputCost,
    currency: pricing.currency || 'USD',
    known: true,
    pricing,
  };
}

function summarizeAuditRecord(record, config) {
  const model = record.rewriteModel || record.originalModel || '';
  const estimatedUsage = estimateUsageForRecord(record);
  const providerUsage = normalizeUsage(record.usage);
  const baseUsage = providerUsage || estimatedUsage;
  const usage = {
    ...baseUsage,
    cacheHitRate:
      baseUsage.source === 'provider' && baseUsage.inputTokens > 0
        ? Math.min(1, (baseUsage.cachedInputTokens || 0) / baseUsage.inputTokens)
        : null,
  };
  const inputEstimateRatio =
    providerUsage && estimatedUsage.inputTokens > 0
      ? providerUsage.inputTokens / estimatedUsage.inputTokens
      : null;
  const cost = record.cost && record.cost.known ? record.cost : estimateCost(usage, model, config);
  return {
    id: record.id,
    time: record.time,
    profileId: record.profileId || '',
    profileName: record.profileName || '默认',
    model,
    originalModel: record.originalModel || '',
    rewriteModel: record.rewriteModel || '',
    protocol: record.protocol || '',
    statusCode: record.statusCode || 0,
    elapsed: record.elapsed || 0,
    usage,
    estimatedUsage,
    contextDiagnostics: record.contextDiagnostics || null,
    usageCalibration: {
      inputEstimateRatio,
      estimatedInputTokens: estimatedUsage.inputTokens,
      estimatedTotalTokens: estimatedUsage.totalTokens,
    },
    cost,
    maskedCount: Number(record.maskedCount || 0) || 0,
    failoverFrom: record.failoverFrom || '',
  };
}

function emptyGroup(key, label) {
  return {
    key,
    label,
    requests: 0,
    successes: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheHitRate: null,
    providerInputTokens: 0,
    providerCachedInputTokens: 0,
    providerRecords: 0,
    totalTokens: 0,
    estimatedRecords: 0,
    cost: 0,
    context: {
      records: 0,
      missingDiagnostics: 0,
      attentionRecords: 0,
      overBudgetRecords: 0,
      optimizedRecords: 0,
      droppedRecords: 0,
      optimizedMessages: 0,
      droppedMessages: 0,
      overBudgetTokens: 0,
      savedChars: 0,
      stablePrefixCandidates: 0,
      providerCacheEnabled: 0,
      providerCacheCandidates: 0,
      providerCacheApplied: 0,
      providerCacheConfirmedHits: 0,
      stablePrefixChanges: 0,
      providerContextRecords: 0,
      providerCompactionApplied: 0,
      providerContextExplicit: 0,
      compactionTriggeredRecords: 0,
      compactionAppliedRecords: 0,
      batchSavingsTokens: 0,
      stablePrefixPreservedRecords: 0,
      stablePrefixInvalidatedRecords: 0,
    },
  };
}

function addContextDiagnosticsToGroup(group, diagnostics) {
  const context = group.context;
  if (!diagnostics || typeof diagnostics !== 'object') {
    context.missingDiagnostics += 1;
    return;
  }
  const providerContext =
    diagnostics.providerContext && typeof diagnostics.providerContext === 'object'
      ? diagnostics.providerContext
      : null;
  if (providerContext) {
    context.providerContextRecords += 1;
    if (providerContext.applied === true) context.providerCompactionApplied += 1;
    if (providerContext.explicit === true) context.providerContextExplicit += 1;
  }
  const contextBudget =
    diagnostics.contextBudget && typeof diagnostics.contextBudget === 'object'
      ? diagnostics.contextBudget
      : null;
  if (!contextBudget) {
    context.missingDiagnostics += 1;
    return;
  }
  context.records += 1;
  const optimized = parseBoundedInteger(contextBudget.optimizedCount, 0, 0, MAX_USAGE_TOKENS);
  const dropped = parseBoundedInteger(contextBudget.droppedCount, 0, 0, MAX_USAGE_TOKENS);
  const overBudget = parseBoundedInteger(contextBudget.overBudgetTokens, 0, 0, MAX_USAGE_TOKENS);
  if (contextBudget.compactionTriggered === true) context.compactionTriggeredRecords += 1;
  if (contextBudget.compactionApplied === true) context.compactionAppliedRecords += 1;
  context.batchSavingsTokens += parseBoundedInteger(
    contextBudget.batchSavingsTokens,
    0,
    0,
    MAX_USAGE_TOKENS
  );
  if (contextBudget.compactionTriggered === true) {
    if (contextBudget.stablePrefixPreserved === false) context.stablePrefixInvalidatedRecords += 1;
    else context.stablePrefixPreservedRecords += 1;
  }
  context.optimizedMessages += optimized;
  context.droppedMessages += dropped;
  context.overBudgetTokens += overBudget;
  context.savedChars += parseBoundedInteger(contextBudget.savedChars, 0, 0, MAX_USAGE_TOKENS);
  if (optimized > 0) context.optimizedRecords += 1;
  if (dropped > 0) context.droppedRecords += 1;
  if (overBudget > 0) context.overBudgetRecords += 1;
  if (optimized > 0 || dropped > 0 || overBudget > 0) context.attentionRecords += 1;

  const cache =
    contextBudget.contextCache && typeof contextBudget.contextCache === 'object'
      ? contextBudget.contextCache
      : null;
  if (cache && cache.candidate === true) context.stablePrefixCandidates += 1;
  const stablePrefixHash = cache && cache.stablePrefixHash ? String(cache.stablePrefixHash) : '';
  if (stablePrefixHash) {
    if (context._lastStablePrefixHash && context._lastStablePrefixHash !== stablePrefixHash) {
      context.stablePrefixChanges += 1;
    }
    Object.defineProperty(context, '_lastStablePrefixHash', {
      value: stablePrefixHash,
      configurable: true,
      writable: true,
      enumerable: false,
    });
  }

  const providerCache =
    diagnostics.providerCache && typeof diagnostics.providerCache === 'object'
      ? diagnostics.providerCache
      : null;
  if (providerCache && providerCache.enabled === true) context.providerCacheEnabled += 1;
  if (providerCache && providerCache.candidate === true) context.providerCacheCandidates += 1;
  if (providerCache && providerCache.applied === true) context.providerCacheApplied += 1;
}

function addSummaryToGroup(group, summary) {
  group.requests += 1;
  if (summary.statusCode >= 200 && summary.statusCode < 300) group.successes += 1;
  else group.errors += 1;
  group.inputTokens += parseBoundedInteger(summary.usage.inputTokens, 0, 0, MAX_USAGE_TOKENS);
  group.outputTokens += parseBoundedInteger(summary.usage.outputTokens, 0, 0, MAX_USAGE_TOKENS);
  group.cachedInputTokens += parseBoundedInteger(
    summary.usage.cachedInputTokens,
    0,
    0,
    MAX_USAGE_TOKENS
  );
  group.totalTokens += parseBoundedInteger(summary.usage.totalTokens, 0, 0, MAX_USAGE_TOKENS);
  if (summary.usage.source !== 'provider') group.estimatedRecords += 1;
  else {
    group.providerRecords += 1;
    group.providerInputTokens += parseBoundedInteger(
      summary.usage.inputTokens,
      0,
      0,
      MAX_USAGE_TOKENS
    );
    group.providerCachedInputTokens += Math.min(
      parseBoundedInteger(summary.usage.cachedInputTokens, 0, 0, MAX_USAGE_TOKENS),
      parseBoundedInteger(summary.usage.inputTokens, 0, 0, MAX_USAGE_TOKENS)
    );
    if (summary.usage.cachedInputTokens > 0) group.context.providerCacheConfirmedHits += 1;
  }
  if (summary.cost && summary.cost.known) {
    const amount = Number(summary.cost.amount || 0);
    if (Number.isFinite(amount) && amount >= 0) group.cost += Math.min(amount, MAX_COST_AMOUNT);
  }
  group.cacheHitRate =
    group.providerInputTokens > 0
      ? Math.min(1, group.providerCachedInputTokens / group.providerInputTokens)
      : null;
  addContextDiagnosticsToGroup(group, summary.contextDiagnostics);
}

function buildUsageReport(records, config) {
  const summaries = (records || []).map((record) => summarizeAuditRecord(record, config));
  const total = emptyGroup('total', '全部请求');
  const byProfile = new Map();
  const byModel = new Map();
  const byDay = new Map();
  for (const summary of summaries) {
    addSummaryToGroup(total, summary);
    const profileKey = summary.profileId || summary.profileName || 'default';
    if (!byProfile.has(profileKey))
      byProfile.set(profileKey, emptyGroup(profileKey, summary.profileName || profileKey));
    addSummaryToGroup(byProfile.get(profileKey), summary);

    const modelKey = summary.model || 'unknown';
    if (!byModel.has(modelKey)) byModel.set(modelKey, emptyGroup(modelKey, modelKey));
    addSummaryToGroup(byModel.get(modelKey), summary);

    const dayKey = summary.time ? String(summary.time).slice(0, 10) : 'unknown';
    if (!byDay.has(dayKey)) byDay.set(dayKey, emptyGroup(dayKey, dayKey));
    addSummaryToGroup(byDay.get(dayKey), summary);
  }
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    currency: 'USD',
    total,
    byProfile: Array.from(byProfile.values()).sort((a, b) => b.totalTokens - a.totalTokens),
    byModel: Array.from(byModel.values()).sort((a, b) => b.totalTokens - a.totalTokens),
    byDay: Array.from(byDay.values()).sort((a, b) => a.key.localeCompare(b.key)),
    recent: summaries.slice(0, 100),
    pricingDefaults: DEFAULT_MODEL_PRICING,
  };
}

module.exports = {
  DEFAULT_MODEL_PRICING,
  redactHeaders,
  headersForReplay,
  captureRequestBody,
  parseJsonText,
  normalizeUsage,
  extractUsageFromJsonPayload,
  usageFromSsePayload,
  mergeUsage,
  estimateUsageForRecord,
  resolveModelPricing,
  estimateCost,
  summarizeAuditRecord,
  buildUsageReport,
};
