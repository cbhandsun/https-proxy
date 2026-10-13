'use strict';

const { TextDecoder } = require('node:util');
const { normalizeCompactionData } = require('./context-compaction-envelope');
const { isWorkBuddyTarget } = require('./workbuddy-request-contract');

const MAX_WORKBUDDY_COMPACTION_BYTES = 2 * 1024 * 1024;
const fields = new Set([
  'model',
  'input',
  'instructions',
  'stream',
  'store',
  'previous_response_id',
]);
function failure(code = 'invalid_request_error', statusCode = 400) {
  const error = new TypeError(
    'WorkBuddy standalone compaction requires a bounded full history and supported controls'
  );
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeWorkBuddyStandaloneCompactionRequest(
  prepared,
  {
    method = 'POST',
    requestEncoding,
    originalBuffer = prepared?.buffer,
    maxBytes = MAX_WORKBUDDY_COMPACTION_BYTES,
    apiKey,
  } = {}
) {
  if (method !== 'POST') throw failure('invalid_request_error', 405);
  if (!isWorkBuddyTarget(prepared) || apiKey || !prepared.workbuddyAuth?.accessTokenEncrypted)
    throw failure('workbuddy_compaction_unsupported', 501);
  if (requestEncoding && requestEncoding !== 'identity') throw failure();
  if (
    !Buffer.isBuffer(prepared.buffer) ||
    !Buffer.isBuffer(originalBuffer) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  )
    throw failure();
  const limit = Math.min(maxBytes, MAX_WORKBUDDY_COMPACTION_BYTES);
  if (prepared.buffer.length > limit || originalBuffer.length > limit)
    throw failure('compaction_source_too_large', 413);
  let body;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    if (originalBuffer !== prepared.buffer) decoder.decode(originalBuffer);
    body = normalizeCompactionData(JSON.parse(decoder.decode(prepared.buffer)), limit);
  } catch {
    throw failure();
  }
  if (
    !body ||
    Array.isArray(body) ||
    typeof body !== 'object' ||
    typeof body.model !== 'string' ||
    !body.model.trim() ||
    body.model.trim() !== body.model ||
    body.model.length > 256 ||
    [...body.model].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw failure();
  if (Object.keys(body).some((key) => !fields.has(key)))
    throw failure('unsupported_compaction_option');
  if (typeof body.input === 'string') {
    if (!body.input.trim()) throw failure();
    body.input = [{ type: 'message', role: 'user', content: body.input }];
  }
  if (
    !Array.isArray(body.input) ||
    !body.input.length ||
    body.input.length > 2048 ||
    body.input.some(
      (item) =>
        !item ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        item.type === 'compaction_trigger'
    )
  )
    throw failure();
  if (
    (body.instructions !== undefined && typeof body.instructions !== 'string') ||
    (body.stream !== undefined && body.stream !== false) ||
    (body.store !== undefined && body.store !== false) ||
    body.previous_response_id != null
  )
    throw failure();
  delete body.stream;
  delete body.store;
  delete body.previous_response_id;
  body.input.push({ type: 'compaction_trigger' });
  const buffer = Buffer.from(JSON.stringify(body));
  if (buffer.length > limit) throw failure('compaction_source_too_large', 413);
  return { ...prepared, buffer, bodyChanged: true, workbuddyStandaloneCompaction: true };
}

module.exports = { MAX_WORKBUDDY_COMPACTION_BYTES, normalizeWorkBuddyStandaloneCompactionRequest };
