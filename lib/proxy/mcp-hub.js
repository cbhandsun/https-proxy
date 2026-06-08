const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const MCP_LOG_FILE = path.join(DATA_DIR, 'mcp-execution.jsonl');

function logMcpExecution(data) {
  const record = {
    time: new Date().toISOString(),
    ...data,
  };
  try {
    fs.appendFileSync(MCP_LOG_FILE, JSON.stringify(record) + '\n');
  } catch (err) {}
}

const DEFAULT_TIMEOUT_MS = 750;

function sendJsonRpc(server, method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(server.url);
    } catch (err) {
      resolve({ ok: false, error: 'Invalid MCP server URL' });
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
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > 1024 * 1024) req.destroy(new Error('MCP response too large'));
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data || '{}');
            if (parsed.error) {
              resolve({ ok: false, error: parsed.error.message || JSON.stringify(parsed.error) });
              return;
            }
            resolve({ ok: true, result: parsed.result });
          } catch (err) {
            resolve({ ok: false, error: 'Failed to parse MCP response' });
          }
        });
      }
    );

    req.on('error', (err) => resolve({ ok: false, error: err.message }));
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
      server.timeoutMs || DEFAULT_TIMEOUT_MS
    );
    const tools =
      response.ok && response.result && Array.isArray(response.result.tools)
        ? response.result.tools.map((tool) => normalizeMcpTool(tool, server)).filter(Boolean)
        : [];
    const cacheMs =
      tools.length > 0 ? Number(server.cacheMs || 30000) : Number(server.failureCacheMs || 60000);
    listCache.set(cacheKey, { tools, expiresAt: Date.now() + Math.max(1000, cacheMs) });
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
    const maxRetries = server.maxRetries || 2;
    const response = await sendJsonRpc(
      server,
      'tools/call',
      {
        name: toolName,
        arguments: args || {},
      },
      (server && server.timeoutMs) || DEFAULT_TIMEOUT_MS
    );

    if (!response.ok) {
      if (attempt <= maxRetries) {
        console.warn(
          `[MCP Hub] Retrying tool call ${toolName} (attempt ${attempt + 1}/${maxRetries + 1})...`
        );
        const delay = (server.retryDelayMs || 500) * attempt;
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

  async function interceptAndExecute(toolCalls, protocol) {
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
};
