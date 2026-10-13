'use strict';
const { toolArgumentsComplete } = require('./protocol-tool-completion');
const { collectCustomToolNames } = require('./responses-custom-tools');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function jsonObjectRequested(source) {
  const request = source?.responsesRequest || source;
  return (
    request?.response_format?.type === 'json_object' ||
    request?.text?.format?.type === 'json_object'
  );
}
function invalidOutput() {
  const error = new TypeError('Upstream completed JSON-object output is invalid');
  error.code = 'upstream_invalid_json_object';
  throw error;
}
function assertObjectText(text, maxBytes) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > maxBytes) invalidOutput();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    invalidOutput();
  }
  if (!record(value)) invalidOutput();
}
function assertJsonObjectCompletion(payload, kind, source, { maxBytes = 16 * 1024 * 1024 } = {}) {
  if (!jsonObjectRequested(source)) return;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new TypeError('Invalid JSON-object output byte limit');
  if (!record(payload)) invalidOutput();
  const request = source?.responsesRequest || source;
  const customNames = collectCustomToolNames(request);
  if (kind === 'chat') {
    if (!Array.isArray(payload.choices) || !payload.choices.length) invalidOutput();
    for (const choice of payload.choices) {
      if (
        !['stop', 'tool_calls', 'function_call', 'length', 'content_filter'].includes(
          choice?.finish_reason
        )
      )
        invalidOutput();
      if (['length', 'content_filter'].includes(choice?.finish_reason)) continue;
      const message = choice?.message;
      if (!record(message)) invalidOutput();
      if (typeof message.refusal === 'string' && message.refusal.trim()) continue;
      if (choice.finish_reason === 'function_call') {
        if (
          typeof message.function_call?.name !== 'string' ||
          !message.function_call.name ||
          !toolArgumentsComplete({ function: message.function_call }, customNames)
        )
          invalidOutput();
        continue;
      }
      if (
        choice.finish_reason === 'tool_calls' &&
        Array.isArray(message.tool_calls) &&
        message.tool_calls.length
      ) {
        if (
          !message.tool_calls.every(
            (call) =>
              typeof call?.id === 'string' &&
              call.id &&
              typeof call?.function?.name === 'string' &&
              call.function.name &&
              toolArgumentsComplete(call, customNames)
          )
        )
          invalidOutput();
        continue;
      }
      const text =
        typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.content) &&
              message.content.every((part) => typeof part?.text === 'string')
            ? message.content.map((part) => part.text).join('')
            : null;
      assertObjectText(text, maxBytes);
    }
    return;
  }
  if (kind !== 'responses') throw new TypeError('Unsupported JSON-object completion protocol');
  if (payload.status === 'failed' || payload.status === 'incomplete') return;
  if (payload.status !== 'completed' || !Array.isArray(payload.output)) invalidOutput();
  const texts = [];
  let tool = false;
  let refusal = false;
  for (const item of payload.output) {
    if (!record(item)) invalidOutput();
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      if (
        item.status === 'incomplete' ||
        typeof item.call_id !== 'string' ||
        !item.call_id ||
        typeof item.name !== 'string' ||
        !item.name
      )
        invalidOutput();
      if (item.type === 'custom_tool_call') {
        if (typeof item.input !== 'string' || Buffer.byteLength(item.input) > maxBytes)
          invalidOutput();
      } else if (
        !toolArgumentsComplete(
          { function: { name: item.name, arguments: item.arguments } },
          customNames
        )
      )
        invalidOutput();
      tool = true;
    }
    if (item.type === 'message') {
      if (!Array.isArray(item.content)) invalidOutput();
      for (const part of item.content) {
        if (part?.type === 'refusal' && typeof part.refusal === 'string' && part.refusal.trim())
          refusal = true;
        else if (part?.type === 'output_text' && typeof part.text === 'string')
          texts.push(part.text);
        else invalidOutput();
      }
    }
  }
  if (!tool && !refusal) assertObjectText(texts.join(''), maxBytes);
}
module.exports = { jsonObjectRequested, assertJsonObjectCompletion };
