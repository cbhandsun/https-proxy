'use strict';

const { randomUUID } = require('node:crypto');
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
  record,
  string,
  identity,
  invalid,
  validateHistory,
  validateTools,
} = require('./context-recovery-conversion-guards');
const { createSseJsonDecoder } = require('./forced-stream-collector');
const { decodeContextRecoveryResponse } = require('./context-recovery-protocol');
const { geminiToolId } = require('./gemini-tool-id');

const PLACEHOLDER_SIGNATURE = 'context_engineering_is_the_way_to_go';
function same(a, b) {
  if (fingerprintContextData(a) !== fingerprintContextData(b)) throw invalid();
}

function geminiEvents(contents) {
  if (!Array.isArray(contents)) throw invalid();
  const events = [];
  const callNames = new Map();
  for (const content of contents) {
    fields(content, ['role', 'parts']);
    if (!['user', 'model'].includes(content.role) || !Array.isArray(content.parts)) throw invalid();
    for (const part of content.parts) {
      if (part?.text !== undefined) {
        fields(part, ['text']);
        if (!string(part.text)) throw invalid();
        events.push({
          type: 'text',
          role: content.role === 'model' ? 'assistant' : 'user',
          text: part.text,
        });
      } else if (part?.functionCall) {
        fields(part, ['functionCall', 'thoughtSignature']);
        fields(part.functionCall, ['id', 'name', 'args']);
        const call = part.functionCall;
        if (
          content.role !== 'model' ||
          !identity(call.id) ||
          !identity(call.name) ||
          !record(call.args) ||
          (part.thoughtSignature !== undefined && part.thoughtSignature !== PLACEHOLDER_SIGNATURE)
        )
          throw invalid();
        events.push({ type: 'call', id: call.id, name: call.name, arguments: call.args });
        if (callNames.has(call.id)) throw invalid();
        callNames.set(call.id, call.name);
      } else if (part?.functionResponse) {
        fields(part, ['functionResponse']);
        const result = part.functionResponse;
        fields(result, ['id', 'name', 'response']);
        fields(result.response, ['content']);
        if (
          content.role !== 'user' ||
          !identity(result.id) ||
          !identity(result.name) ||
          !string(result.response.content) ||
          callNames.get(result.id) !== result.name
        )
          throw invalid();
        events.push({ type: 'result', id: result.id, text: result.response.content, error: false });
      } else throw invalid();
    }
  }
  return events;
}

function collapsed(events) {
  let text = '';
  const calls = [];
  for (const event of events) {
    if (event.type === 'text') {
      if (calls.length) throw invalid();
      text += event.text;
    } else calls.push(event);
  }
  return { text, calls };
}

function decodeGemini(wire, stream) {
  if (!Buffer.isBuffer(wire) || wire.length > MAX_WIRE_BYTES) throw invalid();
  const text = wire.toString('utf8');
  if (!Buffer.from(text).equals(wire)) throw invalid();
  const parts = [];
  let stopped = false;
  let usage;
  function accept(frame) {
    const value = normalizeCompactionData(frame, MAX_WIRE_BYTES);
    fields(value, ['candidates', 'usageMetadata', 'modelVersion', 'responseId', 'createTime']);
    if (value.usageMetadata !== undefined) {
      if (!record(value.usageMetadata)) throw invalid();
      for (const key of [
        'promptTokenCount',
        'candidatesTokenCount',
        'thoughtsTokenCount',
        'totalTokenCount',
        'cachedContentTokenCount',
      ]) {
        const count = value.usageMetadata[key];
        if (
          count !== undefined &&
          (!Number.isSafeInteger(count) || count < 0 || count > 1000000000)
        )
          throw invalid();
      }
      usage = { ...usage, ...value.usageMetadata };
    }
    if (value.candidates === undefined && value.usageMetadata !== undefined) return;
    if (stopped || !Array.isArray(value.candidates) || value.candidates.length !== 1)
      throw invalid();
    const candidate = value.candidates[0];
    fields(candidate, ['content', 'finishReason', 'index', 'safetyRatings', 'avgLogprobs']);
    if (candidate.index !== undefined && candidate.index !== 0) throw invalid();
    if (candidate.content !== undefined) {
      fields(candidate.content, ['role', 'parts']);
      if (
        ![undefined, 'model'].includes(candidate.content.role) ||
        !Array.isArray(candidate.content.parts)
      )
        throw invalid();
      for (const part of candidate.content.parts) {
        if (part?.functionCall) {
          fields(part, ['functionCall']);
          fields(part.functionCall, ['id', 'name', 'args']);
          if (
            !identity(part.functionCall.name) ||
            !record(part.functionCall.args) ||
            (part.functionCall.id !== undefined && !identity(part.functionCall.id))
          )
            throw invalid();
          parts.push({
            functionCall: {
              ...part.functionCall,
              id: part.functionCall.id ?? 'hpm_gemini_' + randomUUID().replaceAll('-', ''),
            },
          });
        } else {
          fields(part, ['text']);
          if (!string(part.text)) throw invalid();
          parts.push(part);
        }
      }
    }
    if (candidate.finishReason !== undefined) {
      if (candidate.finishReason !== 'STOP') throw invalid();
      stopped = true;
    }
  }
  if (stream) {
    const decoder = createSseJsonDecoder(MAX_WIRE_BYTES, accept);
    decoder.push(text);
    decoder.finish();
  } else accept(JSON.parse(text));
  if (!stopped || !parts.length) throw invalid();
  const ids = parts.filter((x) => x.functionCall).map((x) => x.functionCall.id);
  if (new Set(ids).size !== ids.length) throw invalid();
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
    ...(usage ? { usageMetadata: usage } : {}),
  };
}

