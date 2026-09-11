'use strict';

function createMcpInterception({ mcpHub, log, logRequestEnd, parseJsonOrSseJson }) {
  return async function handleMcpInterception(
    responseBody,
    protocol,
    clientRes,
    upstreamPath,
    startTime,
    method
  ) {
    if (!mcpHub) return false;
    try {
      const parsed = parseJsonOrSseJson(responseBody);
      const toolCalls = mcpHub.extractToolCalls(parsed, protocol);
      if (!Array.isArray(toolCalls) || toolCalls.length === 0) return false;

      const mcpResults = await mcpHub.interceptAndExecute(toolCalls, protocol);
      if (!mcpResults) return false;

      log.info(`[MCP Hub] Intercepted and executed ${mcpResults.length} tool(s)`);
      clientRes.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
      });
      clientRes.end(
        JSON.stringify({
          mcp_intercepted: true,
          results: mcpResults,
        })
      );
      logRequestEnd(method, upstreamPath, startTime, 200, {
        type: 'mcp_interception',
        tools: toolCalls.length,
      });
      return true;
    } catch {
      log.warn('[MCP Hub] Interception check failed');
      return false;
    }
  };
}

module.exports = { createMcpInterception };
