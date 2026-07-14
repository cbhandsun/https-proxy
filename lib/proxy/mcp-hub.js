const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { parseBoundedInteger } = require('./management-utils');

const MCP_LOG_FILE = path.join(DATA_DIR, 'mcp-execution.jsonl');
const MCP_LOG_MAX_BYTES = parseBoundedInteger(
  process.env.MCP_LOG_MAX_BYTES,
  5 * 1024 * 1024,
  256 * 1024,
  64 * 1024 * 1024
);
const MCP_LOG_MAX_TEXT_CHARS = parseBoundedInteger(
  process.env.MCP_LOG_MAX_TEXT_CHARS,
  12000,
  256,
  1024 * 1024
);
const MCP_LOG_MAX_DEPTH = 6;
const MCP_LOG_MAX_ARRAY_ITEMS = 40;
const MCP_LOG_MAX_OBJECT_KEYS = 80;
const MCP_RPC_MAX_RESPONSE_BYTES = parseBoundedInteger(
  process.env.MCP_RPC_MAX_RESPONSE_BYTES,
  1024 * 1024,
  1024,
  4 * 1024 * 1024
);

const mcpLogQueue = [];
let mcpLogWriting = false;

function shouldRedactMcpKey(key) {
  return /(?:api[_-]?key|authorization|token|secret|password|cookie|credential|refresh[_-]?token|access[_-]?token)/i.test(
    String(key || '')
  );
}

function compactMcpLogValue(value, depth = 0, key = '') {
  if (shouldRedactMcpKey(key)) return value ? '[redacted]' : value;
  if (value == null) return value;
  if (typeof value === 'string') {
    if (value.length <= MCP_LOG_MAX_TEXT_CHARS) return value;
    return value.slice(0, MCP_LOG_MAX_TEXT_CHARS) + '...[truncated]';
  }
  if (typeof value !== 'object') return value;
  if (depth >= MCP_LOG_MAX_DEPTH) return '[max-depth]';
  if (Array.isArray(value)) {
    const result = value
      .slice(0, MCP_LOG_MAX_ARRAY_ITEMS)
      .map((item) => compactMcpLogValue(item, depth + 1, key));
    if (value.length > MCP_LOG_MAX_ARRAY_ITEMS) {
      result.push(`[${value.length - MCP_LOG_MAX_ARRAY_ITEMS} more items]`);
    }
    return result;
  }

  const result = {};
  const entries = Object.entries(value);
  for (const [childKey, childValue] of entries.slice(0, MCP_LOG_MAX_OBJECT_KEYS)) {
    result[childKey] = compactMcpLogValue(childValue, depth + 1, childKey);
  }
  if (entries.length > MCP_LOG_MAX_OBJECT_KEYS) {
    result.__truncatedKeys = entries.length - MCP_LOG_MAX_OBJECT_KEYS;
  }
  return result;
}

async function rotateMcpLogIfNeeded() {
  try {
    const stat = await fs.promises.stat(MCP_LOG_FILE);
    if (stat.size <= MCP_LOG_MAX_BYTES) return;
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }

  const rotated = MCP_LOG_FILE + '.1';
  try {
    await fs.promises.unlink(rotated);
  } catch (err) {}
  try {
    await fs.promises.rename(MCP_LOG_FILE, rotated);
  } catch (err) {
    await fs.promises.copyFile(MCP_LOG_FILE, rotated);
    await fs.promises.writeFile(MCP_LOG_FILE, '');
  }
}

async function processMcpLogQueue() {
  if (mcpLogWriting) return;
  mcpLogWriting = true;
  while (mcpLogQueue.length > 0) {
    const entry = mcpLogQueue.shift();
    try {
      await rotateMcpLogIfNeeded();
      await fs.promises.appendFile(MCP_LOG_FILE, JSON.stringify(entry) + '\n');
    } catch (err) {}
  }
  mcpLogWriting = false;
}

function logMcpExecution(data) {
  const record = {
    time: new Date().toISOString(),
    ...compactMcpLogValue(data || {}),
  };
  try {
    mcpLogQueue.push(record);
    processMcpLogQueue();
  } catch (err) {}
}

