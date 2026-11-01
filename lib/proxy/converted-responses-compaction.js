'use strict';

const { TextDecoder } = require('node:util');
const { normalizeCompactionData } = require('./context-compaction-envelope');
const { isCodexResponsesTarget } = require('./responses-target');
const { isNativeOpenAIResponsesTarget } = require('./openai-context-management');
const { isWorkBuddyTarget } = require('./workbuddy-request-contract');
const { cacheParsedJsonBodyBuffer } = require('./request-utils');
const { compactionResponseEvents } = require('./workbuddy-compaction-bridge');
const {
  HPM_COMPACTION_PREFIX,
  MAGPIE_COMPACTION_PREFIX,
  hasTianxiCompactionTrigger,
  expandTianxiCompactionInput,
  selectTianxiCompactionWindow,
  buildLocalDeterministicSummary,
  buildTianxiCompactionResponse,
} = require('./tianxi-compaction');

const MAX_CONVERTED_COMPACTION_BYTES = 2 * 1024 * 1024;
const ALLOWED_STANDALONE_FIELDS = new Set([
  'model',
  'input',
  'instructions',
  'stream',
  'store',
  'previous_response_id',
]);

function failure(code = 'invalid_request_error', statusCode = 400) {
  const error = new TypeError(
    'Converted Responses compaction requires a bounded full history and supported controls'
  );
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function isConvertedResponsesCompactionEnabled(prepared, protocolOptions = {}, target = null) {
  const profile = prepared?.profile;
  if (!profile || typeof profile !== 'object') return false;
  if (
    isWorkBuddyTarget(prepared) ||
    profile.protocol === 'tianxi' ||
    profile.protocol === 'trae' ||
    isCodexResponsesTarget(profile, target) ||
    isNativeOpenAIResponsesTarget(profile, target) ||
    profile.api === 'openai-codex-responses' ||
    profile.api === 'openai-responses' ||
    profile.protocol === 'openai-responses'
  ) {
    return false;
  }
  if (profile.localCompactionEnabled === false) return false;
  return (
    profile.localCompactionEnabled === true ||
    protocolOptions?.convertedResponsesCompactionPolicy === 'auto'
  );
}

function normalizeConvertedResponsesCompactionRequest(
  prepared,
  {
    target,
    method = 'POST',
    requestEncoding,
    originalBuffer = prepared?.buffer,
    maxBytes = MAX_CONVERTED_COMPACTION_BYTES,
    protocolOptions = {},
  } = {}
) {
  if (method !== 'POST') throw failure('invalid_request_error', 405);
  if (!isConvertedResponsesCompactionEnabled(prepared, protocolOptions, target)) {
    throw failure('native_compaction_unsupported', 501);
  }
  if (requestEncoding && requestEncoding !== 'identity') throw failure();
  if (
    !Buffer.isBuffer(prepared?.buffer) ||
    !Buffer.isBuffer(originalBuffer) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  ) {
    throw failure();
  }
  const limit = Math.min(maxBytes, MAX_CONVERTED_COMPACTION_BYTES);
  if (prepared.buffer.length > limit || originalBuffer.length > limit) {
    throw failure('compaction_source_too_large', 413);
  }
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
  ) {
    throw failure();
  }
  if (Object.keys(body).some((key) => !ALLOWED_STANDALONE_FIELDS.has(key))) {
    throw failure('unsupported_compaction_option');
  }
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
  ) {
    throw failure();
  }
  if (
    (body.instructions !== undefined && typeof body.instructions !== 'string') ||
    (body.stream !== undefined && body.stream !== false) ||
    (body.store !== undefined && body.store !== false) ||
    body.previous_response_id != null
  ) {
    throw failure();
  }
  delete body.stream;
  delete body.store;
  delete body.previous_response_id;
  body.input.push({ type: 'compaction_trigger' });
  const buffer = Buffer.from(JSON.stringify(body));
  if (buffer.length > limit) throw failure('compaction_source_too_large', 413);
  cacheParsedJsonBodyBuffer(buffer, body);
  return {
    ...prepared,
    buffer,
    bodyChanged: true,
    convertedStandaloneCompaction: true,
    convertedResponsesStandaloneCompaction: true,
  };
}

function hasPortableCompactionItems(input) {
  return (
    Array.isArray(input) &&
    input.some(
      (item) =>
        item &&
        typeof item === 'object' &&
        (item.type === 'compaction' || item.type === 'compaction_summary') &&
        typeof item.encrypted_content === 'string' &&
        (item.encrypted_content.trim().startsWith(HPM_COMPACTION_PREFIX) ||
          item.encrypted_content.trim().startsWith(MAGPIE_COMPACTION_PREFIX))
    )
  );
}

