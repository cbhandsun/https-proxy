'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { normalizeRecoveryRequestBody } = require('./context-recovery-request-data');
const { LIST_EVIDENCE_TOOL, READ_EVIDENCE_TOOL } = require('./context-evidence-tools');
const { MAX_WIRE_BYTES } = require('./context-api-evidence-protocol');
const { createRecoveryToolCatalog } = require('./context-recovery-tool-catalog');
const { validateRecoveryHostedOutput } = require('./context-recovery-hosted-output');

const INTERNAL_NAMES = new Set([LIST_EVIDENCE_TOOL, READ_EVIDENCE_TOOL]);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const invalid = () => new TypeError('Invalid context recovery turn');

// These are protocol values, never host tools. Only the coordinator may execute
// INTERNAL_NAMES; external calls are returned unchanged for client execution.
function createContextRecoveryTurn(kind, input, definitions, historyFormat = 2) {
  if (!['chat', 'responses', 'claude'].includes(kind)) throw invalid();
  const body = normalizeRecoveryRequestBody(kind, input, historyFormat);
  const readers = normalizeCompactionData(definitions, 16384);
  if (!record(body) || !Array.isArray(readers) || readers.length !== 2) throw invalid();
  if (
    new Set(readers.map((tool) => tool.name)).size !== 2 ||
    readers.some(
      (tool) =>
        !INTERNAL_NAMES.has(tool.name) ||
        !record(tool.inputSchema) ||
        typeof tool.description !== 'string'
    )
  )
    throw invalid();
  const historyKey = kind === 'responses' ? 'input' : 'messages';
  if (kind === 'responses' && typeof body.input === 'string')
    body.input = [{ role: 'user', content: [{ type: 'input_text', text: body.input }] }];
  if (!Array.isArray(body[historyKey]) || !body[historyKey].every(record)) throw invalid();
  const choice = body.tool_choice;
  const auto =
    choice === undefined || choice === 'auto' || (kind === 'claude' && choice?.type === 'auto');
  if (
    !auto ||
    body.response_format != null ||
    body.text?.format != null ||
    (body.n !== undefined && body.n !== 1)
  )
    return { ok: false, code: 'context_recovery_controls_unsupported' };
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw invalid();
  const tools = body.tools ?? [];
  const catalog = createRecoveryToolCatalog(kind, tools);
  if (!catalog.ok) return catalog;
  const internalTools = readers.map((tool) => {
    if (kind === 'claude')
      return { name: tool.name, description: tool.description, input_schema: tool.inputSchema };
    const fn = { name: tool.name, description: tool.description, parameters: tool.inputSchema };
    // Responses otherwise normalizes optional cursor/page fields into required
    // fields. Keep the reader's exact schema; the host still validates every
    // argument before execution. External tool declarations remain untouched.
    return kind === 'chat'
      ? { type: 'function', function: fn }
      : { type: 'function', ...fn, strict: false };
  });
  const ids = new Set();
  // Include existing tool IDs so a provider cannot reissue an earlier call.
  for (const item of body[historyKey]) {
    if (kind === 'responses' && identity(item.call_id)) ids.add(item.call_id);
    if (kind === 'chat') {
      if (identity(item.tool_call_id)) ids.add(item.tool_call_id);
      for (const call of Array.isArray(item.tool_calls) ? item.tool_calls : [])
        if (identity(call.id)) ids.add(call.id);
    }
    if (kind === 'claude')
      for (const block of Array.isArray(item.content) ? item.content : []) {
        if (block.type === 'tool_use' && identity(block.id)) ids.add(block.id);
        if (block.type === 'tool_result' && identity(block.tool_use_id)) ids.add(block.tool_use_id);
      }
  }
  function request(history, internalOnly = false) {
    return normalizeRecoveryRequestBody(
      kind,
      {
        ...body,
        [historyKey]: history,
        tools: internalOnly ? internalTools : [...tools, ...internalTools],
      },
      historyFormat
    );
  }
  function decode(inputResponse, internalOnly = false) {
    const response = normalizeCompactionData(inputResponse, MAX_WIRE_BYTES);
    if (!record(response)) throw invalid();
    let output;
    let candidates;
    if (kind === 'chat') {
      const selected = response.choices?.[0];
      if (
        response.choices?.length !== 1 ||
        !['stop', 'tool_calls'].includes(selected.finish_reason) ||
        selected.message?.role !== 'assistant' ||
        selected.message.function_call != null
      )
        throw invalid();
      output = [selected.message];
      candidates = selected.message.tool_calls ?? [];
      if (
        !Array.isArray(candidates) ||
        candidates.length > 0 !== (selected.finish_reason === 'tool_calls')
      )
        throw invalid();
    } else if (kind === 'responses') {
      if (response.status !== 'completed' || !Array.isArray(response.output)) throw invalid();
      output = response.output;
      if (
        output.some(
          (item) =>
            !record(item) ||
            ![
              'message',
              'function_call',
              'custom_tool_call',
              'web_search_call',
              'reasoning',
              'compaction',
            ].includes(item.type) ||
            (item.type === 'message' && item.role !== 'assistant') ||
            (['function_call', 'custom_tool_call'].includes(item.type) &&
              item.status !== undefined &&
              item.status !== 'completed')
        )
      )
        throw invalid();
      for (const item of output.filter((item) => item.type === 'web_search_call')) {
        if (internalOnly || !catalog.hostedSearch) throw invalid();
        validateRecoveryHostedOutput(item);
      }
      candidates = output.filter((item) =>
        ['function_call', 'custom_tool_call'].includes(item.type)
      );
    } else {
      if (
        response.role !== 'assistant' ||
        !['end_turn', 'stop_sequence', 'tool_use'].includes(response.stop_reason) ||
        !Array.isArray(response.content)
      )
        throw invalid();
      output = [{ role: 'assistant', content: response.content }];
      if (
        response.content.some(
          (block) =>
            !record(block) ||
            !['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(block.type)
        )
      )
        throw invalid();
      candidates = response.content.filter((block) => block.type === 'tool_use');
      if (candidates.length > 0 !== (response.stop_reason === 'tool_use')) throw invalid();
    }
    if (candidates.length > 16 || !output.length) throw invalid();
    const turnIds = new Set();
    const calls = candidates.map((raw) => {
      const id = kind === 'responses' ? raw.call_id : raw.id;
      const name = kind === 'chat' ? raw.function?.name : raw.name;
      const custom = kind === 'responses' && raw.type === 'custom_tool_call';
      const namespace = kind === 'responses' ? raw.namespace : undefined;
      const internal = INTERNAL_NAMES.has(name) && namespace == null && !custom;
      const args =
        kind === 'chat'
          ? raw.function?.arguments
          : kind === 'responses'
            ? custom
              ? raw.input
              : raw.arguments
            : raw.input;
      if (
        !identity(id) ||
        ids.has(id) ||
        turnIds.has(id) ||
        !identity(name) ||
        (INTERNAL_NAMES.has(name) && !internal) ||
        (!internal &&
          (internalOnly ||
            catalog.resolve(name, namespace) !== (custom ? 'custom' : 'function'))) ||
        (kind === 'chat' && raw.type !== 'function')
      )
        throw invalid();
      turnIds.add(id);
      const argumentLimit = internal ? 4096 : 1024 * 1024;
      if (Buffer.byteLength(typeof args === 'string' ? args : JSON.stringify(args)) > argumentLimit)
        throw invalid();
      const parsed = custom ? args : typeof args === 'string' ? JSON.parse(args) : args;
      if (custom ? typeof parsed !== 'string' : !record(parsed)) throw invalid();
      return { id, name, arguments: parsed, internal };
    });
    // Publish IDs only after the entire response has passed admission.
    for (const id of turnIds) ids.add(id);
    return { response, output, calls };
  }
  function select(turn, internal) {
    const keep = new Set(
      turn.calls.filter((call) => call.internal === internal).map((call) => call.id)
    );
    const response = normalizeCompactionData(turn.response, MAX_WIRE_BYTES);
    if (kind === 'chat') {
      response.choices[0].message.tool_calls = response.choices[0].message.tool_calls.filter(
        (call) => keep.has(call.id)
      );
    } else if (kind === 'responses') {
      response.output = response.output.filter(
        (item) =>
          !['function_call', 'custom_tool_call'].includes(item.type) || keep.has(item.call_id)
      );
    } else
      response.content = response.content.filter(
        (block) => block.type !== 'tool_use' || keep.has(block.id)
      );
    const output =
      kind === 'chat'
        ? [response.choices[0].message]
        : kind === 'responses'
          ? response.output
          : [{ role: 'assistant', content: response.content }];
    return { response, output, calls: turn.calls.filter((call) => call.internal === internal) };
  }
  function append(history, turn, results) {
    let additions;
    if (kind === 'chat')
      additions = [
        ...turn.output,
        ...results.map((result) => ({
          role: 'tool',
          tool_call_id: result.id,
          content: result.text,
        })),
      ];
    else if (kind === 'responses')
      additions = [
        ...turn.output,
        ...results.map((result) => ({
          type: 'function_call_output',
          call_id: result.id,
          output: result.text,
        })),
      ];
    else
      additions = [
        ...turn.output,
        {
          role: 'user',
          content: results.map((result) => ({
            type: 'tool_result',
            tool_use_id: result.id,
            content: result.text,
            ...(result.ok ? {} : { is_error: true }),
          })),
        },
      ];
    return normalizeRecoveryRequestBody(
      kind,
      { [historyKey]: [...history, ...additions] },
      historyFormat
    )[historyKey];
  }
  function canSplit(turn) {
    if (kind === 'chat') return !turn.output[0].reasoning_content && !turn.output[0].refusal;
    if (kind === 'responses')
      return turn.output.every((item) => !['reasoning', 'compaction'].includes(item.type));
    return turn.output[0].content.every(
      (block) => !['thinking', 'redacted_thinking'].includes(block.type)
    );
  }
  function publicReferences(turn) {
    if (kind !== 'responses') return [];
    const internal = new Set(turn.calls.filter((call) => call.internal).map((call) => call.id));
    let outputIndex = 0;
    const references = [];
    for (let historyIndex = 0; historyIndex < turn.output.length; historyIndex++) {
      const item = turn.output[historyIndex];
      if (item.type === 'function_call' && internal.has(item.call_id)) continue;
      references.push({ historyIndex, outputIndex: outputIndex++ });
    }
    return references;
  }
  return {
    ok: true,
    history: body[historyKey],
    request,
    decode,
    select,
    append,
    canSplit,
    publicReferences,
  };
}

module.exports = { createContextRecoveryTurn };
