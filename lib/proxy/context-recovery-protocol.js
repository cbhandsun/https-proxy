'use strict';

const { recoveryWbipcCredentialScope } = require('./context-recovery-auth');
const { nativeReaderPromise } = require('./context-recovery-reader-result');
const { codexRecoveryPolicyIdentity } = require('./context-recovery-codex-tools');
const {
  isCodexSummaryRequest,
  isCodexSummaryReceipt,
  parseCodexSummaryReceipt,
} = require('./context-recovery-codex-summary');
const {
  claudeRecoveryPolicyIdentity,
  parseClaudeSummaryReceipt,
} = require('./context-recovery-claude-summary');

const { createHash } = require('node:crypto');
const { gunzipSync, inflateSync, brotliDecompressSync } = require('node:zlib');
const { normalizeCompactionData } = require('./context-compaction-envelope');
const { normalizeRecoveryRequestBody } = require('./context-recovery-request-data');
const { recoveryHistoryRequestLimit } = require('./context-recovery-history-request');
const { evidencePrincipal } = require('./context-api-evidence-runtime');
const {
  parseApiEvidenceResults,
  parseApiEvidenceCalls,
  MAX_WIRE_BYTES,
} = require('./context-api-evidence-protocol');
const {
  createSseJsonDecoder,
  createChatCompletionCollector,
  createResponsesCollector,
} = require('./forced-stream-collector');

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new TypeError('Invalid recovery protocol data');

function beginContextRecoveryRequest(
  runtime,
  { auth, kind, prepared, buffer, encoding, compaction = false }
) {
  const principal = evidencePrincipal(auth);
  if (!principal) return { ok: false, code: 'context_recovery_identity_unavailable' };
  try {
    if (
      !['chat', 'responses', 'claude'].includes(kind) ||
      !Buffer.isBuffer(buffer) ||
      buffer.length > recoveryHistoryRequestLimit(3)
    )
      throw invalid();
    const decoders = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync };
    if (encoding && encoding !== 'identity' && !Object.hasOwn(decoders, encoding)) throw invalid();
    const bytes = decoders[encoding]
      ? decoders[encoding](buffer, { maxOutputLength: recoveryHistoryRequestLimit(3) })
      : buffer;
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw invalid();
    const body = normalizeRecoveryRequestBody(kind, JSON.parse(text), 3);
    if (!record(body) || !record(prepared?.profile)) throw invalid();
    let history = kind === 'responses' ? body.input : body.messages;
    if (kind === 'responses' && typeof history === 'string')
      history = [{ role: 'user', content: [{ type: 'input_text', text: history }] }];
    if (!Array.isArray(history) || !history.every(record)) throw invalid();
    const target = createHash('sha256')
      .update(
        JSON.stringify([
          prepared.profile.id,
          prepared.profile.targetUrl,
          prepared.profile.protocol,
          prepared.authProvider,
          prepared.authMode,
          ...(prepared.authProvider === 'workbuddy'
            ? [recoveryWbipcCredentialScope(prepared)]
            : []),
          prepared.rewriteTo && prepared.rewriteTo !== '-' ? prepared.rewriteTo : body.model,
        ])
      )
      .digest('hex');
    const request = {
      principal,
      protocol: kind,
      target,
      history,
      policy: {
        instructions:
          body.instructions ??
          (kind === 'responses' &&
          prepared.authMode === 'official-login' &&
          prepared.authProvider === 'openai'
            ? ''
            : null),
        system: body.system ?? null,
        tools: body.tools ?? null,
        toolChoice: body.tool_choice ?? null,
      },
      // Responses null explicitly starts from the supplied full window. It is
      // not a provider ancestor ID and must not enter private binding lookup.
      ...(body.previous_response_id !== undefined &&
      !(kind === 'responses' && body.previous_response_id === null)
        ? { previousResponseId: body.previous_response_id }
        : {}),
    };
    if (kind === 'claude') {
      // Claude has no wire previous_response_id contract. Only a complete
      // echoed summary receipt can supply the internal observed-response key.
      if (body.previous_response_id !== undefined) throw invalid();
      request.policy = claudeRecoveryPolicyIdentity(request.policy);
      // Native clients may insert an assistant acknowledgment before their
      // first continuation. Binding selection checks observed descendants so
      // a retained receipt cannot roll an already published window backward.
      const receipt = parseClaudeSummaryReceipt(history);
      if (receipt) request.previousResponseId = receipt;
    }
    if (typeof compaction !== 'boolean' || (compaction && kind !== 'responses')) throw invalid();
    if (kind === 'responses') {
      request.policy = codexRecoveryPolicyIdentity(request.policy, history);
      // This local selector can only come from an exact echoed summary, never
      // from a provider-owned previous_response_id supplied on the wire.
      if (isCodexSummaryReceipt(body.previous_response_id)) throw invalid();
      const receipt = parseCodexSummaryReceipt(history, 3);
      if (receipt && body.previous_response_id === undefined) request.previousResponseId = receipt;
      if (isCodexSummaryRequest(body, 3)) compaction = true;
    }
    const results = parseApiEvidenceResults(kind, body, 3);
    return compaction ? runtime.beginCompaction(request, results) : runtime.begin(request, results);
  } catch {
    return { ok: false, code: 'context_recovery_request_unsupported' };
  }
}

