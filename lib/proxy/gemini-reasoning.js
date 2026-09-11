'use strict';

const OPENAI_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

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

function geminiThinkingConfigFromOpenAI(body, model) {
  const parsed = parseOpenAIReasoningEffort(body);
  if (!parsed.valid || !parsed.effort || !supportsGeminiThinkingLevel(model)) return null;
  return { thinkingLevel: constrainThinkingLevel(model, parsed.effort) };
}

module.exports = {
  OPENAI_REASONING_EFFORTS,
  parseOpenAIReasoningEffort,
  supportsGeminiThinkingLevel,
  geminiThinkingConfigFromOpenAI,
};
