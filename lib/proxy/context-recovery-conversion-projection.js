'use strict';

const {
  fingerprintContextData,
  fingerprintRecoveryHistory,
} = require('./context-recovery-fingerprint');

const {
  string,
  identity,
  record,
  invalid,
  fields,
  textContent,
} = require('./context-recovery-conversion-guards');

function clientProjection(kind, body, { allowPending = false } = {}) {
  const events = [];
  const instructions = [];
  const instructionRoles = new Set();
  const text = (role, content) => {
    if (string(content)) events.push({ type: 'text', role, text: content });
    else for (const part of content ?? []) events.push({ type: 'text', role, text: part.text });
  };
  for (const message of body.messages) {
    if (kind === 'chat') {
      if (['system', 'developer'].includes(message.role)) {
        if (events.length) throw invalid();
        instructionRoles.add(message.role);
        if (instructionRoles.size > 1) throw invalid();
        instructions.push(
          string(message.content)
            ? message.content
            : message.content.map((part) => part.text).join('')
        );
      } else if (message.role === 'tool')
        events.push({
          type: 'result',
          id: message.tool_call_id,
          text: message.content,
          error: false,
        });
      else {
        text(message.role, message.content);
        for (const call of message.tool_calls ?? [])
          events.push({
            type: 'call',
            id: call.id,
            name: call.function.name,
            arguments: JSON.parse(call.function.arguments),
          });
      }
    } else {
      for (const block of string(message.content)
        ? [{ type: 'text', text: message.content }]
        : message.content) {
        if (block.type === 'text') text(message.role, block.text);
        else if (block.type === 'tool_use')
          events.push({ type: 'call', id: block.id, name: block.name, arguments: block.input });
        else
          events.push({
            type: 'result',
            id: block.tool_use_id,
            text: block.content,
            error: block.is_error === true,
          });
      }
    }
  }
  const pending = new Set();
  const seen = new Set();
  for (const event of events) {
    if (event.type === 'call') {
      if (seen.has(event.id)) throw invalid();
      seen.add(event.id);
      pending.add(event.id);
    } else if (event.type === 'result') {
      if (!pending.delete(event.id)) throw invalid();
    }
  }
  if (pending.size && !allowPending) throw invalid();
  return { instructions: kind === 'chat' ? instructions.join('\n') : (body.system ?? ''), events };
}

function responseEvents(input, { assistantOnly = false } = {}) {
  if (!Array.isArray(input)) throw invalid();
  const events = [];
  for (const item of input) {
    if (item?.type === 'message') {
      fields(item, ['type', 'id', 'role', 'content', 'status']);
      if (
        !['user', 'assistant'].includes(item.role) ||
        (assistantOnly && item.role !== 'assistant') ||
        (item.status !== undefined && item.status !== 'completed')
      )
        throw invalid();
      textContent(item.content, 'responses');
      for (const part of string(item.content) ? [{ text: item.content }] : item.content)
        events.push({ type: 'text', role: item.role, text: part.text });
    } else if (item?.type === 'function_call') {
      fields(item, ['type', 'id', 'call_id', 'name', 'arguments', 'status']);
      if (
        !identity(item.call_id) ||
        !identity(item.name) ||
        !string(item.arguments) ||
        !record(JSON.parse(item.arguments)) ||
        (item.status !== undefined && item.status !== 'completed')
      )
        throw invalid();
      events.push({
        type: 'call',
        id: item.call_id,
        name: item.name,
        arguments: JSON.parse(item.arguments),
      });
    } else if (item?.type === 'function_call_output' && !assistantOnly) {
      fields(item, ['type', 'call_id', 'output', 'status']);
      if (
        !identity(item.call_id) ||
        !string(item.output) ||
        (item.status !== undefined && item.status !== 'error')
      )
        throw invalid();
      events.push({
        type: 'result',
        id: item.call_id,
        text: item.output,
        error: item.status === 'error',
      });
    } else throw invalid();
  }
  return events;
}

// Request projections are derived from already admitted histories. Keep policy
// equality small while applying the binding's aggregate budget to event arrays.
// Response projections continue using their independent original small budget.
function sameRecoveryHistoryProjection(left, right, historyFormat = 2) {
  if (
    fingerprintContextData(left.instructions) !== fingerprintContextData(right.instructions) ||
    fingerprintRecoveryHistory(left.events, historyFormat) !==
      fingerprintRecoveryHistory(right.events, historyFormat)
  )
    throw invalid();
}

module.exports = { clientProjection, responseEvents, sameRecoveryHistoryProjection };
