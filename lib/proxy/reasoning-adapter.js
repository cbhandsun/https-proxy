'use strict';

const OPENAI_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

const EFFORT_TO_BUDGET = Object.freeze({
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 16384,
  xhigh: 32768,
});

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeEffort(value) {
  if (value == null || value === '') return { present: false, valid: true, effort: null };
  if (typeof value !== 'string') return { present: true, valid: false, effort: null };
  const effort = value.trim().toLowerCase();
  if (!OPENAI_REASONING_EFFORTS.has(effort)) {
    return { present: true, valid: false, effort: null };
  }
  return { present: true, valid: true, effort };
}

function parseOpenAIReasoningEffort(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { present: false, valid: true, effort: null };
  }

  const direct = hasOwn(body, 'reasoning_effort')
    ? normalizeEffort(body.reasoning_effort)
    : { present: false, valid: true, effort: null };
  if (!direct.valid) return direct;

  let nested = { present: false, valid: true, effort: null };
  if (hasOwn(body, 'reasoning') && body.reasoning != null) {
    if (typeof body.reasoning !== 'object' || Array.isArray(body.reasoning)) {
      return { present: true, valid: false, effort: null };
    }
    nested = hasOwn(body.reasoning, 'effort')
      ? normalizeEffort(body.reasoning.effort)
      : { present: true, valid: true, effort: null };
    if (!nested.valid) return nested;
  }

  if (direct.effort && nested.effort && direct.effort !== nested.effort) {
    return { present: true, valid: false, effort: null };
  }
  return {
    present: direct.present || nested.present,
    valid: true,
    effort: direct.effort || nested.effort || null,
  };
}

function budgetToEffort(budget) {
  const n = Number(budget);
  if (!Number.isFinite(n) || n <= 0) return 'none';
  if (n <= 1500) return 'minimal';
  if (n <= 3000) return 'low';
  if (n <= 10000) return 'medium';
  if (n <= 24000) return 'high';
  return 'xhigh';
}

function effortToBudget(effort) {
  if (!effort || typeof effort !== 'string') return 4096;
  const key = effort.trim().toLowerCase();
  return EFFORT_TO_BUDGET[key] || 4096;
}

function extractCanonicalReasoning(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { present: false, valid: true, enabled: false, effort: null, budgetTokens: null };
  }

  // 1. OpenAI reasoning_effort / reasoning.effort
  const parsedOAI = parseOpenAIReasoningEffort(body);
  if (parsedOAI.present) {
    if (!parsedOAI.valid) {
      return { present: true, valid: false, enabled: false, effort: null, budgetTokens: null };
    }
    const effort = parsedOAI.effort;
    const enabled = Boolean(effort && effort !== 'none');
    return {
      present: true,
      valid: true,
      enabled,
      effort: effort || null,
      budgetTokens: enabled ? effortToBudget(effort) : 0,
    };
  }

  // 2. Claude thinking: { type: 'enabled' | 'disabled', budget_tokens: number }
  if (hasOwn(body, 'thinking') && body.thinking != null) {
    if (typeof body.thinking !== 'object' || Array.isArray(body.thinking)) {
      return { present: true, valid: false, enabled: false, effort: null, budgetTokens: null };
    }
    const type = String(body.thinking.type || '')
      .trim()
      .toLowerCase();
    if (type === 'enabled') {
      const budget = Number(body.thinking.budget_tokens);
      const budgetTokens = Number.isFinite(budget) && budget > 0 ? budget : 2048;
      const effort = budgetToEffort(budgetTokens);
      return {
        present: true,
        valid: true,
        enabled: true,
        effort,
        budgetTokens,
      };
    }
    if (type === 'disabled') {
      return {
        present: true,
        valid: true,
        enabled: false,
        effort: 'none',
        budgetTokens: 0,
      };
    }
    return { present: true, valid: false, enabled: false, effort: null, budgetTokens: null };
  }

  // 3. Gemini thinkingConfig: { thinkingLevel?: string, thinkingBudget?: number }
  if (
    body.generationConfig &&
    typeof body.generationConfig === 'object' &&
    body.generationConfig.thinkingConfig &&
    typeof body.generationConfig.thinkingConfig === 'object'
  ) {
    const tc = body.generationConfig.thinkingConfig;
    if (hasOwn(tc, 'thinkingLevel') && tc.thinkingLevel != null) {
      const normalized = normalizeEffort(tc.thinkingLevel);
      if (!normalized.valid) {
        return { present: true, valid: false, enabled: false, effort: null, budgetTokens: null };
      }
      const effort = normalized.effort;
      const enabled = Boolean(effort && effort !== 'none');
      return {
        present: true,
        valid: true,
        enabled,
        effort: effort || null,
        budgetTokens: enabled ? effortToBudget(effort) : 0,
      };
    }
    if (hasOwn(tc, 'thinkingBudget') && tc.thinkingBudget != null) {
      const budget = Number(tc.thinkingBudget);
      if (!Number.isFinite(budget)) {
        return { present: true, valid: false, enabled: false, effort: null, budgetTokens: null };
      }
      const enabled = budget > 0;
      const effort = enabled ? budgetToEffort(budget) : 'none';
      return {
        present: true,
        valid: true,
        enabled,
        effort,
        budgetTokens: budget,
      };
    }
  }

  return { present: false, valid: true, enabled: false, effort: null, budgetTokens: null };
}