async function flushMcpLogWrites() {
  while (mcpLogWriting || mcpLogQueue.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const DEFAULT_TIMEOUT_MS = 750;

function normalizeBearerToken(value) {
  const token = String(value || '').trim();
  if (!token) return '';
  return token.replace(/^Bearer\s+/i, '').trim();
}

function mcpRequestHeaders(server, body) {
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };
  const bearerToken = normalizeBearerToken(server && server.bearerToken);
  if (bearerToken) headers.Authorization = 'Bearer ' + bearerToken;
  return headers;
}

function sendJsonRpc(server, method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (payload) => {
      if (finished) return;
      finished = true;
      resolve(payload);
    };
    let target;
    try {
      target = new URL(server.url);
    } catch (err) {
      finish({ ok: false, error: 'Invalid MCP server URL' });
      return;
    }

    const transport = target.protocol === 'https:' ? https : http;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params: params || {},
      id: method + '-' + Date.now(),
    });

    const req = transport.request(
      target,
      {
        method: 'POST',
        timeout: timeoutMs,
        headers: mcpRequestHeaders(server, body),
      },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on('data', (chunk) => {
          if (finished) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
          bytes += buffer.length;
          if (bytes > MCP_RPC_MAX_RESPONSE_BYTES) {
            chunks.length = 0;
            finish({
              ok: false,
              error: 'MCP response too large; max ' + MCP_RPC_MAX_RESPONSE_BYTES + ' bytes',
            });
            if (typeof res.destroy === 'function') res.destroy();
            if (typeof req.destroy === 'function') req.destroy();
            return;
          }
          chunks.push(buffer);
        });
        res.on('end', () => {
          if (finished) return;
          try {
            const data = Buffer.concat(chunks, bytes).toString('utf8');
            const parsed = JSON.parse(data || '{}');
            if (parsed.error) {
              finish({ ok: false, error: parsed.error.message || JSON.stringify(parsed.error) });
              return;
            }
            finish({ ok: true, result: parsed.result });
          } catch (err) {
            finish({ ok: false, error: 'Failed to parse MCP response' });
          }
        });
      }
    );

    req.on('error', (err) => finish({ ok: false, error: err.message }));
    req.on('timeout', () => req.destroy(new Error('MCP request timeout')));
    req.end(body);
  });
}

function normalizeMcpTool(tool, server) {
  const name = tool && (tool.name || (tool.function && tool.function.name));
  if (!name) return null;
  const prefixedName = server.prefix ? `${server.prefix}_${name}` : name;
  return {
    name: prefixedName,
    description: tool.description || (tool.function && tool.function.description) || '',
    input_schema: tool.input_schema ||
      tool.inputSchema ||
      tool.parameters ||
      (tool.function && tool.function.parameters) || {
        type: 'object',
        properties: {},
      },
  };
}

