'use strict';

const {
  resolveGeminiOutputBudget,
  supportsCodeAssistOutputBudget,
} = require('../gemini-output-budget');
const RECOVERY = Symbol('geminiOutputRecovery');
const RECOVERY_WINDOW_MS = 180000;
const MIN_RETRY_WINDOW_MS = 15000;
const MAX_DEFERRED_BYTES = 64 * 1024;

function hasGeminiOutput(state) {
  return Boolean(
    state &&
    (state.hasVisibleText ||
      state.hasThinkingOutput ||
      state.hasToolUse ||
      state.textOpen ||
      state.thinkingOpen ||
      state.pendingToolCall ||
      state.outputRecoveryUnsafe)
  );
}

// Defer only initial metadata. Release as soon as any content is observed, including
// whitespace, thinking, or a pending tool call. Never replay an externally visible turn.
function createDeferredGeminiOutput(clientRes, headers) {
  let committed = false;
  let chunks = [];
  let bytes = 0;
  function commit() {
    if (committed) return;
    committed = true;
    if (clientRes.destroyed || clientRes.writableEnded) {
      chunks = [];
      return;
    }
    if (!clientRes.headersSent) clientRes.writeHead(200, headers);
    for (const chunk of chunks) clientRes.write(chunk);
    chunks = [];
  }
  return {
    sink: {
      write(chunk) {
        if (clientRes.destroyed || clientRes.writableEnded) return false;
        if (committed) return clientRes.write(chunk);
        const value = String(chunk);
        const size = Buffer.byteLength(value);
        if (bytes + size > MAX_DEFERRED_BYTES) {
          commit();
          return clientRes.write(value);
        }
        chunks.push(value);
        bytes += size;
        return true;
      },
    },
    commit,
    commitIfOutput(state) {
      if (hasGeminiOutput(state)) commit();
    },
    isCommitted: () => committed,
    discard() {
      chunks = [];
      bytes = 0;
    },
  };
}

function isEmptyGeminiBudgetResponse(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.error || payload.promptFeedback?.blockReason) return false;
  const candidates = payload.candidates;
  if (!Array.isArray(candidates) || candidates.length !== 1) return false;
  const candidate = candidates[0];
  if (!candidate || candidate.finishReason !== 'MAX_TOKENS') return false;
  if (
    candidate.content !== undefined &&
    (!candidate.content ||
      typeof candidate.content !== 'object' ||
      Array.isArray(candidate.content))
  )
    return false;
  const parts = candidate.content?.parts;
  return parts === undefined || (Array.isArray(parts) && parts.length === 0);
}

// The regular converter reads the first candidate and known part types. Recovery
// must also reject malformed, multiple-candidate, and unknown-content events.
function observeGeminiRecoveryEvent(event, state) {
  for (const line of String(event).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      state.outputRecoveryUnsafe = true;
      continue;
    }
    observeGeminiRecoveryPayload(payload, state);
  }
}

function observeGeminiRecoveryPayload(payload, state) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    state.outputRecoveryUnsafe = true;
    return;
  }
  if (payload.error || payload.promptFeedback?.blockReason) state.outputRecoveryUnsafe = true;
  if (payload.candidates === undefined) {
    if (payload.usageMetadata === undefined) state.outputRecoveryUnsafe = true;
    return;
  }
  if (!Array.isArray(payload.candidates) || payload.candidates.length > 1) {
    state.outputRecoveryUnsafe = true;
    return;
  }
  for (const candidate of payload.candidates) {
    const content = candidate?.content;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      (content !== undefined &&
        (!content || typeof content !== 'object' || Array.isArray(content))) ||
      (content?.parts !== undefined && (!Array.isArray(content.parts) || content.parts.length > 0))
    ) {
      state.outputRecoveryUnsafe = true;
    }
  }
}

function createGeminiOutputRecovery({
  clientReq,
  clientRes,
  prepared,
  model,
  codeAssist,
  requestedTokens,
  budget,
  startTime,
  logProxyEvent,
  retry,
  now = Date.now,
}) {
  const recovery = clientReq[RECOVERY];
  const options = {
    codeAssist,
    ...(supportsCodeAssistOutputBudget(model, codeAssist) ? { requestedTokens } : {}),
    recovery: Boolean(recovery),
  };
  return {
    options,
    remainingMs: recovery ? Math.max(0, startTime + RECOVERY_WINDOW_MS - now()) : null,
    retryEmpty({ stopReason, state, committed = false, usage, budget: currentBudget = budget }) {
      if (
        stopReason !== 'max_tokens' ||
        hasGeminiOutput(state) ||
        committed ||
        recovery ||
        clientReq[RECOVERY] ||
        clientReq.aborted ||
        clientRes.destroyed ||
        clientRes.writableEnded ||
        clientRes.headersSent ||
        !supportsCodeAssistOutputBudget(model, codeAssist) ||
        now() - startTime > RECOVERY_WINDOW_MS - MIN_RETRY_WINDOW_MS ||
        !currentBudget ||
        !(currentBudget.effectiveTokens >= 8192)
      )
        return false;
      const next = resolveGeminiOutputBudget({}, model, { ...options, recovery: true });
      clientReq[RECOVERY] = true;
      // Diagnostics contain counts only; never record prompts, response chunks, or errors.
      logProxyEvent('gemini_output_budget_recovery', {
        attempt: 1,
        previousMaxOutputTokens: currentBudget.effectiveTokens,
        nextMaxOutputTokens: next.effectiveTokens,
        raisedBudget: next.effectiveTokens > currentBudget.effectiveTokens,
        retainedThinkingLevel: true,
        discardedOutputTokens: Number.isSafeInteger(usage?.output_tokens) ? usage.output_tokens : 0,
        discardedReasoningTokens: Number.isSafeInteger(usage?.reasoning_tokens)
          ? usage.reasoning_tokens
          : 0,
      });
      retry(prepared);
      return true;
    },
  };
}

module.exports = {
  createDeferredGeminiOutput,
  createGeminiOutputRecovery,
  hasGeminiOutput,
  isEmptyGeminiBudgetResponse,
  observeGeminiRecoveryPayload,
  observeGeminiRecoveryEvent,
};
