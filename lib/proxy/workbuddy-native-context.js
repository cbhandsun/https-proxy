'use strict';

const { estimateTokensForValue } = require('./inline-media');
const { createHash } = require('node:crypto');
const { normalizeWorkBuddyToolHistory } = require('./workbuddy-tool-history');
const {
  parseBufferedChatCompletion,
  CONTEXT_ARTIFACT_TOOL_NAME,
} = require('./context-artifact-tool');
const { TOOL_DISCOVERY_NAME } = require('./context-tool-catalog');

const MAX_BYTES = 64 * 1024 * 1024;
function invalid() {
  return Object.assign(new TypeError('Invalid native context request'), {
    code: 'invalid_native_context_request',
  });
}
function own(value, key, fallback) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return fallback;
  if (!Object.hasOwn(descriptor, 'value')) throw invalid();
  if (descriptor.value === undefined) return fallback;
  return descriptor.value;
}

// Inspect data descriptors before serialization; do not clone or retain another
// history window, invoke accessors/toJSON, or expose data in diagnostics/errors.
function measureNativeWorkBuddyBody(body) {
  const active = new Set();
  const budget = { nodes: 262144, bytes: MAX_BYTES };
  function visit(value, depth, optional = false) {
    if (depth > 64 || --budget.nodes < 0) throw invalid();
    if (typeof value === 'string') {
      budget.bytes -= Buffer.byteLength(value);
      if (budget.bytes < 0) throw invalid();
      return;
    }
    if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (optional && value === undefined)
    )
      return;
    if (!value || typeof value !== 'object' || active.has(value)) throw invalid();
    const array = Array.isArray(value);
    if (
      array
        ? Object.getPrototypeOf(value) !== Array.prototype
        : ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      throw invalid();
    if (Object.getOwnPropertyDescriptor(value, 'toJSON')) throw invalid();
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > budget.nodes ||
      (array && (value.length > budget.nodes || keys.length !== value.length + 1))
    )
      throw invalid();
    active.add(value);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalid();
      if (array && key === 'length') continue;
      if (array && (typeof key === 'symbol' || !descriptor.enumerable)) throw invalid();
      if (typeof key === 'symbol' || !descriptor.enumerable) continue;
      if (array && !/^(0|[1-9]\d*)$/.test(key)) throw invalid();
      budget.bytes -= Buffer.byteLength(key);
      if (budget.bytes < 0) throw invalid();
      visit(descriptor.value, depth + 1, !array);
    }
    active.delete(value);
  }
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();
    visit(body, 0);
    if (!Array.isArray(own(body, 'messages'))) throw invalid();
    normalizeWorkBuddyToolHistory(body.messages, { repair: false });
    const bytes = Buffer.byteLength(JSON.stringify(body));
    if (bytes > MAX_BYTES) throw invalid();
    return { bytes, tokens: estimateTokensForValue(body) };
  } catch {
    throw invalid();
  }
}

function planNativeWorkBuddyContext(body, options, defaults = {}) {
  try {
    const bytesLimit = own(options, 'targetBodyBytes', defaults.targetBodyBytes);
    const tokenLimit = own(options, 'operationalInputTokens', defaults.operationalInputTokens);
    if (
      !Number.isSafeInteger(bytesLimit) ||
      bytesLimit < 1 ||
      bytesLimit > MAX_BYTES ||
      !Number.isSafeInteger(tokenLimit) ||
      tokenLimit < 1
    )
      throw invalid();
    const { bytes, tokens } = measureNativeWorkBuddyBody(body);
    const fits = bytes <= bytesLimit && tokens <= tokenLimit;
    return {
      body,
      fits,
      changed: false,
      diagnostics: {
        preflightApplied: false,
        nativeContextPreserved: true,
        reason: fits ? 'native_context_preserved' : 'native_context_too_large',
        originalBodyBytes: bytes,
        finalBodyBytes: bytes,
        originalEstimatedTokens: tokens,
        finalEstimatedTokens: tokens,
        hardBodyBytes: bytesLimit,
        operationalInputTokens: tokenLimit,
        droppedMessages: 0,
        foldedMessages: 0,
        artifactsStored: 0,
        continuationSummaryAdded: false,
      },
    };
  } catch {
    throw invalid();
  }
}

// Native mode still enforces retired call identity and the offered tool contract,
// without creating a recovery branch or consuming any private tool call.
function nativeWorkBuddyResponseAllowed(wire, body, maxBytes, retired = []) {
  const completion = parseBufferedChatCompletion(wire, body.stream === true, maxBytes);
  if (!completion) return false;
  const calls = completion.choices?.[0]?.message?.tool_calls;
  if (calls == null) return true;
  if (!Array.isArray(calls) || completion.choices.length !== 1) return false;
  if (
    calls.length &&
    (completion.choices[0].finish_reason !== 'tool_calls' ||
      completion.choices[0].message.role !== 'assistant' ||
      body.tool_choice === 'none')
  )
    return false;
  const old = new Set(retired);
  const digest = (id) => createHash('sha256').update(id).digest('hex');
  for (const message of body.messages)
    for (const call of message.tool_calls || []) old.add(digest(call.id));
  const offered = new Set((body.tools || []).map((tool) => tool.function?.name));
  const required = body.tool_choice?.function?.name || body.tool_choice?.name;
  for (const call of calls) {
    if (
      !call ||
      typeof call !== 'object' ||
      Array.isArray(call) ||
      typeof call.id !== 'string' ||
      !call.id.trim() ||
      call.id.length > 4096 ||
      [...call.id].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) ||
      call.type !== 'function' ||
      !offered.has(call.function?.name) ||
      (required && call.function?.name !== required) ||
      [CONTEXT_ARTIFACT_TOOL_NAME, TOOL_DISCOVERY_NAME].includes(call.function?.name) ||
      old.has(digest(call.id))
    )
      return false;
    try {
      if (typeof call.function.arguments !== 'string') return false;
      const args = JSON.parse(call.function.arguments);
      if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    } catch {
      return false;
    }
    old.add(digest(call.id));
  }
  return true;
}

module.exports = {
  planNativeWorkBuddyContext,
  measureNativeWorkBuddyBody,
  nativeWorkBuddyResponseAllowed,
};
