'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { LIST_EVIDENCE_TOOL, READ_EVIDENCE_TOOL } = require('./context-evidence-tools');
const { MAX_WIRE_BYTES } = require('./context-api-evidence-protocol');
const { decodeContextRecoveryResponse } = require('./context-recovery-protocol');
const { validateRecoveryHostedOutput } = require('./context-recovery-hosted-output');
const { validateRecoveryUsageServiceTier } = require('./context-recovery-progress');

const names = new Set([LIST_EVIDENCE_TOOL, READ_EVIDENCE_TOOL]);
const invalid = () => new TypeError('Unsupported recovery client output');

function sumUsage(values, depth = 0) {
  const sum = Object.create(null);
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    for (const [key, amount] of Object.entries(value)) {
      if (depth === 0 && key === 'service_tier') {
        validateRecoveryUsageServiceTier(amount);
        continue;
      }
      if (amount === null) {
        if (!Object.hasOwn(sum, key)) sum[key] = null;
      } else if (typeof amount === 'object') {
        if (sum[key] !== undefined && sum[key] !== null && typeof sum[key] !== 'object')
          throw invalid();
        sum[key] = sumUsage([sum[key] ?? {}, amount], depth + 1);
      } else {
        if (
          !Number.isSafeInteger(amount) ||
          amount < 0 ||
          (sum[key] != null && typeof sum[key] !== 'number')
        )
          throw invalid();
        sum[key] = (sum[key] ?? 0) + amount;
        if (!Number.isSafeInteger(sum[key])) throw invalid();
      }
    }
  }
  return sum;
}

