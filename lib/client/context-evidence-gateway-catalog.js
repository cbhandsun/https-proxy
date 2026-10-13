'use strict';

const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/ajv');
const { ToolSchema, ListToolsResultSchema } = require('@modelcontextprotocol/sdk/types.js');
const safeRegex = require('safe-regex2');
const { normalizeCompactionData } = require('../proxy/context-compaction-envelope');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateSchemaSafety(schema, depth = 0) {
  if (depth > 32) throw new TypeError('Invalid evidence gateway schema');
  if (!schema || typeof schema !== 'object') return;
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'pattern' && (typeof value !== 'string' || value.length > 256 || !safeRegex(value)))
      throw new TypeError('Invalid evidence gateway schema');
    if (key === 'patternProperties' && record(value))
      for (const pattern of Object.keys(value))
        if (pattern.length > 256 || !safeRegex(pattern))
          throw new TypeError('Invalid evidence gateway schema');
    if (
      ['$ref', '$dynamicRef', '$recursiveRef'].includes(key) &&
      (typeof value !== 'string' || !value.startsWith('#'))
    )
      throw new TypeError('Invalid evidence gateway schema');
    if (value && typeof value === 'object') validateSchemaSafety(value, depth + 1);
  }
}

function buildEvidenceGatewayCatalog(value, reserved) {
  const definitions = normalizeCompactionData(value, 2 * 1024 * 1024);
  if (!Array.isArray(definitions) || definitions.length > 512)
    throw new TypeError('Invalid evidence gateway catalog');
  const byName = new Map();
  for (const tool of definitions) {
    if (
      !record(tool) ||
      typeof tool.name !== 'string' ||
      !/^[a-zA-Z0-9_.:-]{1,128}$/.test(tool.name) ||
      reserved.has(tool.name) ||
      byName.has(tool.name) ||
      !record(tool.inputSchema) ||
      tool.inputSchema.type !== 'object' ||
      !ToolSchema.safeParse(tool).success
    )
      throw new TypeError('Invalid evidence gateway catalog');
    try {
      validateSchemaSafety(tool.inputSchema);
      if (tool.outputSchema) validateSchemaSafety(tool.outputSchema);
      if (tool.execution?.taskSupport === 'required') throw new TypeError('unsupported');
      const validator = new AjvJsonSchemaValidator();
      byName.set(tool.name, {
        definition: tool,
        input: validator.getValidator(tool.inputSchema),
        output: tool.outputSchema ? validator.getValidator(tool.outputSchema) : null,
      });
    } catch {
      throw new TypeError('Invalid evidence gateway schema');
    }
    if (tool.execution?.taskSupport === 'optional') tool.execution.taskSupport = 'forbidden';
  }
  return { definitions, byName };
}

// No Client.listTools: it compiles output schemas before our safety checks.
// One deadline bounds the entire page walk, rather than 60 seconds per page.
async function loadEvidenceGatewayCatalog(downstream, signal, now = Date.now) {
  const unavailable = () => new Error('gateway_catalog_unavailable');
  let previous;
  let deadline;
  const tools = [];
  let cursor;
  const cursors = new Set();
  try {
    previous = now();
    if (
      !Number.isSafeInteger(previous) ||
      previous < 0 ||
      previous > Number.MAX_SAFE_INTEGER - 60000
    )
      throw unavailable();
    deadline = previous + 60000;
    for (let page = 0; page < 16; page++) {
      const time = now();
      if (!Number.isSafeInteger(time) || time < previous || time >= deadline || signal?.aborted)
        throw unavailable();
      previous = time;
      const result = normalizeCompactionData(
        await downstream.request(
          { method: 'tools/list', params: cursor === undefined ? {} : { cursor } },
          ListToolsResultSchema,
          { timeout: deadline - time, ...(signal ? { signal } : {}) }
        ),
        2 * 1024 * 1024
      );
      const receivedAt = now();
      if (
        !Number.isSafeInteger(receivedAt) ||
        receivedAt < previous ||
        receivedAt >= deadline ||
        signal?.aborted ||
        !result ||
        !Array.isArray(result.tools) ||
        tools.length + result.tools.length > 512
      )
        throw unavailable();
      previous = receivedAt;
      tools.push(...result.tools);
      if (result.nextCursor === undefined) return tools;
      if (
        typeof result.nextCursor !== 'string' ||
        result.nextCursor.length === 0 ||
        result.nextCursor.length > 4096 ||
        cursors.has(result.nextCursor)
      )
        throw unavailable();
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
  } catch {
    throw unavailable();
  }
  throw unavailable();
}

module.exports = { buildEvidenceGatewayCatalog, loadEvidenceGatewayCatalog };
