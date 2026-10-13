'use strict';

const { isCodexResponsesTarget } = require('./responses-request-options');
const codexStreaming = Symbol('normalizedCodexResponsesStreaming');
const codexCompactionState = Symbol('normalizedCodexCompactionState');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalidRequest(param) {
  const messages = {
    previous_response_id:
      'Codex Responses does not support previous_response_id; send full input history',
    context_management:
      'Codex official-login does not support the OpenAI API context_management option; use Codex client compaction',
  };
  const error = new TypeError(
    messages[param] || 'Codex Responses requires valid JSON input/options and store:false'
  );
  error.code = 'invalid_request_error';
  if (messages[param]) error.param = param;
  throw error;
}

function normalizeCodexResponsesRequest(
  prepared,
  { target, isResponsesRequest, requestEncoding } = {}
) {
  if (!isResponsesRequest || !isCodexResponsesTarget(prepared?.profile, target)) return prepared;
  if (requestEncoding && requestEncoding !== 'identity') invalidRequest();
  if (!Buffer.isBuffer(prepared?.buffer)) invalidRequest();
  let body;
  try {
    body = JSON.parse(prepared.buffer.toString('utf8'));
  } catch {
    invalidRequest();
  }
  if (!record(body)) invalidRequest();
  if (body.previous_response_id != null) invalidRequest('previous_response_id');
  if (body.context_management != null) invalidRequest('context_management');
  if (body.store != null && body.store !== false) invalidRequest();
  if (body.stream != null && typeof body.stream !== 'boolean') invalidRequest();
  if (body.instructions != null && typeof body.instructions !== 'string') invalidRequest();
  if (body.input != null && typeof body.input !== 'string' && !Array.isArray(body.input))
    invalidRequest();
  if (Array.isArray(body.input) && !body.input.every(record)) invalidRequest();
  if (
    body.max_output_tokens != null &&
    (!Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens <= 0)
  )
    invalidRequest();
  const normalized = {
    ...body,
    input:
      typeof body.input === 'string'
        ? [{ role: 'user', content: [{ type: 'input_text', text: body.input }] }]
        : (body.input ?? []),
    instructions: body.instructions ?? '',
    stream: true,
    store: false,
  };
  if (body.previous_response_id === null) delete normalized.previous_response_id;
  return {
    ...prepared,
    buffer: Buffer.from(JSON.stringify(normalized)),
    bodyChanged: true,
    forcedResponseStreaming: prepared.forcedResponseStreaming === true || body.stream !== true,
    [codexStreaming]: true,
    [codexCompactionState]: normalized.input.some(
      (item) => item.type === 'compaction' || item.type === 'compaction_trigger'
    ),
  };
}

// Opaque native context belongs to its issuing backend. A transport failure
// must not resend it to an unrelated backup profile. Only validated Codex
// normalization can set this marker; JSON/request properties cannot spoof it.
function hasCodexCompactionState(prepared) {
  return prepared?.[codexCompactionState] === true;
}

function isCodexStreamResponse(prepared, statusCode, headers) {
  if (
    prepared?.[codexStreaming] !== true ||
    !Number.isInteger(statusCode) ||
    statusCode < 200 ||
    statusCode >= 300
  )
    return false;
  const type = headers?.['content-type'];
  return (
    type == null ||
    type === '' ||
    (typeof type === 'string' && /^text\/event-stream(?:\s*;|$)/i.test(type))
  );
}

module.exports = { normalizeCodexResponsesRequest, isCodexStreamResponse, hasCodexCompactionState };
