const { decodeBodyBuffer, estimateTokens } = require('./request-utils');
const { parseBoundedInteger } = require('./management-utils');

const SENSITIVE_HEADER_RE =
  /^(authorization|proxy-authorization|x-api-key|x-goog-api-key|api-key|cookie|set-cookie)$/i;
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
  const input = parseBoundedInteger(
    value.input_tokens ?? value.prompt_tokens ?? value.promptTokenCount ?? value.inputTokens,
    0,
    0,
    MAX_USAGE_TOKENS
  );
  const output = parseBoundedInteger(
    value.output_tokens ??
      value.completion_tokens ??
      value.candidatesTokenCount ??
      value.outputTokens,
    0,
    0,
    MAX_USAGE_TOKENS
  );
  const cachedInput = parseBoundedInteger(
    value.cached_input_tokens ??
      value.prompt_tokens_details?.cached_tokens ??
      value.input_token_details?.cache_read,
    0,
    0,
    MAX_USAGE_TOKENS
  );
  const total = parseBoundedInteger(
    value.total_tokens ?? value.totalTokenCount,
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
    source: value.source || 'provider',
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

function estimateUsageForRecord(record) {
  const inputTokens = estimateTokens({
    system: record.system,
    messages: record.messages,
    request: record.request && record.request.body,
  });
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
  return value === match || value.startsWith(match + '-') || value.startsWith(match + '.');
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
  const usage = normalizeUsage(record.usage) || estimateUsageForRecord(record);
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
    cost,
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
    totalTokens: 0,
    estimatedRecords: 0,
    cost: 0,
  };
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
  if (summary.cost && summary.cost.known) {
    const amount = Number(summary.cost.amount || 0);
    if (Number.isFinite(amount) && amount >= 0) group.cost += Math.min(amount, MAX_COST_AMOUNT);
  }
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
