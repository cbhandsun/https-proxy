'use strict';

const { createHash } = require('node:crypto');
const { normalizeCompactionData } = require('../proxy/context-compaction-envelope');

const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const RECOVERABLE_CODES = new Set([
  'invalid_local_compaction',
  'compaction_evidence_unavailable',
  'compaction_requires_full_history',
  'local_compaction_closed',
  'local_compaction_clock_invalid',
]);

function recoveryError(code = 'invalid_client_recovery') {
  const error = new Error(
    'Client context recovery refused; original history or request is unavailable or invalid'
  );
  error.code = code;
  return error;
}

function safeData(value, maxBytes = MAX_HISTORY_BYTES) {
  try {
    return normalizeCompactionData(value, maxBytes);
  } catch {
    throw recoveryError();
  }
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function identity(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    ![...value].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127
    )
  );
}

function validContent(content) {
  if (typeof content === 'string') return true;
  return (
    Array.isArray(content) &&
    content.every((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return false;
      if (['input_text', 'output_text', 'text'].includes(part.type))
        return typeof part.text === 'string';
      if (part.type === 'refusal') return typeof part.refusal === 'string';
      if (part.type === 'input_image')
        return typeof part.image_url === 'string' || typeof part.file_id === 'string';
      if (part.type === 'input_file')
        return ['file_id', 'file_url', 'file_data'].some((key) => typeof part[key] === 'string');
      return false;
    })
  );
}

function validateOriginal(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 2048)
    throw recoveryError('original_history_unavailable');
  const calls = new Map();
  const resolved = new Set();
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw recoveryError();
    if (item.type === undefined || item.type === 'message') {
      if (
        !['system', 'developer', 'user', 'assistant'].includes(item.role) ||
        !validContent(item.content) ||
        item.tool_calls !== undefined ||
        (item.role === 'assistant' &&
          (typeof item.content === 'string'
            ? [item.content]
            : item.content.map((part) => part.text ?? '')
          ).some((text) => text.startsWith('[HPM_LOCAL_COMPACTION_SUMMARY_V1]')))
      )
        throw recoveryError();
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      if (
        !identity(item.call_id) ||
        !identity(item.name) ||
        calls.has(item.call_id) ||
        typeof (item.type === 'function_call' ? item.arguments : item.input) !== 'string'
      )
        throw recoveryError('invalid_original_tool_pairs');
      if (item.type === 'function_call') {
        let args;
        try {
          args = JSON.parse(item.arguments);
        } catch {
          throw recoveryError('invalid_original_tool_pairs');
        }
        if (!args || typeof args !== 'object' || Array.isArray(args))
          throw recoveryError('invalid_original_tool_pairs');
      }
      calls.set(item.call_id, item.type);
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      const expected = item.type === 'function_call_output' ? 'function_call' : 'custom_tool_call';
      if (
        !identity(item.call_id) ||
        calls.get(item.call_id) !== expected ||
        resolved.has(item.call_id) ||
        !validContent(item.output)
      )
        throw recoveryError('invalid_original_tool_pairs');
      resolved.add(item.call_id);
    } else {
      // Opaque compaction, summaries and unsupported native tool types are not originals.
      throw recoveryError('unsupported_original_history');
    }
  }
  if (resolved.size !== calls.size) throw recoveryError('invalid_original_tool_pairs');
}

function validateRetainedInput(request, original) {
  if (!Array.isArray(request.input)) throw recoveryError();
  let cursor = 0;
  for (const item of request.input) {
    if (item?.type === 'compaction') {
      if (
        typeof item.encrypted_content !== 'string' ||
        !/^hpm-local-compaction-v[12]:/.test(item.encrypted_content)
      )
        throw recoveryError('foreign_compaction_state');
      continue;
    }
    const digest = fingerprint(item);
    while (cursor < original.length && fingerprint(original[cursor]) !== digest) cursor++;
    if (cursor === original.length) throw recoveryError('original_history_mismatch');
    cursor++;
  }
}

function isRecoveryFailure(status, payload) {
  const error = payload?.error;
  return (
    RECOVERABLE_CODES.has(error?.code) &&
    status === (error.code === 'compaction_evidence_unavailable' ? 502 : 400) &&
    error.type === (status === 502 ? 'api_error' : 'invalid_request_error') &&
    error.recovery?.action === 'resend_full_history' &&
    error.recovery.replay_external_tools === false
  );
}

module.exports = {
  MAX_HISTORY_BYTES,
  recoveryError,
  safeData,
  fingerprint,
  identity,
  validateOriginal,
  validateRetainedInput,
  isRecoveryFailure,
};