function normalizedGeminiModel(model) {
  return String(model || '')
    .replace(/^models\//i, '')
    .trim()
    .toLowerCase();
}

function supportsGeminiThinkingLevel(model) {
  const match = normalizedGeminiModel(model).match(/^gemini-(\d+)(?:\.(\d+))?(?:-|$)/);
  return Boolean(match && Number(match[1]) >= 3);
}

function constrainThinkingLevel(model, effort) {
  let level = effort === 'none' ? 'minimal' : effort === 'xhigh' ? 'high' : effort;
  const normalizedModel = normalizedGeminiModel(model);

  if (/^gemini-3-pro(?:-|$)/.test(normalizedModel)) {
    level = level === 'minimal' || level === 'low' ? 'low' : 'high';
  } else if (/^gemini-3\.1-pro(?:-|$)/.test(normalizedModel) && level === 'minimal') {
    level = 'low';
  } else if (/^gemini-3\.1-flash-lite-image(?:-|$)/.test(normalizedModel)) {
    level = level === 'minimal' || level === 'low' ? 'minimal' : 'high';
  }
  return level;
}

function geminiThinkingConfigFromCanonical(canonical, model) {
  if (!canonical || !canonical.valid || !canonical.effort || !supportsGeminiThinkingLevel(model)) {
    return null;
  }
  return { thinkingLevel: constrainThinkingLevel(model, canonical.effort) };
}

function geminiThinkingConfigFromOpenAI(body, model) {
  const parsed = parseOpenAIReasoningEffort(body);
  if (parsed.present) {
    if (!parsed.valid || !parsed.effort || !supportsGeminiThinkingLevel(model)) return null;
    return { thinkingLevel: constrainThinkingLevel(model, parsed.effort) };
  }
  const canonical = extractCanonicalReasoning(body);
  if (!canonical.valid || !canonical.effort || !supportsGeminiThinkingLevel(model)) return null;
  return { thinkingLevel: constrainThinkingLevel(model, canonical.effort) };
}

function applyReasoningToClaude(result, canonical) {
  if (!result || !canonical || !canonical.valid || !canonical.present) return;
  if (canonical.enabled) {
    const budget = Math.max(1024, canonical.budgetTokens || 2048);
    result.thinking = {
      type: 'enabled',
      budget_tokens: budget,
    };
    if (result.max_tokens == null || result.max_tokens <= budget) {
      result.max_tokens = Math.max(result.max_tokens || 4096, budget + 4096);
    }
    result.temperature = 1.0;
    delete result.top_p;
    delete result.top_k;
  } else {
    result.thinking = { type: 'disabled' };
  }
}

function applyReasoningToOpenAI(result, canonical) {
  if (!result || !canonical || !canonical.valid || !canonical.present) return;
  if (canonical.enabled) {
    result.reasoning_effort = canonical.effort;
    delete result.temperature;
  } else {
    result.reasoning_effort = 'none';
  }
}

module.exports = {
  OPENAI_REASONING_EFFORTS,
  EFFORT_TO_BUDGET,
  budgetToEffort,
  effortToBudget,
  parseOpenAIReasoningEffort,
  extractCanonicalReasoning,
  supportsGeminiThinkingLevel,
  constrainThinkingLevel,
  geminiThinkingConfigFromCanonical,
  geminiThinkingConfigFromOpenAI,
  applyReasoningToClaude,
  applyReasoningToOpenAI,
};
