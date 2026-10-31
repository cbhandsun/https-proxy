'use strict';

// Experimental SDK transport only. This module neither executes commands nor
// registers itself on the production proxy's public Responses route.
const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/ajv');
const safeRegex = require('safe-regex2');
const { normalizeCompactionData } = require('./context-compaction-envelope');

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value) =>
  typeof value === 'string' &&
  /^[A-Za-z0-9_-]{1,80}$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
const fail = (code = 'tianxi_sdk_mcp_invalid') => {
  throw new Error(code);
};
function snapshot(value, limit) {
  try {
    return JSON.parse(JSON.stringify(normalizeCompactionData(value, limit)));
  } catch {
    fail();
  }
}
function schemaSafety(value, depth = 0) {
  if (depth > 16) fail();
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (
      ['__proto__', 'prototype', 'constructor', '$ref', '$dynamicRef', '$recursiveRef'].includes(
        key
      )
    )
      fail();
    if (key === 'pattern' && (typeof child !== 'string' || child.length > 256 || !safeRegex(child)))
      fail();
    if (key === 'patternProperties') fail();
    schemaSafety(child, depth + 1);
  }
}
function toolResult(value, maxBytes = 65536) {
  const result = snapshot(value, maxBytes);
  if (
    !record(result) ||
    !Array.isArray(result.content) ||
    result.content.length > 64 ||
    Object.keys(result).some((key) => !['content', 'isError'].includes(key)) ||
    (result.isError !== undefined && typeof result.isError !== 'boolean') ||
    result.content.some(
      (part) =>
        !record(part) ||
        part.type !== 'text' ||
        typeof part.text !== 'string' ||
        Object.keys(part).some((key) => !['type', 'text'].includes(key))
    )
  )
    fail();
  return result;
}

function createTianxiSdkMcpChannel({
  serverName = 'codex_native',
  tools,
  onCall,
  signal,
  timeoutMs = 30000,
  maxTimeoutMs = 120000,
  maxCalls = 32,
  maxToolResultBytes = 65536,
  maxToolsBytes = 262144,
  lenientValidation = false,
}) {
  if (
    !identifier(serverName) ||
    typeof onCall !== 'function' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > maxTimeoutMs
  )
    fail();
  const definitions = snapshot(tools, maxToolsBytes);
  if (!Array.isArray(definitions) || !definitions.length || definitions.length > 128) fail();
  const entries = new Map();
  try {
    for (const tool of definitions) {
      if (
        !record(tool) ||
        !identifier(tool.name) ||
        entries.has(tool.name) ||
        typeof tool.description !== 'string' ||
        tool.description.length > 32768 ||
        !record(tool.inputSchema) ||
        tool.inputSchema.type !== 'object' ||
        Object.keys(tool).some((key) => !['name', 'description', 'inputSchema'].includes(key))
      )
        fail();
      schemaSafety(tool.inputSchema);
      entries.set(tool.name, new AjvJsonSchemaValidator().getValidator(tool.inputSchema));
    }
  } catch {
    fail();
  }
  const requests = new Map();
  let calls = 0;
  function check() {
    if (signal?.aborted) fail('tianxi_sdk_mcp_aborted');
  }
  async function invoke(name, args) {
    check();
    let timer,
      onAbort,
      timedOut = false;
    try {
      const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('tianxi_sdk_mcp_timeout'));
        }, timeoutMs);
        onAbort = () => reject(new Error('tianxi_sdk_mcp_aborted'));
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      const value = await Promise.race([
        Promise.resolve().then(() => {
          check();
          return onCall(name, args, { signal });
        }),
        deadline,
      ]);
      check();
      return toolResult(value, maxToolResultBytes);
    } catch {
      check();
      if (timedOut) fail('tianxi_sdk_mcp_timeout');
      // No provider, client, command, path or result content in error messages.
      return { isError: true, content: [{ type: 'text', text: 'tool_execution_failed' }] };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  async function dispatch(message) {
    check();
    if (message.method === 'initialize')
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: '0.1.0' },
      };
    if (message.method === 'notifications/initialized') return {};
    if (message.method === 'ping') return {};
    if (message.method === 'tools/list') return { tools: snapshot(definitions, maxToolsBytes) };
    if (message.method !== 'tools/call') fail();
    const params = message.params;
    if (!record(params) || !entries.has(params.name) || !record(params.arguments)) {
      if (!lenientValidation) fail();
      return {
        isError: true,
        content: [{ type: 'text', text: 'Invalid tool call parameters' }],
      };
    }
    if (!entries.get(params.name)(params.arguments).valid) {
      if (!lenientValidation) fail();
      return {
        isError: true,
        content: [{ type: 'text', text: 'Invalid tool arguments' }],
      };
    }
    if (++calls > maxCalls) fail('tianxi_sdk_mcp_call_limit');
    return invoke(params.name, params.arguments);
  }
  return {
    serverName,
    allowedTools: definitions.map((tool) => `mcp__${serverName}__${tool.name}`),
    async handle(request) {
      check();
      const safe = snapshot(request, lenientValidation ? 524288 : 131072);
      if (!record(safe) || safe.server_name !== serverName || !record(safe.message)) fail();
      const message = safe.message;
      const validId =
        message.id === undefined ||
        identifier(message.id) ||
        Number.isSafeInteger(message.id) ||
        (lenientValidation &&
          typeof message.id === 'string' &&
          message.id.length >= 1 &&
          message.id.length <= 160);
      if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !validId) fail();
      if (message.id === undefined && message.method !== 'notifications/initialized') fail();
      const key = message.id === undefined ? 'notification' : JSON.stringify(message.id);
      const fingerprint = JSON.stringify(message);
      if (requests.has(key)) {
        const previous = requests.get(key);
        if (!lenientValidation) {
          if (previous.fingerprint !== fingerprint) fail();
          return previous.promise;
        }
      }
      if (requests.size >= Math.max(256, maxCalls * 2)) fail('tianxi_sdk_mcp_call_limit');
      const promise = dispatch(message).then((result) => ({
        jsonrpc: '2.0',
        ...(message.id === undefined ? {} : { id: message.id }),
        result,
      }));
      requests.set(key, { fingerprint, promise });
      return promise;
    },
    get calls() {
      return calls;
    },
  };
}

module.exports = { createTianxiSdkMcpChannel };
