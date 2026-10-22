'use strict';

const { normalizeRecoveryRequestBody } = require('./context-recovery-request-data');
const {
  fingerprintContextData,
  fingerprintRecoveryHistory,
} = require('./context-recovery-fingerprint');
const {
  decodeContextRecoveryEnvelope,
  decodeContextRecoveryResponse,
} = require('./context-recovery-protocol');
const {
  record,
  invalid,
  string,
  fields,
  validateHistory,
  validateTools,
  validateChatCalls,
} = require('./context-recovery-conversion-guards');

const { clientProjection, responseEvents } = require('./context-recovery-conversion-projection');

function createContextRecoveryResponsesConversion({
  kind,
  model,
  converters,
  codex = false,
  historyFormat = 2,
}) {
  if (
    !['chat', 'claude'].includes(kind) ||
    !string(model) ||
    !model.trim() ||
    model.length > 256 ||
    [...model].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    typeof codex !== 'boolean'
  )
    throw invalid();
  const encode =
    kind === 'chat'
      ? converters?.openAIChatToResponsesRequest
      : converters?.claudeMessagesToResponsesRequest;
  const decode =
    kind === 'chat'
      ? converters?.openAIResponsesToChatResponse
      : converters?.responsesResponseToClaude;
  if (typeof encode !== 'function' || typeof decode !== 'function') throw invalid();

  function encodeRequest(input) {
    const body = normalizeRecoveryRequestBody(kind, input, historyFormat);
    fields(body, [
      'model',
      'messages',
      'stream',
      'tools',
      'tool_choice',
      'temperature',
      'top_p',
      'parallel_tool_calls',
      'service_tier',
      ...(kind === 'chat'
        ? ['max_tokens', 'max_completion_tokens']
        : ['system', 'max_tokens', 'stop_sequences']),
    ]);
    if (
      !string(body.model) ||
      !body.model.trim() ||
      body.model.length > 256 ||
      (body.stream !== undefined && typeof body.stream !== 'boolean') ||
      (body.system !== undefined && !string(body.system))
    )
      throw invalid();
    if (
      body.tool_choice !== undefined &&
      !(kind === 'chat'
        ? body.tool_choice === 'auto'
        : record(body.tool_choice) &&
          body.tool_choice.type === 'auto' &&
          Object.keys(body.tool_choice).length === 1)
    )
      throw invalid();
    for (const key of ['max_tokens', 'max_completion_tokens'])
      if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key] < 1))
        throw invalid();
    if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) throw invalid();
    for (const key of ['temperature', 'top_p'])
      if (
        body[key] !== undefined &&
        (codex ||
          typeof body[key] !== 'number' ||
          body[key] < 0 ||
          body[key] > (key === 'temperature' ? 2 : 1))
      )
        throw invalid();
    if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean')
      throw invalid();
    if (
      body.stop_sequences !== undefined &&
      (!Array.isArray(body.stop_sequences) || body.stop_sequences.length)
    )
      throw invalid();
    if (
      body.service_tier !== undefined &&
      !['auto', 'default', 'flex', 'priority'].includes(body.service_tier)
    )
      throw invalid();
    validateHistory(kind, body, { allowToolErrors: true });
    validateTools(kind, body.tools);
    const before = clientProjection(kind, body);
    const options = { codex, nativeContextManagement: true };
    const converted = {
      ...(kind === 'chat' ? encode({ ...body, model }, options) : encode(body, model, options)),
    };
    // The caller's instructions, including the empty case, are authoritative.
    converted.instructions = before.instructions;
    converted.stream = true;
    converted.store = false;
    fields(converted, [
      'model',
      'input',
      'instructions',
      'stream',
      'store',
      'tools',
      'tool_choice',
      'temperature',
      'top_p',
      'max_output_tokens',
      'parallel_tool_calls',
      'service_tier',
      'prompt_cache_key',
      'prompt_cache_retention',
    ]);
    if (
      converted.model !== model ||
      (converted.tool_choice !== undefined && converted.tool_choice !== 'auto')
    )
      throw invalid();
    for (const key of ['temperature', 'top_p', 'parallel_tool_calls', 'service_tier'])
      if (converted[key] !== body[key]) throw invalid();
    if (converted.max_output_tokens !== (body.max_completion_tokens ?? body.max_tokens))
      throw invalid();
    const expectedTools = (body.tools ?? []).map((tool) => {
      const fn = kind === 'chat' ? tool.function : tool;
      return {
        type: 'function',
        name: fn.name,
        description: fn.description ?? '',
        parameters: kind === 'chat' ? fn.parameters : fn.input_schema,
        strict: fn.strict ?? false,
      };
    });
    const actualTools = (converted.tools ?? []).map((tool) => ({
      ...tool,
      strict: tool.strict ?? false,
    }));
    if (
      fingerprintContextData(expectedTools) !== fingerprintContextData(actualTools) ||
      fingerprintRecoveryHistory(before.events, historyFormat) !==
        fingerprintRecoveryHistory(responseEvents(converted.input), historyFormat)
    )
      throw invalid();
    converted.tools = expectedTools;
    return normalizeRecoveryRequestBody('responses', converted, historyFormat);
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
      const source = decodeContextRecoveryEnvelope('responses', result.wire, result.stream);
      decodeContextRecoveryResponse('responses', result.wire, result.stream);
      const before = responseEvents(source.output, { assistantOnly: true });
      const converted = decode(source, model);
      const wire = Buffer.from(JSON.stringify(converted));
      decodeContextRecoveryResponse(kind, wire, false);
      let after;
      if (kind === 'chat') {
        const message = converted.choices[0].message;
        fields(message, ['role', 'content', 'tool_calls']);
        validateChatCalls(message.tool_calls ?? []);
        after = clientProjection('chat', { messages: [message] }, { allowPending: true }).events;
      } else {
        validateHistory('claude', {
          messages: [{ role: 'assistant', content: converted.content }],
        });
        after = clientProjection(
          'claude',
          { messages: [{ role: 'assistant', content: converted.content }] },
          { allowPending: true }
        ).events;
      }
      // The response converter may concatenate adjacent text parts. Compare the
      // exact text bytes and ordered calls, while forbidding interleaved calls.
      const collapse = (events) => {
        let text = '';
        let called = false;
        const calls = [];
        for (const event of events) {
          if (event.type === 'text') {
            if (called) throw invalid();
            text += event.text;
          } else {
            called = true;
            calls.push(event);
          }
        }
        return { text, calls };
      };
      if (fingerprintContextData(collapse(before)) !== fingerprintContextData(collapse(after)))
        throw invalid();
      return { statusCode: 200, stream: false, wire };
    };
  }
  return { upstreamKind: 'responses', encodeRequest, createDispatch };
}

module.exports = { createContextRecoveryResponsesConversion };