// Reuse exactly the same wire parsing and identity derivation. Async admission
// remains an owner capability; no request root/path selector is introduced.
async function beginContextRecoveryRequestAsync(runtime, options, authorized) {
  try {
    const begin = Object.getOwnPropertyDescriptor(runtime, 'beginAsync');
    if (typeof begin?.value !== 'function' || typeof authorized !== 'function') throw invalid();
    const pending = beginContextRecoveryRequest(
      {
        begin: (request, results) => begin.value.call(runtime, request, results, authorized, false),
        beginCompaction: (request, results) =>
          begin.value.call(runtime, request, results, authorized, true),
      },
      options
    );
    if (nativeReaderPromise(pending)) return await pending;
    const result = normalizeCompactionData(pending, 1024);
    if (!record(result) || result.ok !== false || typeof result.code !== 'string') throw invalid();
    return { ok: false, code: result.code };
  } catch {
    return { ok: false, code: 'context_recovery_request_unsupported' };
  }
}

function claudeCollector() {
  const blocks = new Map();
  let started = false;
  let stopped = false;
  let reason;
  let messageId;
  const metadata = {};
  let usage = {};
  const decoder = createSseJsonDecoder(MAX_WIRE_BYTES, (event) => {
    if (stopped || event.type === 'error') throw invalid();
    if (event.type === 'message_start') {
      if (started || event.message?.role !== 'assistant') throw invalid();
      started = true;
      messageId = event.message.id;
      if (event.message.type !== undefined) {
        if (event.message.type !== 'message') throw invalid();
        metadata.type = event.message.type;
      }
      if (event.message.model !== undefined) {
        if (
          typeof event.message.model !== 'string' ||
          !event.message.model.length ||
          event.message.model.length > 1024
        )
          throw invalid();
        metadata.model = event.message.model;
      }
      if (event.message.stop_sequence !== undefined) {
        if (event.message.stop_sequence !== null && typeof event.message.stop_sequence !== 'string')
          throw invalid();
        metadata.stop_sequence = event.message.stop_sequence;
      }
      if (event.message.usage !== undefined) {
        if (!record(event.message.usage)) throw invalid();
        usage = { ...event.message.usage };
      }
    } else if (event.type === 'content_block_start') {
      if (
        !started ||
        !Number.isSafeInteger(event.index) ||
        event.index < 0 ||
        blocks.has(event.index) ||
        blocks.size >= 128 ||
        !['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(event.content_block?.type)
      )
        throw invalid();
      blocks.set(event.index, { value: event.content_block, json: '', stopped: false });
    } else if (event.type === 'content_block_delta') {
      const block = blocks.get(event.index);
      if (!block || block.stopped) throw invalid();
      const delta = event.delta;
      if (
        block.value.type === 'tool_use' &&
        delta?.type === 'input_json_delta' &&
        typeof delta.partial_json === 'string'
      ) {
        block.json += delta.partial_json;
        if (Buffer.byteLength(block.json) > 4096) throw invalid();
      } else {
        const key =
          delta?.type === 'text_delta'
            ? 'text'
            : delta?.type === 'thinking_delta'
              ? 'thinking'
              : delta?.type === 'signature_delta'
                ? 'signature'
                : null;
        if (
          !key ||
          typeof delta[key] !== 'string' ||
          !(
            (block.value.type === 'text' && key === 'text') ||
            (block.value.type === 'thinking' && ['thinking', 'signature'].includes(key))
          )
        )
          throw invalid();
        block.value[key] = (block.value[key] ?? '') + delta[key];
      }
    } else if (event.type === 'content_block_stop') {
      const block = blocks.get(event.index);
      if (!block || block.stopped) throw invalid();
      block.stopped = true;
    } else if (event.type === 'message_delta') {
      reason = event.delta?.stop_reason;
      if (event.delta?.stop_sequence !== undefined) {
        if (event.delta.stop_sequence !== null && typeof event.delta.stop_sequence !== 'string')
          throw invalid();
        metadata.stop_sequence = event.delta.stop_sequence;
      }
      if (event.usage !== undefined) {
        if (!record(event.usage)) throw invalid();
        usage = { ...usage, ...event.usage };
      }
    } else if (event.type === 'message_stop') stopped = true;
  });
  return {
    push: decoder.push,
    finish() {
      decoder.finish();
      if (!started || !stopped || [...blocks.values()].some((b) => !b.stopped)) throw invalid();
      return {
        ...metadata,
        role: 'assistant',
        ...(messageId ? { id: messageId } : {}),
        stop_reason: reason,
        ...(Object.keys(usage).length ? { usage } : {}),
        content: [...blocks.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, block]) =>
            block.value.type === 'tool_use'
              ? { ...block.value, input: block.json ? JSON.parse(block.json) : block.value.input }
              : block.value
          ),
      };
    },
  };
}

