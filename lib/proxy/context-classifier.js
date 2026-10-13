'use strict';

const { isToolResponseMessage } = require('./context-optimizer');
const CHECKPOINT_MARKER = '[HPM_CONTEXT_CHECKPOINT_V1]';

const CONTEXT_CLASSES = Object.freeze({
  IMMUTABLE_POLICY: 'immutable_policy',
  DURABLE_STATE: 'durable_state',
  RECENT_WORKING_SET: 'recent_working_set',
  EVICTABLE_EVIDENCE: 'evictable_evidence',
});

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function toolCallIds(message) {
  if (!message || typeof message !== 'object') return [];
  const ids = [];
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (call && typeof call.id === 'string' && call.id) ids.push(call.id);
  }
  for (const part of Array.isArray(message.content) ? message.content : []) {
    if (part && part.type === 'tool_use' && typeof part.id === 'string' && part.id) {
      ids.push(part.id);
    }
    const functionCall = part && part.functionCall;
    if (functionCall && typeof functionCall === 'object') {
      if (typeof functionCall.id === 'string' && functionCall.id) ids.push(functionCall.id);
      else if (typeof functionCall.name === 'string' && functionCall.name) {
        ids.push(`gemini-name:${functionCall.name}`);
      }
    }
  }
  return ids;
}

function toolResultIds(message) {
  if (!message || typeof message !== 'object') return [];
  const ids = [];
  if (typeof message.tool_call_id === 'string' && message.tool_call_id) {
    ids.push(message.tool_call_id);
  }
  for (const id of Array.isArray(message.tool_result_ids) ? message.tool_result_ids : []) {
    if (typeof id === 'string' && id) ids.push(id);
  }
  for (const part of Array.isArray(message.content) ? message.content : []) {
    if (part && part.type === 'tool_result' && typeof part.tool_use_id === 'string') {
      ids.push(part.tool_use_id);
    }
    const functionResponse = part && part.functionResponse;
    if (functionResponse && typeof functionResponse === 'object') {
      if (typeof functionResponse.id === 'string' && functionResponse.id) {
        ids.push(functionResponse.id);
      } else if (typeof functionResponse.name === 'string' && functionResponse.name) {
        ids.push(`gemini-name:${functionResponse.name}`);
      }
    }
  }
  return ids;
}

function recentUserCutoff(messages, keepRecentUserTurns) {
  let userTurns = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === 'user' && !isToolResponseMessage(message)) {
      userTurns += 1;
      if (userTurns >= keepRecentUserTurns) return index;
    }
  }
  return 0;
}

function classifyContextMessages(messages, options = {}) {
  if (!Array.isArray(messages)) return { items: [], counts: {}, recentCutoffIndex: 0 };
  const keepRecentUserTurns = positiveInteger(options.keepRecentUserTurns, 2);
  const recentCutoffIndex = recentUserCutoff(messages, keepRecentUserTurns);
  const resultIds = new Set(messages.flatMap(toolResultIds));
  const unresolvedCallIds = new Set(
    messages.flatMap(toolCallIds).filter((id) => !resultIds.has(id))
  );
  const counts = {};
  const items = messages.map((message, index) => {
    const role = message && typeof message.role === 'string' ? message.role : 'unknown';
    const calls = toolCallIds(message);
    let contextClass;
    let reason;
    if (role === 'system' || role === 'developer') {
      contextClass = CONTEXT_CLASSES.IMMUTABLE_POLICY;
      reason = 'trusted_policy_role';
    } else if (
      typeof message?.content === 'string' &&
      message.content.startsWith(`${CHECKPOINT_MARKER}\n`)
    ) {
      contextClass = CONTEXT_CLASSES.RECENT_WORKING_SET;
      reason = 'context_checkpoint';
    } else if (index >= recentCutoffIndex || calls.some((id) => unresolvedCallIds.has(id))) {
      contextClass = CONTEXT_CLASSES.RECENT_WORKING_SET;
      reason = calls.some((id) => unresolvedCallIds.has(id))
        ? 'unresolved_tool_call'
        : 'recent_user_window';
    } else if (isToolResponseMessage(message)) {
      contextClass = CONTEXT_CLASSES.EVICTABLE_EVIDENCE;
      reason = 'consumed_historical_tool_result';
    } else {
      contextClass = CONTEXT_CLASSES.DURABLE_STATE;
      reason = role === 'user' ? 'historical_user_context' : 'historical_agent_state';
    }
    counts[contextClass] = (counts[contextClass] || 0) + 1;
    return { index, message, contextClass, reason };
  });
  return { items, counts, recentCutoffIndex, unresolvedCallIds: [...unresolvedCallIds] };
}

module.exports = {
  CONTEXT_CLASSES,
  classifyContextMessages,
  toolCallIds,
  toolResultIds,
};
