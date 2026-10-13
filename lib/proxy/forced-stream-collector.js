'use strict';

const { StringDecoder } = require('string_decoder');

class UpstreamStreamPayloadError extends Error {
  constructor(payload) {
    super('Upstream SSE returned an error payload');
    this.name = 'UpstreamStreamPayloadError';
    this.payload = payload;
  }
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function createSseJsonDecoder(maxBytes, onPayload) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes must be a positive safe integer');
  }

  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let bytes = 0;
  let done = false;

  function parseEvent(block) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return;
    if (data === '[DONE]') {
      done = true;
      return;
    }
    let payload;
    try {
      payload = JSON.parse(data);
    } catch (error) {
      throw new Error('Upstream SSE contained an invalid JSON data payload', { cause: error });
    }
    if (!isObject(payload)) {
      throw new Error('Upstream SSE JSON data payload must be an object');
    }
    onPayload(payload);
  }

  function drain(complete) {
    while (buffer) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      parseEvent(block);
    }
    if (complete && buffer.trim()) {
      const block = buffer;
      buffer = '';
      parseEvent(block);
    }
  }

  return {
    push(chunk) {
      const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += chunkBuffer.length;
      if (bytes > maxBytes) {
        buffer = '';
        throw new Error(`Upstream SSE response exceeds proxy limit of ${maxBytes} bytes`);
      }
      buffer += decoder.write(chunkBuffer);
      drain(false);
    },
    finish() {
      buffer += decoder.end();
      drain(true);
      return { bytes, done };
    },
  };
}

function mergeTextField(target, source, name) {
  if (typeof source[name] === 'string') target[name] = (target[name] || '') + source[name];
}

// Some chat-compatible providers emit an empty deprecated function_call object
// on ordinary text deltas. Only this exact no-data sentinel is absent. Unknown
// fields, invalid values and a terminal function_call signal remain observable
// so downstream no-tool validation cannot silently accept a malformed call.
function emptyLegacyFunctionCallDelta(value) {
  return (
    isObject(value) &&
    Object.keys(value).every((key) => ['name', 'arguments'].includes(key)) &&
    ['name', 'arguments'].every((key) => value[key] == null || value[key] === '')
  );
}

function mergeToolCalls(choice, deltas) {
  if (!Array.isArray(deltas)) return;
  for (let position = 0; position < deltas.length; position += 1) {
    const delta = deltas[position];
    if (!isObject(delta)) continue;
    const index = Number.isSafeInteger(delta.index) && delta.index >= 0 ? delta.index : position;
    const tool = choice.toolCalls.get(index) || {
      index,
      id: '',
      type: 'function',
      function: { name: '', arguments: '' },
    };
    if (typeof delta.id === 'string') tool.id += delta.id;
    if (typeof delta.type === 'string') tool.type = delta.type;
    if (isObject(delta.function)) {
      mergeTextField(tool.function, delta.function, 'name');
      mergeTextField(tool.function, delta.function, 'arguments');
    }
    choice.toolCalls.set(index, tool);
  }
}

