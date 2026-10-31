'use strict';

const { types } = require('node:util');
const { normalizeCompactionData } = require('./context-compaction-envelope');
const { estimateTokensForValue } = require('./inline-media');
const { validateCheckpointMessages } = require('./context-checkpoint');

const MAX_MESSAGES = 16384;
const MAX_MEASUREMENT_BYTES = 16 * 1024 * 1024;
const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool', 'function']);
const CHECKPOINT_PREFIX = '[HPM_CONTEXT_CHECKPOINT_V1]\n';
const frozenRequiredContextCache = new WeakMap();

function isDeeplyFrozen(value) {
  if (!value || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (!isDeeplyFrozen(value[i])) return false;
    }
    return true;
  }
  for (const key of Object.keys(value)) {
    if (!isDeeplyFrozen(value[key])) return false;
  }
  return true;
}

function dataProperty(value, key) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (![Object.prototype, null, Array.prototype].includes(prototype)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function resultOnlyUser(message) {
  return (
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every(
      (part) =>
        part &&
        typeof part === 'object' &&
        (part.type === 'tool_result' ||
          (part.functionResponse &&
            typeof part.functionResponse === 'object' &&
            !Array.isArray(part.functionResponse)))
    )
  );
}

function recomposableUserCheckpoint(message) {
  // The existing eviction planner may rebuild a validated legacy checkpoint.
  // Excluding it makes this lower bound conservative, not an admission or a new
  // provenance capability. Arbitrary marker text remains ordinary user input.
  return (
    message.role === 'user' &&
    typeof message.content === 'string' &&
    message.content.startsWith(CHECKPOINT_PREFIX) &&
    message.content.length <= 64 * 1024 &&
    validateCheckpointMessages([message], 64 * 1024)
  );
}

// A conservative lower bound, not a fitting candidate. Main-request planning
// and narration summaries preserve policy and original user inputs unchanged.
// Result-only user exchanges may be archived, so they are not part of this
// invariant. Tools, controls, checkpoints and remaining exchanges are excluded:
// a bound that fits proves nothing; a measured bound that exceeds a hard ceiling
// proves that more evidence/narration cleanup cannot admit this request.
function measureWorkBuddyRequiredContext(messages) {
  const unavailable = { requiredContextMeasured: false };
  const length = dataProperty(messages, 'length');
  if (
    types.isProxy(messages) ||
    !Array.isArray(messages) ||
    Object.getPrototypeOf(messages) !== Array.prototype ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_MESSAGES
  )
    return unavailable;
  if (Object.isFrozen(messages) && frozenRequiredContextCache.has(messages)) {
    return frozenRequiredContextCache.get(messages);
  }
  const selected = [];
  for (let index = 0; index < length; index += 1) {
    const message = dataProperty(messages, String(index));
    const role = dataProperty(message, 'role');
    if (!ROLES.has(role)) return unavailable;
    if (['system', 'developer', 'user'].includes(role)) selected.push(message);
  }
  let safe;
  try {
    // Reuse the data-only boundary validator: no getters, toJSON, coercion,
    // custom prototypes, sparse arrays, cycles or unbounded traversal. Do not
    // truncate a failed measurement and report it as a complete lower bound.
    safe = normalizeCompactionData(selected, MAX_MEASUREMENT_BYTES);
  } catch (error) {
    if (error?.code !== 'invalid_local_compaction') throw error;
    return unavailable;
  }
  const required = safe.filter(
    (message) => !resultOnlyUser(message) && !recomposableUserCheckpoint(message)
  );
  const policy = required.filter((message) => ['system', 'developer'].includes(message.role));
  const users = required.filter((message) => message.role === 'user');
  const messageBytes = (entries) =>
    entries.reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message)), 0);
  const policyBytes = messageBytes(policy);
  const userBytes = messageBytes(users);
  const result = {
    requiredContextMeasured: true,
    requiredContextMessageBytes:
      2 + policyBytes + userBytes + Math.max(0, required.length - 1),
    requiredContextEstimatedTokens: estimateTokensForValue(required),
    requiredPolicyMessageCount: policy.length,
    requiredPolicyMessageBytes: policyBytes,
    requiredUserMessageCount: users.length,
    requiredUserMessageBytes: userBytes,
  };
  if (Object.isFrozen(messages) && isDeeplyFrozen(messages)) {
    frozenRequiredContextCache.set(messages, result);
  }
  return result;
}

module.exports = { measureWorkBuddyRequiredContext };
