'use strict';

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new TypeError('Unsupported recovery conversion');
const string = (value) => typeof value === 'string';
const identity = (value) => string(value) && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);

function fields(value, allowed) {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw invalid();
}

function textContent(content, kind) {
  if (string(content)) return;
  if (!Array.isArray(content)) throw invalid();
  for (const block of content) {
    fields(block, ['type', 'text', ...(kind === 'responses' ? ['annotations'] : [])]);
    if (
      !['text', 'input_text', 'output_text'].includes(block.type) ||
      !string(block.text) ||
      (block.annotations !== undefined &&
        (!Array.isArray(block.annotations) || block.annotations.length))
    )
      throw invalid();
  }
}

function validateHistory(kind, body, { allowToolErrors = false } = {}) {
  const history = kind === 'responses' ? body.input : body.messages;
  if (kind === 'responses' && string(history)) return;
  if (!Array.isArray(history) || !history.length) throw invalid();
  for (const item of history) {
    if (kind === 'chat') {
      fields(item, ['role', 'content', 'tool_calls', 'tool_call_id']);
      if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(item.role))
        throw invalid();
      if (item.role === 'tool') {
        if (!identity(item.tool_call_id) || !string(item.content) || item.tool_calls !== undefined)
          throw invalid();
      } else {
        if (item.tool_call_id !== undefined) throw invalid();
        if (item.content !== null && item.content !== undefined) textContent(item.content, 'chat');
        else if (item.role !== 'assistant' || !item.tool_calls?.length) throw invalid();
        if (item.tool_calls !== undefined) {
          if (item.role !== 'assistant') throw invalid();
          validateChatCalls(item.tool_calls);
        }
      }
    } else if (kind === 'responses') {
      if (item?.type === 'function_call') {
        fields(item, ['type', 'id', 'call_id', 'name', 'arguments', 'status']);
        if (
          !identity(item.call_id) ||
          !identity(item.name) ||
          !string(item.arguments) ||
          !record(JSON.parse(item.arguments)) ||
          (item.status !== undefined && item.status !== 'completed')
        )
          throw invalid();
      } else if (item?.type === 'function_call_output') {
        fields(item, ['type', 'id', 'call_id', 'output']);
        if (!identity(item.call_id) || !string(item.output)) throw invalid();
      } else {
        fields(item, ['type', 'id', 'role', 'content', 'status']);
        if (
          (item.type !== undefined && item.type !== 'message') ||
          !['user', 'assistant', 'system', 'developer'].includes(item.role) ||
          (item.status !== undefined && item.status !== 'completed')
        )
          throw invalid();
        textContent(item.content, kind);
      }
    } else {
      fields(item, ['role', 'content']);
      if (!['user', 'assistant'].includes(item.role)) throw invalid();
      if (string(item.content)) continue;
      if (!Array.isArray(item.content)) throw invalid();
      for (const block of item.content) {
        if (block?.type === 'tool_use') {
          fields(block, ['type', 'id', 'name', 'input']);
          if (
            item.role !== 'assistant' ||
            !identity(block.id) ||
            !identity(block.name) ||
            !record(block.input)
          )
            throw invalid();
        } else if (block?.type === 'tool_result') {
          fields(block, [
            'type',
            'tool_use_id',
            'content',
            ...(allowToolErrors ? ['is_error'] : []),
          ]);
          if (
            item.role !== 'user' ||
            !identity(block.tool_use_id) ||
            !string(block.content) ||
            (block.is_error !== undefined && typeof block.is_error !== 'boolean')
          )
            throw invalid();
        } else {
          fields(block, ['type', 'text']);
          if (block.type !== 'text' || !string(block.text)) throw invalid();
        }
      }
    }
  }
}

function validateTools(kind, tools) {
  if (tools === undefined) return;
  if (!Array.isArray(tools)) throw invalid();
  const names = new Set();
  for (const tool of tools) {
    if (kind === 'chat') {
      fields(tool, ['type', 'function']);
      if (tool.type !== 'function') throw invalid();
      fields(tool.function, ['name', 'description', 'parameters', 'strict']);
      const fn = tool.function;
      if (
        !identity(fn.name) ||
        names.has(fn.name) ||
        !record(fn.parameters) ||
        (fn.description !== undefined && !string(fn.description)) ||
        (fn.strict !== undefined && typeof fn.strict !== 'boolean')
      )
        throw invalid();
      names.add(fn.name);
      continue;
    }
    fields(
      tool,
      kind === 'responses'
        ? ['type', 'name', 'description', 'parameters', 'strict']
        : ['name', 'description', 'input_schema']
    );
    if (
      !identity(tool.name) ||
      names.has(tool.name) ||
      (kind === 'responses' && tool.type !== 'function') ||
      (tool.description !== undefined && !string(tool.description)) ||
      !record(kind === 'responses' ? tool.parameters : tool.input_schema) ||
      (tool.strict !== undefined && typeof tool.strict !== 'boolean')
    )
      throw invalid();
    names.add(tool.name);
  }
}

function validateChatCalls(calls) {
  if (!Array.isArray(calls)) throw invalid();
  const ids = new Set();
  for (const call of calls) {
    fields(call, ['id', 'type', 'function']);
    fields(call.function, ['name', 'arguments']);
    if (
      call.type !== 'function' ||
      !identity(call.id) ||
      ids.has(call.id) ||
      !identity(call.function.name) ||
      !string(call.function.arguments) ||
      !record(JSON.parse(call.function.arguments))
    )
      throw invalid();
    ids.add(call.id);
  }
}

module.exports = {
  record,
  invalid,
  string,
  identity,
  fields,
  textContent,
  validateHistory,
  validateTools,
  validateChatCalls,
};