// A bounded, complete final stream. No private phase or private tool definition
// is emitted. Signed/opaque fields remain in the final output items unchanged.
function encodeContextRecoveryClientWire(kind, input, usage, stream) {
  const response = normalizeCompactionData(input, MAX_WIRE_BYTES);
  const measured = normalizeCompactionData(usage, 128 * 1024);
  if (
    !['chat', 'responses', 'claude'].includes(kind) ||
    typeof stream !== 'boolean' ||
    !Array.isArray(measured) ||
    !measured.length ||
    measured.length > 8
  )
    throw invalid();
  const decoded = decodeContextRecoveryResponse(kind, Buffer.from(JSON.stringify(response)), false);
  const calls =
    kind === 'responses'
      ? response.output.filter((item) => ['function_call', 'custom_tool_call'].includes(item.type))
      : kind === 'chat'
        ? (response.choices[0].message.tool_calls ?? [])
        : response.content.filter((block) => block.type === 'tool_use');
  if (!decoded.output.length || calls.some((call) => names.has(call.name ?? call.function?.name)))
    throw invalid();
  if (kind === 'responses')
    for (const item of response.output) {
      if (item.type === 'custom_tool_call' && typeof item.input !== 'string') throw invalid();
      if (item.type === 'web_search_call') validateRecoveryHostedOutput(item);
    }
  const finalTier =
    response.usage && Object.hasOwn(response.usage, 'service_tier')
      ? { service_tier: validateRecoveryUsageServiceTier(response.usage.service_tier) }
      : {};
  response.usage = { ...sumUsage(measured), ...finalTier };
  if (Array.isArray(response.tools))
    response.tools = response.tools.filter(
      (tool) => !names.has(tool?.name ?? tool?.function?.name)
    );
  const chunks = [];
  let bytes = 0;
  let sequence = 0;
  function emit(type, value) {
    if (kind === 'responses') value = { ...value, sequence_number: sequence++ };
    const text = (type ? 'event: ' + type + '\n' : '') + 'data: ' + JSON.stringify(value) + '\n\n';
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_WIRE_BYTES) throw invalid();
    chunks.push(text);
  }
  if (!stream) {
    const wire = Buffer.from(JSON.stringify(response));
    if (wire.length > MAX_WIRE_BYTES) throw invalid();
    return { wire, response, contentType: 'application/json; charset=utf-8' };
  }
  if (kind === 'chat') {
    const choice = response.choices?.[0];
    if (response.choices?.length !== 1 || choice.message?.role !== 'assistant') throw invalid();
    const { message, finish_reason: finish } = choice;
    const delta = { ...message };
    if (Array.isArray(delta.tool_calls))
      delta.tool_calls = delta.tool_calls.map((call, index) => ({ ...call, index }));
    const metadata = Object.fromEntries(
      ['id', 'created', 'model', 'system_fingerprint', 'service_tier']
        .filter((key) => response[key] !== undefined)
        .map((key) => [key, response[key]])
    );
    emit(null, {
      ...metadata,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: null }],
    });
    emit(null, {
      ...metadata,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: response.usage,
    });
    chunks.push('data: [DONE]\n\n');
  } else if (kind === 'responses') {
    if (
      response.status !== 'completed' ||
      typeof response.id !== 'string' ||
      !Array.isArray(response.output)
    )
      throw invalid();
    const start = { ...response, status: 'in_progress', output: [], usage: null };
    emit('response.created', { type: 'response.created', response: start });
    emit('response.in_progress', { type: 'response.in_progress', response: start });
    response.output.forEach((item, outputIndex) => {
      if (typeof item.id !== 'string') throw invalid();
      const base = { response_id: response.id, item_id: item.id, output_index: outputIndex };
      const added =
        item.type === 'message'
          ? { ...item, status: 'in_progress', content: [] }
          : ['function_call', 'custom_tool_call'].includes(item.type)
            ? {
                ...item,
                status: 'in_progress',
                [item.type === 'custom_tool_call' ? 'input' : 'arguments']: '',
              }
            : { ...item };
      emit('response.output_item.added', {
        type: 'response.output_item.added',
        ...base,
        item: added,
      });
      if (['function_call', 'custom_tool_call'].includes(item.type)) {
        const field = item.type === 'custom_tool_call' ? 'input' : 'arguments';
        const event =
          item.type === 'custom_tool_call'
            ? 'response.custom_tool_call_input'
            : 'response.function_call_arguments';
        if (typeof item[field] !== 'string' || names.has(item.name)) throw invalid();
        emit(event + '.delta', {
          type: event + '.delta',
          ...base,
          delta: item[field],
        });
        emit(event + '.done', {
          type: event + '.done',
          ...base,
          [field]: item[field],
        });
      } else if (item.type === 'message') {
        if (item.role !== 'assistant' || !Array.isArray(item.content)) throw invalid();
        item.content.forEach((part, contentIndex) => {
          const key =
            part.type === 'output_text' ? 'text' : part.type === 'refusal' ? 'refusal' : null;
          if (!key || typeof part[key] !== 'string') throw invalid();
          const detail = { ...base, content_index: contentIndex };
          emit('response.content_part.added', {
            type: 'response.content_part.added',
            ...detail,
            part: { ...part, [key]: '' },
          });
          const type = key === 'text' ? 'response.output_text' : 'response.refusal';
          emit(type + '.delta', { type: type + '.delta', ...detail, delta: part[key] });
          emit(type + '.done', { type: type + '.done', ...detail, [key]: part[key] });
          emit('response.content_part.done', {
            type: 'response.content_part.done',
            ...detail,
            part,
          });
        });
      } else if (!['reasoning', 'compaction', 'web_search_call'].includes(item.type))
        throw invalid();
      emit('response.output_item.done', { type: 'response.output_item.done', ...base, item });
    });
    emit('response.completed', { type: 'response.completed', response });
  } else {
    if (response.role !== 'assistant' || !Array.isArray(response.content)) throw invalid();
    emit('message_start', {
      type: 'message_start',
      message: {
        ...response,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...response.usage, output_tokens: 0 },
      },
    });
    response.content.forEach((block, index) => {
      let start = block;
      if (block.type === 'text') start = { ...block, text: '' };
      else if (block.type === 'thinking') start = { ...block, thinking: '', signature: '' };
      else if (block.type === 'tool_use') {
        if (names.has(block.name)) throw invalid();
        start = { ...block, input: {} };
      } else if (block.type !== 'redacted_thinking') throw invalid();
      emit('content_block_start', { type: 'content_block_start', index, content_block: start });
      if (block.type === 'text')
        emit('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text },
        });
      if (block.type === 'thinking') {
        emit('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'thinking_delta', thinking: block.thinking },
        });
        emit('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'signature_delta', signature: block.signature },
        });
      }
      if (block.type === 'tool_use')
        emit('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        });
      emit('content_block_stop', { type: 'content_block_stop', index });
    });
    emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: response.stop_reason, stop_sequence: response.stop_sequence ?? null },
      usage: response.usage,
    });
    emit('message_stop', { type: 'message_stop' });
  }
  const wire = Buffer.from(chunks.join(''));
  if (wire.length > MAX_WIRE_BYTES) throw invalid();
  return { wire, response, contentType: 'text/event-stream; charset=utf-8' };
}

module.exports = { encodeContextRecoveryClientWire };
