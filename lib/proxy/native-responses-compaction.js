'use strict';

const { TextDecoder } = require('node:util');

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { isCodexResponsesTarget } = require('./responses-target');
const { isNativeOpenAIResponsesTarget } = require('./openai-context-management');

const MAX_NATIVE_COMPACTION_BYTES = 16 * 1024 * 1024;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function isResponsesCompactionPath(pathname) {
  if (typeof pathname !== 'string') return false;
  const path = pathname.split('?')[0];
  return path === '/v1/responses/compact' || path === '/responses/compact';
}

function failure(code, statusCode = 400) {
  const error = new TypeError(
    'Responses compaction requires a supported native target and valid bounded input'
  );
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function boundedData(value, maxBytes, code) {
  try {
    return normalizeCompactionData(value, maxBytes);
  } catch {
    throw failure(code);
  }
}

function isLocalState(value) {
  return (
    typeof value === 'string' &&
    (value.startsWith('hpm-local-compaction-') || value.startsWith('ccswitch-'))
  );
}

function normalizeNativeResponsesCompactionRequest(
  prepared,
  {
    target,
    method = 'POST',
    requestEncoding,
    maxBytes = MAX_NATIVE_COMPACTION_BYTES,
    originalBuffer = prepared?.buffer,
  } = {}
) {
  if (method !== 'POST') throw failure('invalid_request_error', 405);
  const profile = prepared?.profile;
  const native = !prepared?.authProvider || ['codex', 'openai'].includes(prepared.authProvider);
  const compatibleProtocol =
    profile && (!profile.protocol || ['openai', 'openai-responses'].includes(profile.protocol));
  if (
    !native ||
    !compatibleProtocol ||
    !(
      isCodexResponsesTarget(profile, target) ||
      isNativeOpenAIResponsesTarget(profile, target) ||
      profile.api === 'openai-responses' ||
      profile.protocol === 'openai-responses'
    )
  )
    throw failure('native_compaction_unsupported', 501);
  if (requestEncoding && requestEncoding !== 'identity') throw failure('invalid_request_error');
  if (
    !Buffer.isBuffer(prepared.buffer) ||
    !Buffer.isBuffer(originalBuffer) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  )
    throw failure('invalid_request_error');
  const limit = Math.min(maxBytes, MAX_NATIVE_COMPACTION_BYTES);
  if (prepared.buffer.length > limit || originalBuffer.length > limit)
    throw failure('native_compaction_too_large', 413);
  let body;
  try {
    // Model-route rewrites may already have replaced invalid UTF-8. Validate
    // original ingress bytes as well as the prepared canonical request.
    if (originalBuffer !== prepared.buffer)
      new TextDecoder('utf-8', { fatal: true }).decode(originalBuffer);
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(prepared.buffer));
  } catch {
    throw failure('invalid_request_error');
  }
  body = boundedData(body, limit, 'invalid_request_error');
  if (
    !record(body) ||
    typeof body.model !== 'string' ||
    !body.model.trim() ||
    body.model.length > 256 ||
    [...body.model].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    throw failure('invalid_request_error');
  if (typeof body.input !== 'string' && !Array.isArray(body.input))
    throw failure('invalid_request_error');
  if (
    (typeof body.input === 'string' && !body.input.trim()) ||
    (Array.isArray(body.input) && (body.input.length === 0 || !body.input.every(record)))
  )
    throw failure('invalid_request_error');
  if (body.instructions != null && typeof body.instructions !== 'string')
    throw failure('invalid_request_error');
  // Standalone compaction is not a generation request. Never silently turn a
  // requested stream/stateful continuation into a different operation.
  if (
    (body.stream != null && body.stream !== false) ||
    (body.store != null && body.store !== false) ||
    body.context_management != null ||
    body.previous_response_id != null ||
    body.conversation != null
  )
    throw failure('invalid_request_error');
  if (
    Array.isArray(body.input) &&
    body.input.some(
      (item) => item.type === 'compaction_trigger' || isLocalState(item.encrypted_content)
    )
  )
    throw failure('invalid_request_error');
  // These are accepted only as compatibility no-ops, not sent to compact.
  delete body.stream;
  delete body.store;
  if (body.previous_response_id === null) delete body.previous_response_id;
  return { ...prepared, buffer: Buffer.from(JSON.stringify(body)), bodyChanged: true };
}

function assertNativeCompactionResponse(value, maxBytes = MAX_NATIVE_COMPACTION_BYTES) {
  const body = boundedData(
    value,
    Math.min(maxBytes, MAX_NATIVE_COMPACTION_BYTES),
    'upstream_invalid_compaction'
  );
  if (
    !record(body) ||
    body.object !== 'response.compaction' ||
    typeof body.id !== 'string' ||
    !body.id.trim() ||
    body.id.length > 256 ||
    !Number.isSafeInteger(body.created_at) ||
    body.created_at < 0 ||
    (body.status != null && body.status !== 'completed') ||
    body.error != null ||
    !Array.isArray(body.output) ||
    !body.output.every(record) ||
    !record(body.usage) ||
    !['input_tokens', 'output_tokens', 'total_tokens'].every(
      (key) => Number.isSafeInteger(body.usage[key]) && body.usage[key] >= 0
    )
  )
    throw failure('upstream_invalid_compaction');
  const checkpoints = body.output.filter((item) => item.type === 'compaction');
  if (
    checkpoints.length !== 1 ||
    typeof checkpoints[0].encrypted_content !== 'string' ||
    !checkpoints[0].encrypted_content.trim() ||
    isLocalState(checkpoints[0].encrypted_content) ||
    body.output.some((item) => item.type === 'compaction_trigger')
  )
    throw failure('upstream_invalid_compaction');
  // Validation is deliberately non-destructive. The caller forwards the exact
  // original bytes, including all retained items and unknown provider fields.
  return value;
}

module.exports = {
  MAX_NATIVE_COMPACTION_BYTES,
  isResponsesCompactionPath,
  normalizeNativeResponsesCompactionRequest,
  assertNativeCompactionResponse,
};