function tryHandleConvertedResponsesCompaction(arg1, arg2, arg3, arg4 = {}) {
  const singleObjectCall =
    arg1 &&
    typeof arg1 === 'object' &&
    arg2 === undefined &&
    ('prepared' in arg1 || 'clientReq' in arg1 || 'clientRes' in arg1);
  const clientReq = singleObjectCall ? arg1.clientReq : arg1;
  const clientRes = singleObjectCall ? arg1.clientRes : arg2;
  const prepared = singleObjectCall ? arg1.prepared : arg3;
  const {
    target,
    upstreamPath,
    startTime,
    logRequestEnd,
    sendJsonError,
    CORS_HEADERS = { 'access-control-allow-origin': '*' },
    protocolOptions = {},
  } = singleObjectCall ? arg1 : arg4 || {};
  const finish = (handled, nextPrepared = prepared) =>
    singleObjectCall ? handled : { handled, prepared: nextPrepared };

  if (isWorkBuddyTarget(prepared)) return finish(false, prepared);
  if (!Buffer.isBuffer(prepared?.buffer)) return finish(false, prepared);
  let body;
  try {
    body = JSON.parse(prepared.buffer.toString('utf8'));
  } catch {
    return finish(false, prepared);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.input)) {
    return finish(false, prepared);
  }

  const standalone =
    prepared.convertedStandaloneCompaction === true ||
    prepared.convertedResponsesStandaloneCompaction === true;
  const hasTrigger = hasTianxiCompactionTrigger(body.input);
  const hasPortableItems = hasPortableCompactionItems(body.input);
  const enabled = isConvertedResponsesCompactionEnabled(prepared, protocolOptions, target);

  if (!standalone && !hasTrigger && !hasPortableItems) {
    return finish(false, prepared);
  }
  if (!enabled && !hasPortableItems) {
    return finish(false, prepared);
  }

  if (standalone || (enabled && hasTrigger)) {
    try {
      const expanded = expandTianxiCompactionInput(body.input, { replayRetainedItems: true });
      const windowPlan = selectTianxiCompactionWindow(expanded);
      const summaryText = buildLocalDeterministicSummary({
        input: expanded,
        instructions: body.instructions,
      });
      const model =
        prepared.rewriteTo && prepared.rewriteTo !== '-'
          ? prepared.rewriteTo
          : body.model || 'gpt-4o';
      const response = buildTianxiCompactionResponse(model, summaryText, {
        standalone,
        inputText: JSON.stringify(expanded),
        retainedItems: windowPlan.retainedItems,
      });
      if (!standalone && body.stream === true) {
        const sseWire = compactionResponseEvents(response);
        clientRes.writeHead(200, {
          ...CORS_HEADERS,
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        clientRes.end(sseWire);
      } else {
        const jsonWire = JSON.stringify(response);
        clientRes.writeHead(200, {
          ...CORS_HEADERS,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(jsonWire),
        });
        clientRes.end(jsonWire);
      }
      if (typeof logRequestEnd === 'function') {
        logRequestEnd(clientReq?.method || 'POST', upstreamPath, startTime, 200, {
          type: 'converted_local_compaction',
          standalone,
        });
      }
    } catch (err) {
      const code = err?.code || err?.message || 'invalid_local_compaction';
      if (typeof sendJsonError === 'function') {
        sendJsonError(clientRes, 400, {
          error: {
            type: 'invalid_request_error',
            code,
            message: 'Local compaction input is invalid or unsupported.',
          },
        });
      }
      if (typeof logRequestEnd === 'function') {
        logRequestEnd(clientReq?.method || 'POST', upstreamPath, startTime, 400, {
          type: 'converted_local_compaction_invalid',
          errorCode: code,
        });
      }
    }
    return finish(true, prepared);
  }

  if (hasPortableItems) {
    try {
      const expandedInput = expandTianxiCompactionInput(body.input, {
        replayRetainedItems: true,
      });
      const nextBody = { ...body, input: expandedInput };
      const nextBuffer = Buffer.from(JSON.stringify(nextBody));
      cacheParsedJsonBodyBuffer(nextBuffer, nextBody);
      prepared.buffer = nextBuffer;
      prepared.bodyChanged = true;
      if (clientReq && clientReq.headers && typeof clientReq.headers === 'object') {
        delete clientReq.headers['content-encoding'];
        clientReq.headers['content-length'] = String(nextBuffer.length);
      }
      return finish(false, {
        ...prepared,
        buffer: nextBuffer,
        bodyChanged: true,
      });
    } catch (err) {
      const code = err?.code || err?.message || 'invalid_local_compaction';
      if (typeof sendJsonError === 'function') {
        sendJsonError(clientRes, 400, {
          error: {
            type: 'invalid_request_error',
            code,
            message: 'Local compaction checkpoint could not be decoded.',
          },
        });
      }
      if (typeof logRequestEnd === 'function') {
        logRequestEnd(clientReq?.method || 'POST', upstreamPath, startTime, 400, {
          type: 'converted_local_compaction_invalid',
          errorCode: code,
        });
      }
      return finish(true, prepared);
    }
  }

  return finish(false, prepared);
}

module.exports = {
  MAX_CONVERTED_COMPACTION_BYTES,
  isConvertedResponsesCompactionEnabled,
  normalizeConvertedResponsesCompactionRequest,
  hasPortableCompactionItems,
  tryHandleConvertedResponsesCompaction,
};
