'use strict';

const { normalizeRecoveryRequestBody } = require('./context-recovery-request-data');
const { fingerprintContextData } = require('./context-recovery-fingerprint');
const {
  decodeContextRecoveryEnvelope,
  decodeContextRecoveryResponse,
} = require('./context-recovery-protocol');

const {
  record,
  invalid,
  string,
  identity,
  fields,
  validateHistory,
  validateTools,
} = require('./context-recovery-conversion-guards');

// Trusted production converters are injected by the composition root. This
// adapter never calls a route handler (which can retry, publish or execute tools).
function createContextRecoveryConversion({ kind, model, converters, historyFormat = 2 }) {
  if (
    !['responses', 'claude'].includes(kind) ||
    !string(model) ||
    !model.trim() ||
    model.length > 256 ||
    [...model].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw invalid();
  const encode =
    kind === 'responses'
      ? converters?.openAIResponsesToChat
      : converters?.claudeMessagesToOpenAIChat;
  const decode =
    kind === 'responses'
      ? converters?.openAIChatToResponses
      : converters?.openAIResponseToClaudeMessage;
  if (typeof encode !== 'function' || typeof decode !== 'function') throw invalid();

  function encodeRequest(input) {
    const body = normalizeRecoveryRequestBody(kind, input, historyFormat);
    fields(body, [
      'model',
      'stream',
      'tools',
      'tool_choice',
      'temperature',
      'top_p',
      'parallel_tool_calls',
      'service_tier',
      ...(kind === 'responses'
        ? ['input', 'instructions', 'max_output_tokens', 'store']
        : ['messages', 'system', 'max_tokens', 'stop_sequences']),
    ]);
    if (
      !string(body.model) ||
      !body.model.trim() ||
      body.model.length > 256 ||
      (body.stream !== undefined && typeof body.stream !== 'boolean')
    )
      throw invalid();
    if (
      body.tool_choice !== undefined &&
      body.tool_choice !== 'auto' &&
      !(
        kind === 'claude' &&
        record(body.tool_choice) &&
        body.tool_choice.type === 'auto' &&
        Object.keys(body.tool_choice).length === 1
      )
    )
      throw invalid();
    if (body.store !== undefined && body.store !== false) throw invalid();
    if (body.instructions !== undefined && !string(body.instructions)) throw invalid();
    if (body.system !== undefined && !string(body.system)) throw invalid();
    for (const key of ['temperature', 'top_p'])
      if (
        body[key] !== undefined &&
        (typeof body[key] !== 'number' || body[key] < 0 || body[key] > (key === 'top_p' ? 1 : 2))
      )
        throw invalid();
    for (const key of ['max_tokens', 'max_output_tokens'])
      if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key] < 1))
        throw invalid();
    if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean')
      throw invalid();
    if (
      body.service_tier !== undefined &&
      !['auto', 'default', 'flex', 'priority'].includes(body.service_tier)
    )
      throw invalid();
    if (
      body.stop_sequences !== undefined &&
      (!Array.isArray(body.stop_sequences) || !body.stop_sequences.every(string))
    )
      throw invalid();
    validateHistory(kind, body);
    validateTools(kind, body.tools);
    const converted = encode(body, kind === 'claude' ? model : undefined);
    fields(converted, [
      'model',
      'messages',
      'tools',
      'tool_choice',
      'stream',
      'temperature',
      'top_p',
      'max_tokens',
      'max_completion_tokens',
      'parallel_tool_calls',
      'service_tier',
      'stop',
    ]);
    if (!Array.isArray(converted.messages)) throw invalid();
    const expectedTools = (body.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      parameters: kind === 'responses' ? tool.parameters : tool.input_schema,
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    }));
    const actualTools = (converted.tools ?? []).map((tool) => tool.function);
    if (fingerprintContextData(expectedTools) !== fingerprintContextData(actualTools))
      throw invalid();
    converted.model = model;
    // Buffer the upstream generation, preserving the client's publication mode.
    converted.stream = false;
    return normalizeRecoveryRequestBody('chat', converted, historyFormat);
  }

  function createDispatch(dispatch) {
    if (typeof dispatch !== 'function') throw invalid();
    return async (input, options) => {
      const result = await dispatch(encodeRequest(input), options);
      if (
        result.statusCode !== 200 ||
        typeof result.stream !== 'boolean' ||
        (result.encoding && result.encoding !== 'identity')
      )
        throw invalid();
      const source = decodeContextRecoveryEnvelope('chat', result.wire, result.stream);
      decodeContextRecoveryResponse('chat', result.wire, result.stream);
      const choice = source.choices[0];
      fields(choice.message, ['role', 'content', 'tool_calls', 'refusal']);
      if (
        choice.message.content !== null &&
        choice.message.content !== undefined &&
        !string(choice.message.content)
      )
        throw invalid();
      if (choice.message.refusal != null) throw invalid();
      const calls = choice.message.tool_calls ?? [];
      if (!Array.isArray(calls) || calls.length > 0 !== (choice.finish_reason === 'tool_calls'))
        throw invalid();
      const callIds = new Set();
      for (const call of calls) {
        fields(call, ['id', 'type', 'function']);
        fields(call.function, ['name', 'arguments']);
        if (
          call.type !== 'function' ||
          !identity(call.id) ||
          callIds.has(call.id) ||
          !identity(call.function.name) ||
          !string(call.function.arguments) ||
          !record(JSON.parse(call.function.arguments))
        )
          throw invalid();
        callIds.add(call.id);
      }
      const response = decode(source, model);
      const wire = Buffer.from(JSON.stringify(response));
      decodeContextRecoveryResponse(kind, wire, false);
      // In particular, a production cleanToolArgs policy must not silently
      // modify an external call while passing through the recovery loop.
      const convertedCalls =
        kind === 'responses'
          ? response.output.filter((item) => item.type === 'function_call')
          : response.content.filter((item) => item.type === 'tool_use');
      if (convertedCalls.length !== calls.length) throw invalid();
      for (let index = 0; index < calls.length; index++) {
        const before = calls[index];
        const after = convertedCalls[index];
        if (
          (kind === 'responses' ? after.call_id : after.id) !== before.id ||
          after.name !== before.function.name ||
          fingerprintContextData(
            kind === 'responses' ? JSON.parse(after.arguments) : after.input
          ) !== fingerprintContextData(JSON.parse(before.function.arguments))
        )
          throw invalid();
      }
      return { statusCode: 200, stream: false, wire };
    };
  }
  return { upstreamKind: 'chat', encodeRequest, createDispatch };
}

module.exports = { createContextRecoveryConversion };