function createChatCompletionCollector(maxBytes) {
  const metadata = {};
  const choices = new Map();
  let usage;
  let directCompletion;
  let errorPayload;

  function choiceState(index) {
    const existing = choices.get(index);
    if (existing) return existing;
    const created = {
      index,
      role: 'assistant',
      content: '',
      contentSeen: false,
      reasoningContent: '',
      refusal: '',
      finishReason: null,
      toolCalls: new Map(),
      functionCall: { name: '', arguments: '' },
      functionCallSeen: false,
    };
    choices.set(index, created);
    return created;
  }

  const decoder = createSseJsonDecoder(maxBytes, (payload) => {
    if (isObject(payload.error)) {
      errorPayload = payload;
      return;
    }
    if (payload.object === 'chat.completion' && Array.isArray(payload.choices)) {
      directCompletion = payload;
      return;
    }
    for (const name of ['id', 'created', 'model', 'system_fingerprint', 'service_tier']) {
      if (payload[name] != null) metadata[name] = payload[name];
    }
    if (isObject(payload.usage)) usage = payload.usage;
    if (!Array.isArray(payload.choices)) return;
    for (let position = 0; position < payload.choices.length; position += 1) {
      const incoming = payload.choices[position];
      if (!isObject(incoming)) continue;
      const index = Number.isSafeInteger(incoming.index) ? incoming.index : position;
      const choice = choiceState(index);
      const delta = isObject(incoming.delta)
        ? incoming.delta
        : isObject(incoming.message)
          ? incoming.message
          : {};
      if (typeof delta.role === 'string') choice.role = delta.role;
      if (typeof delta.content === 'string') {
        choice.content += delta.content;
        choice.contentSeen = true;
      }
      if (typeof delta.reasoning_content === 'string') {
        choice.reasoningContent += delta.reasoning_content;
      }
      if (typeof delta.refusal === 'string') choice.refusal += delta.refusal;
      mergeToolCalls(choice, delta.tool_calls);
      if (delta.function_call != null && !emptyLegacyFunctionCallDelta(delta.function_call)) {
        choice.functionCallSeen = true;
        if (isObject(delta.function_call)) {
          mergeTextField(choice.functionCall, delta.function_call, 'name');
          mergeTextField(choice.functionCall, delta.function_call, 'arguments');
        }
      }
      if (incoming.finish_reason === 'function_call') choice.functionCallSeen = true;
      if (incoming.finish_reason != null) choice.finishReason = incoming.finish_reason;
    }
  });

  return {
    push: decoder.push,
    finish() {
      const stream = decoder.finish();
      if (errorPayload) throw new UpstreamStreamPayloadError(errorPayload);
      if (directCompletion) return directCompletion;
      if (choices.size === 0) {
        throw new Error('Upstream SSE did not contain a chat completion');
      }
      if (!stream.done && ![...choices.values()].some((choice) => choice.finishReason != null)) {
        throw new Error('Upstream chat completion SSE ended before a terminal event');
      }
      const result = {
        ...metadata,
        object: 'chat.completion',
        choices: [...choices.values()]
          .sort((left, right) => left.index - right.index)
          .map((choice) => {
            const message = {
              role: choice.role,
              content: choice.contentSeen ? choice.content : null,
            };
            if (choice.reasoningContent) message.reasoning_content = choice.reasoningContent;
            if (choice.refusal) message.refusal = choice.refusal;
            if (choice.toolCalls.size > 0) {
              message.tool_calls = [...choice.toolCalls.values()]
                .sort((left, right) => left.index - right.index)
                .map(({ index: _index, ...tool }) => tool);
            }
            if (choice.functionCallSeen) message.function_call = choice.functionCall;
            return { index: choice.index, message, finish_reason: choice.finishReason };
          }),
      };
      if (usage) result.usage = usage;
      return result;
    },
  };
}

