'use strict';
const { parseDataUrl } = require('./multimodal-content');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonblank = (value) => typeof value === 'string' && value.trim().length > 0;
const types = new Set([
  'message',
  'function_call',
  'function_call_output',
  'reasoning',
  'custom_tool_call',
  'custom_tool_call_output',
  'web_search_call',
]);
function validateDeepSeekResponsesInput(input, reject) {
  if (input == null || typeof input === 'string') return;
  if (!Array.isArray(input) || input.length > 4096) reject('input');
  const calls = new Map();
  const completed = new Set();
  let parts = 0;
  function argumentsObject(value) {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      reject('input.function_call');
    }
    if (!record(parsed)) reject('input.function_call');
    let nodes = 0;
    function visit(node, depth) {
      if (++nodes > 10000 || depth > 64) reject('input.function_call');
      if (typeof node === 'number' && !Number.isFinite(node)) reject('input.function_call');
      if (node == null || typeof node !== 'object') return;
      for (const [key, child] of Object.entries(node)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) reject('input.function_call');
        visit(child, depth + 1);
      }
    }
    visit(parsed, 0);
  }
  function image(part, field) {
    const url = part.image_url != null,
      file = part.file_id != null;
    if (url === file || (url && !nonblank(part.image_url)) || (file && !nonblank(part.file_id)))
      reject(field);
    if (part.detail != null && !['low', 'high', 'original', 'auto'].includes(part.detail))
      reject(field);
    if (file) {
      if (!part.file_id.startsWith('file-api-') || !nonblank(part.file_id.slice(9))) reject(field);
      for (const character of part.file_id)
        if (character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127) reject(field);
      return;
    }
    const value = part.image_url;
    if (value.toLowerCase().startsWith('data:')) {
      if (!parseDataUrl(value, 'image').ok) reject(field);
      return;
    }
    if (value.length > 8192) reject(field);
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      reject(field);
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    )
      reject(field);
    for (const character of value)
      if (character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127) reject(field);
  }
  function content(value, field, allowImages, textTypes) {
    if (typeof value === 'string') return;
    if (!Array.isArray(value) || value.length > 4096) reject(field);
    for (const part of value) {
      if (++parts > 4096 || !record(part)) reject(field);
      if (textTypes.includes(part.type)) {
        if (typeof part.text !== 'string') reject(field);
      } else if (part.type === 'input_image' && allowImages) image(part, field);
      else reject(field);
    }
  }
  for (const item of input) {
    if (!record(item) || (item.type != null && !types.has(item.type))) reject('input');
    const type = item.type || 'message';
    if (type === 'message') {
      if (!['user', 'assistant', 'system', 'developer'].includes(item.role))
        reject('input.message.role');
      content(item.content, 'input.message.content', ['user', 'developer'].includes(item.role), [
        'input_text',
        'output_text',
      ]);
    } else if (type === 'function_call' || type === 'custom_tool_call') {
      const custom = type === 'custom_tool_call';
      if (
        !nonblank(item.call_id) ||
        !nonblank(item.name) ||
        calls.has(item.call_id) ||
        typeof (custom ? item.input : item.arguments) !== 'string' ||
        (custom && item.name !== 'apply_patch')
      )
        reject('input.' + type);
      calls.set(item.call_id, custom ? 'custom' : 'function');
      if (!custom) argumentsObject(item.arguments);
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const custom = type === 'custom_tool_call_output';
      if (
        !nonblank(item.call_id) ||
        calls.get(item.call_id) !== (custom ? 'custom' : 'function') ||
        completed.has(item.call_id)
      )
        reject('input.' + type);
      content(item.output, 'input.' + type, true, ['input_text', 'output_text']);
      completed.add(item.call_id);
    } else if (type === 'reasoning') {
      if (
        item.encrypted_content != null ||
        (item.summary != null && (!Array.isArray(item.summary) || item.summary.length !== 0))
      )
        reject('input.reasoning');
      if (item.content != null) content(item.content, 'input.reasoning', false, ['reasoning_text']);
    } else if (item.action != null && !record(item.action)) reject('input.web_search_call');
  }
}
module.exports = { validateDeepSeekResponsesInput };
