'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { MAX_WIRE_BYTES } = require('./context-api-evidence-protocol');
const { normalizeRecoveryRequestBody } = require('./context-recovery-request-data');
const { fingerprintContextData } = require('./context-recovery-fingerprint');
const { createContextRecoveryConversion } = require('./context-recovery-conversion');
const {
  clientProjection,
  responseEvents,
  sameRecoveryHistoryProjection,
} = require('./context-recovery-conversion-projection');
const {
  fields,
  string,
  invalid,
  validateHistory,
  validateTools,
} = require('./context-recovery-conversion-guards');
const {
  decodeContextRecoveryEnvelope,
  decodeContextRecoveryResponse,
} = require('./context-recovery-protocol');

function same(left, right) {
  if (fingerprintContextData(left) !== fingerprintContextData(right)) throw invalid();
}

function sourceProjection(kind, body) {
  if (kind === 'chat') return clientProjection(kind, body);
  const input = string(body.input)
    ? [{ type: 'message', role: 'user', content: body.input }]
    : body.input.map((item) => (item.type === undefined ? { type: 'message', ...item } : item));
  return { instructions: body.instructions ?? '', events: responseEvents(input) };
}

function responseProjection(events) {
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
}

// All execution stays in the shared HTTP dispatcher. The injected production
// converters cannot select a route, publish to the client or execute tools.
function createContextRecoveryMessagesConversion({ kind, model, converters, historyFormat = 2 }) {
  if (!['chat', 'responses'].includes(kind)) throw invalid();
  // Reuse the existing model and Responses admission boundary before chaining
  // production conversion functions; exact projections below reject any drift.
  const toChat = createContextRecoveryConversion({
    kind: 'responses',
    model,
    converters,
    historyFormat,
  });
  const encode = converters?.openAIChatToClaudeMessages;
  const decode = converters?.claudeResponseToOpenAIChat;
  if (typeof encode !== 'function' || typeof decode !== 'function') throw invalid();

  function encodeRequest(input) {
    const body = normalizeRecoveryRequestBody(kind, input, historyFormat);
    let chat;
    if (kind === 'responses') chat = toChat.encodeRequest(body);
    else {
      fields(body, [
        'model',
        'messages',
        'stream',
        'tools',
        'tool_choice',
        'temperature',
        'top_p',
        'max_tokens',
        'max_completion_tokens',
        'parallel_tool_calls',
      ]);
      if (
        !string(body.model) ||
        !body.model.trim() ||
        body.model.length > 256 ||
        (body.stream !== undefined && typeof body.stream !== 'boolean') ||
        (body.tool_choice !== undefined && body.tool_choice !== 'auto')
      )
        throw invalid();
      validateHistory(kind, body);
      validateTools(kind, body.tools);
      chat = { ...body, model };
    }
    for (const key of ['max_tokens', 'max_completion_tokens'])
      if (chat[key] !== undefined && (!Number.isSafeInteger(chat[key]) || chat[key] < 1))
        throw invalid();
    if (chat.max_tokens !== undefined && chat.max_completion_tokens !== undefined) throw invalid();
    for (const key of ['temperature', 'top_p'])
      if (
        chat[key] !== undefined &&
        (typeof chat[key] !== 'number' || chat[key] < 0 || chat[key] > 1)
      )
        throw invalid();
    if (chat.parallel_tool_calls !== undefined && typeof chat.parallel_tool_calls !== 'boolean')
      throw invalid();
    // Service tiers have different provider semantics and need their own policy.
    if (body.service_tier !== undefined || chat.service_tier !== undefined) throw invalid();
    if (kind === 'responses') {
      for (const key of ['temperature', 'top_p', 'parallel_tool_calls'])
        if (chat[key] !== body[key]) throw invalid();
      if ((chat.max_completion_tokens ?? chat.max_tokens) !== body.max_output_tokens)
        throw invalid();
    }
    const before = sourceProjection(kind, body);
    sameRecoveryHistoryProjection(before, clientProjection('chat', chat), historyFormat);
    const expectedLimit = chat.max_completion_tokens ?? chat.max_tokens ?? 4096;
    const expectedSampling = { temperature: chat.temperature, top_p: chat.top_p };
    const choice =
      chat.parallel_tool_calls === undefined
        ? undefined
        : { type: 'auto', disable_parallel_tool_use: !chat.parallel_tool_calls };
    const expectedTools = normalizeCompactionData(
      (chat.tools ?? []).map(({ function: fn }) => ({
        name: fn.name,
        description: fn.description ?? '',
        input_schema: fn.parameters,
        ...(fn.strict !== undefined ? { strict: fn.strict } : {}),
      })),
      MAX_WIRE_BYTES
    );
    const converted = { ...encode(chat, model, { nativeContextManagement: true }), stream: false };
    fields(converted, [
      'model',
      'messages',
      'system',
      'max_tokens',
      'temperature',
      'top_p',
      'stream',
      'tools',
      'tool_choice',
    ]);
    if (converted.model !== model || converted.max_tokens !== expectedLimit) throw invalid();
    for (const key of ['temperature', 'top_p'])
      if (converted[key] !== expectedSampling[key]) throw invalid();
    same(converted.tool_choice ?? null, choice ?? null);
    same(converted.tools ?? [], expectedTools);
    validateHistory('claude', converted);
    const system = converted.system;
    if (
      system !== undefined &&
      !string(system) &&
      (!Array.isArray(system) ||
        system.some(
          (block) =>
            !block ||
            block.type !== 'text' ||
            !string(block.text) ||
            Object.keys(block).some((key) => !['type', 'text'].includes(key))
        ))
    )
      throw invalid();
    const after = clientProjection('claude', {
      ...converted,
      system: string(system) ? system : (system ?? []).map((block) => block.text).join('\n'),
    });
    sameRecoveryHistoryProjection(before, after, historyFormat);
    return normalizeRecoveryRequestBody('claude', converted, historyFormat);
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
      const source = decodeContextRecoveryEnvelope('claude', result.wire, result.stream);
      decodeContextRecoveryResponse('claude', result.wire, result.stream);
      if (!source.content.length) throw invalid();
      validateHistory('claude', { messages: [{ role: 'assistant', content: source.content }] });
      const before = responseProjection(
        clientProjection(
          'claude',
          { messages: [{ role: 'assistant', content: source.content }] },
          { allowPending: true }
        ).events
      );
      const chat = decode(source, model);
      decodeContextRecoveryResponse('chat', Buffer.from(JSON.stringify(chat)), false);
      same(
        before,
        responseProjection(
          clientProjection('chat', { messages: [chat.choices[0].message] }, { allowPending: true })
            .events
        )
      );
      const response = kind === 'chat' ? chat : converters.openAIChatToResponses(chat, model);
      const wire = Buffer.from(JSON.stringify(response));
      decodeContextRecoveryResponse(kind, wire, false);
      if (kind === 'responses')
        same(before, responseProjection(responseEvents(response.output, { assistantOnly: true })));
      return { statusCode: 200, stream: false, wire };
    };
  }
  return { upstreamKind: 'claude', encodeRequest, createDispatch };
}

module.exports = { createContextRecoveryMessagesConversion };