function createResponsesCollector(maxBytes) {
  let completedResponse;
  let terminalResponseReceived = false;
  let errorPayload;
  const completedItems = new Map();
  const decoder = createSseJsonDecoder(maxBytes, (payload) => {
    if (terminalResponseReceived)
      throw new Error('Upstream SSE contained data after its terminal response');
    if (payload.type === 'response.output_item.done') {
      const index = payload.output_index;
      if (!Number.isSafeInteger(index) || index < 0 || index >= 4096 || !isObject(payload.item))
        throw new Error('Upstream SSE contained an invalid completed output item');
      const previous = completedItems.get(index);
      if (previous && JSON.stringify(previous) !== JSON.stringify(payload.item))
        throw new Error('Upstream SSE contained conflicting completed output items');
      completedItems.set(index, payload.item);
      return;
    }
    if (isObject(payload.error) && !isObject(payload.response)) {
      errorPayload = payload;
      return;
    }
    if (isObject(payload.response)) {
      completedResponse = payload.response;
      terminalResponseReceived = [
        'response.completed',
        'response.incomplete',
        'response.failed',
      ].includes(payload.type);
      if (
        terminalResponseReceived &&
        completedResponse.status !== payload.type.slice('response.'.length)
      )
        throw new Error('Upstream SSE contained a conflicting terminal status');
    } else if (payload.object === 'response') {
      completedResponse = payload;
      terminalResponseReceived = ['completed', 'incomplete', 'failed'].includes(payload.status);
    }
  });
  return {
    push: decoder.push,
    discard() {
      completedItems.clear();
      completedResponse = undefined;
      errorPayload = undefined;
      terminalResponseReceived = false;
    },
    finish() {
      decoder.finish();
      if (errorPayload) throw new UpstreamStreamPayloadError(errorPayload);
      if (!completedResponse || !terminalResponseReceived) {
        throw new Error('Upstream SSE did not contain a terminal response');
      }
      if (completedResponse.output != null && !Array.isArray(completedResponse.output))
        throw new Error('Upstream SSE contained an invalid terminal output');
      let result = completedResponse;
      if (
        !completedResponse.output?.length &&
        completedItems.size &&
        ['completed', 'incomplete'].includes(completedResponse.status)
      ) {
        const output = [...completedItems.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, item]) => item)
          .filter(
            (item) =>
              completedResponse.status === 'completed' ||
              ['message', 'reasoning'].includes(item.type)
          );
        result = { ...completedResponse, output };
      }
      completedItems.clear();
      return result;
    },
  };
}

function collapseForcedStreamResponse(options) {
  const {
    clientRes,
    headers: upstreamHeaders,
    kind,
    maxBytes,
    onComplete = () => {},
    onFailure = () => {},
    proxyRes,
    sendJsonError,
    statusCode,
  } = options || {};
  if (!clientRes || !proxyRes || typeof sendJsonError !== 'function') {
    throw new TypeError(
      'Forced stream response bridge requires response streams and sendJsonError'
    );
  }
  const collector =
    kind === 'chat'
      ? createChatCompletionCollector(maxBytes)
      : kind === 'responses'
        ? createResponsesCollector(maxBytes)
        : null;
  if (!collector) throw new TypeError('Forced stream response kind must be chat or responses');

  let settled = false;
  function fail(error) {
    if (settled) return;
    settled = true;
    if (typeof collector.discard === 'function') collector.discard();
    const responseStatus =
      error instanceof UpstreamStreamPayloadError && statusCode >= 400 ? statusCode : 502;
    const payload =
      error instanceof UpstreamStreamPayloadError
        ? error.payload
        : {
            error: {
              type: 'proxy_error',
              message: 'Upstream stream response could not be collected',
            },
          };
    sendJsonError(clientRes, responseStatus, payload);
    onFailure(responseStatus);
  }

  proxyRes.on('data', (chunk) => {
    if (settled) return;
    try {
      collector.push(chunk);
    } catch (error) {
      if (typeof proxyRes.destroy === 'function') proxyRes.destroy();
      fail(error);
    }
  });
  proxyRes.on('end', () => {
    if (settled) return;
    try {
      const body = JSON.stringify(collector.finish());
      const headers = { ...(upstreamHeaders || {}) };
      delete headers['content-encoding'];
      delete headers['transfer-encoding'];
      headers['content-type'] = 'application/json; charset=utf-8';
      headers['content-length'] = Buffer.byteLength(body);
      settled = true;
      clientRes.writeHead(statusCode, headers);
      clientRes.end(body);
      onComplete(statusCode);
    } catch (error) {
      fail(error);
    }
  });
  proxyRes.on('error', fail);
}

module.exports = {
  UpstreamStreamPayloadError,
  collapseForcedStreamResponse,
  createChatCompletionCollector,
  createResponsesCollector,
  createSseJsonDecoder,
};
