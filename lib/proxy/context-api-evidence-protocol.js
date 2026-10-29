'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { normalizeRecoveryRequestBody } = require('./context-recovery-request-data');
const { parseCompletedEvidenceSource } = require('./context-evidence-source');
const {
  createChatCompletionCollector,
  createResponsesCollector,
  createSseJsonDecoder,
} = require('./forced-stream-collector');

const MAX_WIRE_BYTES = 2 * 1024 * 1024;
const MAX_CALLS = 128;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);

function apiEvidenceKind(path) {
  if (typeof path !== 'string') return null;
  const kinds = {
    '/v1/chat/completions': 'chat',
    '/v1/responses': 'responses',
    '/v1/messages': 'claude',
  };
  const pathname = path.split('?')[0];
  return Object.hasOwn(kinds, pathname) ? kinds[pathname] : null;
}

// Only results associated with calls independently observed on this proxy are
// eligible. Parsing input history does not authenticate execution or create calls.
function parseApiEvidenceResults(kind, input, historyFormat = 2) {
  const body =
    historyFormat === 2
      ? normalizeCompactionData(input, MAX_WIRE_BYTES)
      : normalizeRecoveryRequestBody(kind, input, historyFormat);
  if (!record(body)) throw new TypeError('invalid_api_evidence_input');
  const results = [];
  if (kind === 'chat' && Array.isArray(body.messages)) {
    for (const item of body.messages)
      if (item?.role === 'tool') results.push({ callId: item.tool_call_id, output: item.content });
  } else if (kind === 'responses' && Array.isArray(body.input)) {
    for (const item of body.input)
      if (['function_call_output', 'custom_tool_call_output'].includes(item?.type))
        results.push({ callId: item.call_id, output: item.output });
  } else if (kind === 'claude' && Array.isArray(body.messages)) {
    for (const message of body.messages)
      if (message?.role === 'user' && Array.isArray(message.content))
        for (const item of message.content)
          if (item?.type === 'tool_result')
            results.push({ callId: item.tool_use_id, output: item.content });
  }
  if (results.length > MAX_CALLS) throw new TypeError('api_evidence_input_limit');
  const ids = new Set();
  for (const item of results) {
    if (!id(item.callId) || ids.has(item.callId) || item.output === undefined)
      throw new TypeError('invalid_api_evidence_result');
    ids.add(item.callId);
  }
  return results;
}

function parseApiEvidenceCalls(kind, input) {
  const body = normalizeCompactionData(input, MAX_WIRE_BYTES);
  if (!record(body)) throw new TypeError('invalid_api_evidence_response');
  let candidates = [];
  if (kind === 'chat') {
    if (!Array.isArray(body.choices) || body.choices.length !== 1) return [];
    const choice = body.choices[0];
    if (choice?.finish_reason !== 'tool_calls' || choice.message?.role !== 'assistant') return [];
    candidates = (choice.message.tool_calls ?? [])
      .filter((call) => call?.type === 'function')
      .map((call) => ({
        callId: call.id,
        toolName: call.function?.name,
        raw: call.function?.arguments,
      }));
  } else if (kind === 'responses' && body.status === 'completed') {
    candidates = (body.output ?? [])
      .filter((item) => ['function_call', 'custom_tool_call'].includes(item?.type))
      .map((item) => ({
        callId: item.call_id,
        toolName: item.name,
        raw: item.type === 'custom_tool_call' ? { input: item.input } : item.arguments,
      }));
  } else if (kind === 'claude' && body.role === 'assistant' && body.stop_reason === 'tool_use') {
    candidates = (body.content ?? [])
      .filter((item) => item?.type === 'tool_use')
      .map((item) => ({ callId: item.id, toolName: item.name, raw: item.input }));
  }
  if (candidates.length > MAX_CALLS) throw new TypeError('api_evidence_call_limit');
  const calls = [];
  const ids = new Set();
  for (const candidate of candidates) {
    if (!id(candidate.callId) || ids.has(candidate.callId))
      throw new TypeError('invalid_api_evidence_call');
    ids.add(candidate.callId);
    let args;
    try {
      if (typeof candidate.raw === 'string' && Buffer.byteLength(candidate.raw) > 4096) continue;
      args = typeof candidate.raw === 'string' ? JSON.parse(candidate.raw) : candidate.raw;
    } catch {
      continue;
    }
    const parsed = parseCompletedEvidenceSource({
      callId: candidate.callId,
      toolName: candidate.toolName,
      arguments: args,
      completed: true,
      output: '',
    });
    if (parsed.ok) calls.push(parsed.source);
  }
  return calls;
}

function createClaudeEvidenceCollector() {
  const blocks = new Map();
  let stopped = false;
  let reason;
  let started = false;
  const decoder = createSseJsonDecoder(MAX_WIRE_BYTES, (event) => {
    if (stopped || event.type === 'error') throw new TypeError('invalid_api_evidence_stream');
    if (event.type === 'message_start') {
      if (started || event.message?.role !== 'assistant')
        throw new TypeError('invalid_api_evidence_stream');
      started = true;
    } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      if (
        !started ||
        !Number.isSafeInteger(event.index) ||
        event.index < 0 ||
        blocks.has(event.index) ||
        blocks.size >= MAX_CALLS
      )
        throw new TypeError('invalid_api_evidence_stream');
      blocks.set(event.index, { value: event.content_block, json: '', stopped: false });
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
      const block = blocks.get(event.index);
      if (!block || block.stopped || typeof event.delta.partial_json !== 'string')
        throw new TypeError('invalid_api_evidence_stream');
      block.json += event.delta.partial_json;
      if (Buffer.byteLength(block.json) > 4096) throw new TypeError('api_evidence_call_limit');
    } else if (event.type === 'content_block_stop') {
      const block = blocks.get(event.index);
      if (block) {
        if (block.stopped) throw new TypeError('invalid_api_evidence_stream');
        block.stopped = true;
      }
    } else if (event.type === 'message_delta') reason = event.delta?.stop_reason;
    else if (event.type === 'message_stop') stopped = true;
  });
  return {
    push: decoder.push,
    finish() {
      decoder.finish();
      if (!started || !stopped || [...blocks.values()].some((block) => !block.stopped))
        throw new TypeError('incomplete_api_evidence_stream');
      return {
        role: 'assistant',
        stop_reason: reason,
        content: [...blocks.values()].map((block) => ({
          ...block.value,
          input: block.json ? JSON.parse(block.json) : block.value.input,
        })),
      };
    },
  };
}

function decodeApiEvidenceResponse(kind, wire, stream) {
  if (!Buffer.isBuffer(wire) || wire.length > MAX_WIRE_BYTES)
    throw new TypeError('api_evidence_response_limit');
  const text = wire.toString('utf8');
  if (!Buffer.from(text).equals(wire)) throw new TypeError('invalid_api_evidence_utf8');
  if (!stream) return parseApiEvidenceCalls(kind, JSON.parse(text));
  const collector =
    kind === 'chat'
      ? createChatCompletionCollector(MAX_WIRE_BYTES)
      : kind === 'responses'
        ? createResponsesCollector(MAX_WIRE_BYTES)
        : kind === 'claude'
          ? createClaudeEvidenceCollector()
          : null;
  if (!collector) throw new TypeError('invalid_api_evidence_protocol');
  collector.push(wire);
  return parseApiEvidenceCalls(kind, collector.finish());
}

module.exports = {
  MAX_WIRE_BYTES,
  apiEvidenceKind,
  parseApiEvidenceResults,
  parseApiEvidenceCalls,
  decodeApiEvidenceResponse,
};
