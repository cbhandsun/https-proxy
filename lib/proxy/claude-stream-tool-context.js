'use strict';

const { types } = require('node:util');
const { functionToolContract } = require('./function-tool-contract');

// Admit declarations only from this request's bounded, decoded JSON snapshot.
// An absent or invalid declaration supplies no authority for empty tool input.
function claudeStreamToolDeclarations(buffer, maxBytes) {
  if (
    types.isProxy(buffer) ||
    !Buffer.isBuffer(buffer) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    buffer.length > maxBytes
  )
    return [];
  let body;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } catch (error) {
    if (error instanceof SyntaxError || error?.code === 'ERR_ENCODING_INVALID_ENCODED_DATA')
      return [];
    throw error;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.tools == null) return [];
  if (!Array.isArray(body.tools)) return [];
  const result = [];
  const names = new Set();
  for (const tool of body.tools) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return [];
    // Server-side tools do not declare client-executable function calls.
    if (tool.type !== undefined && tool.type !== 'custom') continue;
    let contract;
    try {
      contract = functionToolContract(tool, 'input_schema');
    } catch (error) {
      if (error?.code === 'invalid_request_error') return [];
      throw error;
    }
    if (names.has(tool.name)) return [];
    names.add(tool.name);
    result.push(Object.freeze({ name: tool.name, input_schema: contract.input_schema }));
  }
  return Object.freeze(result);
}

module.exports = { claudeStreamToolDeclarations };