function createContextRecoveryGeminiConversion({ kind, model, converters, historyFormat = 2 }) {
  if (!['chat', 'responses', 'claude'].includes(kind)) throw invalid();
  const toChat = createContextRecoveryConversion({
    kind: kind === 'claude' ? 'claude' : 'responses',
    model,
    converters,
    historyFormat,
  });
  if (
    typeof converters?.createGeminiProtocol !== 'function' ||
    typeof converters.stableCreated !== 'function'
  )
    throw invalid();
  // Each adapter owns its provider tool cache. No shared singleton is consulted.
  const gemini = converters.createGeminiProtocol();
  if (
    typeof gemini?.tryOpenAIChatToGemini !== 'function' ||
    typeof gemini.geminiResponseToChat !== 'function'
  )
    throw invalid();

  function encodeRequest(input) {
    const body = normalizeRecoveryRequestBody(kind, input, historyFormat);
    let chat;
    if (kind === 'chat') {
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
        ![undefined, 'auto'].includes(body.tool_choice)
      )
        throw invalid();
      validateHistory(kind, body);
      validateTools(kind, body.tools);
      chat = { ...body, model };
    } else chat = toChat.encodeRequest(body);
    if (body.service_tier !== undefined || chat.service_tier !== undefined) throw invalid();
    const expectedLimit =
      body.max_completion_tokens ?? body.max_tokens ?? body.max_output_tokens ?? 4096;
    if (
      !Number.isSafeInteger(expectedLimit) ||
      expectedLimit < 1 ||
      expectedLimit > 8192 ||
      (body.max_tokens !== undefined && body.max_completion_tokens !== undefined)
    )
      throw invalid();
    for (const key of ['temperature', 'top_p']) {
      if (
        body[key] !== undefined &&
        (typeof body[key] !== 'number' ||
          body[key] < 0 ||
          body[key] > (key === 'temperature' ? 2 : 1))
      )
        throw invalid();
      if (chat[key] !== body[key]) throw invalid();
    }
    if (
      chat.parallel_tool_calls !== body.parallel_tool_calls ||
      ![undefined, true].includes(chat.parallel_tool_calls)
    )
      throw invalid();
    if (
      kind !== 'chat' &&
      (chat.max_completion_tokens ?? chat.max_tokens ?? 4096) !== expectedLimit
    )
      throw invalid();
    const before = clientProjection('chat', chat);
    if (kind === 'claude')
      sameRecoveryHistoryProjection(before, clientProjection('claude', body), historyFormat);
    if (kind === 'responses') {
      const input = string(body.input)
        ? [{ type: 'message', role: 'user', content: body.input }]
        : body.input.map((x) => (x.type === undefined ? { type: 'message', ...x } : x));
      sameRecoveryHistoryProjection(
        before,
        { instructions: body.instructions ?? '', events: responseEvents(input) },
        historyFormat
      );
    }
    const expectedTools = normalizeCompactionData(
      (chat.tools ?? []).map(({ function: fn }) => {
        if (
          fn.strict === true ||
          !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(fn.name) ||
          fn.parameters.type !== 'object'
        )
          throw invalid();
        return {
          name: fn.name,
          description: fn.description ?? '',
          parametersJsonSchema: fn.parameters,
        };
      }),
      MAX_WIRE_BYTES
    );
    const sampling = { temperature: body.temperature, topP: body.top_p };
    chat.max_tokens = expectedLimit;
    delete chat.max_completion_tokens;
    const result = gemini.tryOpenAIChatToGemini(chat, model, {}, { nativeContextManagement: true });
    const converted = { ...result?.request };
    fields(converted, ['contents', 'systemInstruction', 'tools', 'generationConfig']);
    fields(converted.generationConfig, ['maxOutputTokens', 'temperature', 'topP']);
    if (
      converted.generationConfig.maxOutputTokens !== expectedLimit ||
      converted.generationConfig.temperature !== sampling.temperature ||
      converted.generationConfig.topP !== sampling.topP
    )
      throw invalid();
    const system = converted.systemInstruction;
    if (system !== undefined) fields(system, ['parts']);
    const instructionParts = system?.parts ?? [];
    if (!Array.isArray(instructionParts)) throw invalid();
    for (const part of instructionParts) {
      fields(part, ['text']);
      if (!string(part.text)) throw invalid();
    }
    sameRecoveryHistoryProjection(
      before,
      {
        instructions: instructionParts.map((x) => x.text).join('\n'),
        events: geminiEvents(converted.contents),
      },
      historyFormat
    );
    const actualTools = converted.tools ?? [];
    if (!Array.isArray(actualTools) || (actualTools.length && actualTools.length !== 1))
      throw invalid();
    if (actualTools.length) fields(actualTools[0], ['functionDeclarations']);
    const declarations = actualTools[0]?.functionDeclarations ?? [];
    if (!Array.isArray(declarations) || declarations.length !== expectedTools.length)
      throw invalid();
    declarations.forEach((tool, index) => {
      fields(tool, ['name', 'description', 'parameters']);
      if (
        tool.name !== expectedTools[index].name ||
        tool.description !== expectedTools[index].description
      )
        throw invalid();
    });
    // The native JSON Schema field preserves constraints that the legacy Schema
    // sanitizer cannot represent. Never advertise strict enforcement by Gemini.
    if (expectedTools.length) converted.tools = [{ functionDeclarations: expectedTools }];
    return normalizeRecoveryRequestBody('gemini', converted, historyFormat);
  }

  function createDispatch(dispatch) {
    if (typeof dispatch !== 'function') throw invalid();
    return async (input, options) => {
      const request = encodeRequest(input);
      const result = await dispatch(request, options);
      if (
        result.statusCode !== 200 ||
        typeof result.stream !== 'boolean' ||
        (result.encoding && result.encoding !== 'identity')
      )
        throw invalid();
      const source = decodeGemini(result.wire, result.stream);
      const before = collapsed(geminiEvents(source.candidates.map((x) => x.content)));
      const tools = (request.tools?.[0]?.functionDeclarations ?? []).map((x) => ({
        name: x.name,
        input_schema: x.parametersJsonSchema,
      }));
      const chat = gemini.geminiResponseToChat(source, model, tools, {
        stableCreated: converters.stableCreated,
        preserveExternalToolCalls: true,
      });
      const calls = chat.choices?.[0]?.message?.tool_calls ?? [];
      if (calls.length !== before.calls.length) throw invalid();
      calls.forEach((call, index) => {
        if (call.id !== geminiToolId(before.calls[index].id)) throw invalid();
        call.id = before.calls[index].id;
      });
      decodeContextRecoveryResponse('chat', Buffer.from(JSON.stringify(chat)), false);
      same(
        before,
        collapsed(
          clientProjection('chat', { messages: [chat.choices[0].message] }, { allowPending: true })
            .events
        )
      );
      const response =
        kind === 'chat'
          ? chat
          : kind === 'responses'
            ? converters.openAIChatToResponses(chat, model)
            : converters.openAIResponseToClaudeMessage(chat, model);
      const wire = Buffer.from(JSON.stringify(response));
      decodeContextRecoveryResponse(kind, wire, false);
      const after =
        kind === 'responses'
          ? responseEvents(response.output, { assistantOnly: true })
          : clientProjection(
              kind,
              {
                messages:
                  kind === 'chat'
                    ? [chat.choices[0].message]
                    : [{ role: 'assistant', content: response.content }],
              },
              { allowPending: true }
            ).events;
      same(before, collapsed(after));
      return { statusCode: 200, stream: false, wire };
    };
  }
  return { upstreamKind: 'gemini', encodeRequest, createDispatch };
}

module.exports = { createContextRecoveryGeminiConversion };