function upstreamMcpToolName(server, toolName) {
  const name = String(toolName || '');
  const prefix = server && server.prefix ? String(server.prefix) + '_' : '';
  return prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function mergeClaudeTools(existingTools, injectedTools) {
  const tools = Array.isArray(existingTools) ? existingTools.slice() : [];
  const seen = new Set(tools.map((tool) => tool && tool.name).filter(Boolean));
  for (const tool of injectedTools) {
    if (!tool || seen.has(tool.name)) continue;
    seen.add(tool.name);
    tools.push(tool);
  }
  return tools;
}

function createMcpHub(deps) {
  const { getConfig } = deps;
  const listCache = new Map();

  function getMcpConfig() {
    const config = getConfig();
    const hub = config && config.mcpHub;
    return {
      servers: Array.isArray(hub && hub.servers) ? hub.servers : [],
      routing: Array.isArray(hub && hub.routing) ? hub.routing : [],
    };
  }

  async function fetchToolsFromServer(server) {
    const cacheKey = `${server.id || server.url}:${server.url}`;
    const cached = listCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.tools;

    const response = await sendJsonRpc(
      server,
      'tools/list',
      {},
      parseBoundedInteger(server.timeoutMs, DEFAULT_TIMEOUT_MS, 50, 120000)
    );
    const tools =
      response.ok && response.result && Array.isArray(response.result.tools)
        ? response.result.tools.map((tool) => normalizeMcpTool(tool, server)).filter(Boolean)
        : [];
    const cacheMs =
      tools.length > 0
        ? parseBoundedInteger(server.cacheMs, 30000, 1000, 3600000)
        : parseBoundedInteger(server.failureCacheMs, 60000, 1000, 3600000);
    listCache.set(cacheKey, { tools, expiresAt: Date.now() + cacheMs });
    return tools;
  }

  async function augmentRequestTools(parsedBody) {
    if (!parsedBody || typeof parsedBody !== 'object') return parsedBody;
    const config = getMcpConfig();
    const injectableServers = config.servers.filter(
      (server) => server && server.injectAll && server.url
    );
    if (injectableServers.length === 0) return parsedBody;

    const injectedTools = [];
    for (const server of injectableServers) {
      const tools = await fetchToolsFromServer(server);
      injectedTools.push(...tools);
    }

    if (injectedTools.length === 0) return parsedBody;
    return {
      ...parsedBody,
      tools: mergeClaudeTools(parsedBody.tools, injectedTools),
    };
  }

  function resolveToolRoute(toolName) {
    const config = getMcpConfig();
    const route = config.routing.find((item) => {
      if (!item) return false;
      if (item.toolName === toolName) return true;
      if (!item.pattern) return false;
      try {
        return new RegExp(item.pattern).test(toolName);
      } catch (err) {
        return false;
      }
    });
    return route ? config.servers.find((server) => server.id === route.serverId) || null : null;
  }

  async function callRemoteMcp(server, toolName, args, attempt = 1) {
    const maxRetries = parseBoundedInteger(server && server.maxRetries, 2, 0, 10);
    const timeoutMs = parseBoundedInteger(
      server && server.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      50,
      120000
    );
    const response = await sendJsonRpc(
      server,
      'tools/call',
      {
        name: upstreamMcpToolName(server, toolName),
        arguments: args || {},
      },
      timeoutMs
    );

    if (!response.ok) {
      if (attempt <= maxRetries) {
        console.warn(
          `[MCP Hub] Retrying tool call ${toolName} (attempt ${attempt + 1}/${maxRetries + 1})...`
        );
        const delay = parseBoundedInteger(server && server.retryDelayMs, 500, 0, 60000) * attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return callRemoteMcp(server, toolName, args, attempt + 1);
      }
      throw new Error(response.error || 'MCP call failed after retries');
    }
    return response.result;
  }

  function extractToolCalls(responsePayload, protocol) {
    // Basic implementation for extracting tool calls from non-streaming response
    if (protocol === 'claude') {
      return (responsePayload.content || [])
        .filter((c) => c.type === 'tool_use')
        .map((c) => ({ id: c.id, name: c.name, input: c.input }));
    }
    if (protocol === 'openai') {
      const choice = (responsePayload.choices || [])[0];
      return (choice?.message?.tool_calls || [])
        .filter((tc) => tc.type === 'function')
        .map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}'),
        }));
    }
    return [];
  }

  async function interceptAndExecute(toolCalls, _protocol) {
    const results = [];
    for (const tc of toolCalls) {
      const server = resolveToolRoute(tc.name);
      if (server) {
        const startTime = Date.now();
        try {
          const executionResult = await callRemoteMcp(server, tc.name, tc.input);
          const elapsed = Date.now() - startTime;
          logMcpExecution({
            serverId: server.id,
            toolName: tc.name,
            input: tc.input,
            result: executionResult,
            elapsed,
            status: 'success',
          });
          results.push({ toolCallId: tc.id, result: executionResult });
        } catch (e) {
          const elapsed = Date.now() - startTime;
          logMcpExecution({
            serverId: server.id,
            toolName: tc.name,
            input: tc.input,
            error: e.message,
            elapsed,
            status: 'error',
          });
          results.push({ toolCallId: tc.id, error: e.message });
        }
      }
    }
    return results.length > 0 ? results : null;
  }

  return {
    augmentRequestTools,
    resolveToolRoute,
    callRemoteMcp,
    extractToolCalls,
    interceptAndExecute,
  };
}

module.exports = {
  createMcpHub,
  normalizeMcpTool,
  mergeClaudeTools,
  upstreamMcpToolName,
  _test: {
    compactMcpLogValue,
    flushMcpLogWrites,
    logMcpExecution,
    mcpRequestHeaders,
    normalizeBearerToken,
    sendJsonRpc,
  },
};