function decodeContextRecoveryEnvelope(kind, wire, stream) {
  if (!Buffer.isBuffer(wire) || wire.length > MAX_WIRE_BYTES) throw invalid();
  const text = wire.toString('utf8');
  if (!Buffer.from(text).equals(wire)) throw invalid();
  let body;
  if (!stream) body = JSON.parse(text);
  else {
    const collector =
      kind === 'chat'
        ? createChatCompletionCollector(MAX_WIRE_BYTES)
        : kind === 'responses'
          ? createResponsesCollector(MAX_WIRE_BYTES)
          : kind === 'claude'
            ? claudeCollector()
            : null;
    if (!collector) throw invalid();
    collector.push(wire);
    body = collector.finish();
  }
  body = normalizeCompactionData(body, MAX_WIRE_BYTES);
  if (!record(body)) throw invalid();
  return body;
}

function decodeContextRecoveryResponse(kind, wire, stream) {
  const body = decodeContextRecoveryEnvelope(kind, wire, stream);
  let output;
  if (kind === 'responses' && body.status === 'completed' && Array.isArray(body.output))
    output = body.output;
  else if (
    kind === 'chat' &&
    body.choices?.length === 1 &&
    ['stop', 'tool_calls'].includes(body.choices[0].finish_reason) &&
    body.choices[0].message?.role === 'assistant'
  )
    output = [body.choices[0].message];
  else if (
    kind === 'claude' &&
    body.role === 'assistant' &&
    ['end_turn', 'stop_sequence', 'tool_use'].includes(body.stop_reason) &&
    Array.isArray(body.content)
  )
    output = [{ role: 'assistant', content: body.content }];
  else throw invalid();
  if (!output.length || !output.every(record)) throw invalid();
  return {
    output,
    calls: parseApiEvidenceCalls(kind, body),
    ...(typeof body.id === 'string' ? { responseId: body.id } : {}),
  };
}

module.exports = {
  beginContextRecoveryRequest,
  beginContextRecoveryRequestAsync,
  decodeContextRecoveryResponse,
  decodeContextRecoveryEnvelope,
};
