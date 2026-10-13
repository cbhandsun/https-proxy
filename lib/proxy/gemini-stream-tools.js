'use strict';

function mergeGeminiToolArgs(current, next) {
  if (!next || typeof next !== 'object') return current || {};
  return { ...(current || {}), ...next };
}

// Gemini streams one logical functionCall across several parts: the first part
// carries the name, and later continuation parts carry only additional args (and
// sometimes the id). Those continuation parts must merge into the pending call.
//
// Two parts that both name a tool are separate calls — the old name-equality check
// merged them, so two parallel `Bash` calls collapsed into the last one and the
// earlier invocation was silently dropped. Only ambiguous repeats (same name, same
// id-less args, separate events) still merge to keep Gemini's arg accumulation
// working.
function argsConflictValue(currentValue, nextValue) {
  if (currentValue === nextValue) return false;
  // Gemini sends complete functionCall args, but a streaming provider may append a
  // string value in pieces. A prefix relationship is accumulation, not a new call.
  if (typeof currentValue === 'string' && typeof nextValue === 'string') {
    return !(currentValue.startsWith(nextValue) || nextValue.startsWith(currentValue));
  }
  return true;
}

function hasConflictingToolArgs(current, next) {
  if (!current || typeof current !== 'object' || !next || typeof next !== 'object') {
    return false;
  }
  for (const key of Object.keys(next)) {
    if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
    if (argsConflictValue(current[key], next[key])) return true;
  }
  return false;
}

function shouldFlushPendingGeminiToolCall(pending, call, incomingArgs) {
  if (!pending || !pending.name) return false;
  if (call && call.id && pending.id && String(call.id) !== String(pending.id)) return true;
  // A continuation part omits both name and id; it belongs to the pending call.
  if (!call || (!call.name && !call.id)) return false;
  if (!call.name) return false;
  if (String(call.name) !== String(pending.name)) return true;
  return hasConflictingToolArgs(pending.args, incomingArgs);
}

module.exports = { mergeGeminiToolArgs, shouldFlushPendingGeminiToolCall };
