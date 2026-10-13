'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  CallToolResultSchema,
  McpError,
  ErrorCode,
  ToolListChangedNotificationSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { normalizeCompactionData } = require('../proxy/context-compaction-envelope');
const { createContextEvidenceGateway } = require('./context-evidence-gateway');
const { loadEvidenceGatewayCatalog } = require('./context-evidence-gateway-catalog');
const { createEvidenceGatewayCatalogRefresh } = require('./context-evidence-gateway-refresh');
const { createEvidenceGatewayProgressForwarder } = require('./context-evidence-gateway-progress');

class ImmediateEvidenceServer extends Server {
  // SDK checks task capabilities before invoking the tools/call handler. Use
  // its protected extension point to return our fixed unsupported-mode error,
  // rather than an internal error or a malformed task-creation result.
  assertTaskHandlerCapability() {
    throw new McpError(ErrorCode.InvalidParams, 'gateway_task_mode_unsupported');
  }
}

// Downstream is an already connected, owner-configured MCP Client. Neither this
// adapter nor the model can choose another server, command, credential or scope.
async function createContextEvidenceGatewayMcpServer(downstream, options = {}) {
  let safeOptions;
  try {
    safeOptions = normalizeCompactionData(options, 1024);
    if (
      !safeOptions ||
      typeof safeOptions !== 'object' ||
      Array.isArray(safeOptions) ||
      Object.keys(safeOptions).some((key) => key !== 'offloadThresholdBytes')
    )
      throw new Error('invalid');
  } catch {
    throw new Error('invalid_gateway_configuration');
  }
  const catalogController = new globalThis.AbortController();
  let closed = false;
  const dynamicTools = downstream.getServerCapabilities?.()?.tools?.listChanged === true;
  const startupState = { refresh: null };
  let startupRevision = 0;
  if (dynamicTools)
    downstream.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      if (startupState.refresh) return startupState.refresh.refresh();
      startupRevision++;
    });
  let tools;
  try {
    // Subscribe before discovery: changes during startup must not disappear in
    // the gap between the initial tools/list reply and handler registration.
    for (let attempt = 0; attempt < 2; attempt++) {
      const revision = startupRevision;
      const candidate = await loadEvidenceGatewayCatalog(downstream, catalogController.signal);
      if (revision === startupRevision) {
        tools = candidate;
        break;
      }
    }
    if (!tools) throw new Error('gateway_catalog_unavailable');
  } catch {
    if (dynamicTools) downstream.removeNotificationHandler('notifications/tools/list_changed');
    throw new Error('gateway_catalog_unavailable');
  }
  let session;
  try {
    session = createContextEvidenceGateway({
      ...safeOptions,
      tools,
      callTool: async (params, context) => {
        let active = true;
        const progress = createEvidenceGatewayProgressForwarder({
          token: context.progressToken,
          send: context.sendProgress,
          isActive: () => active && !closed && !context.signal?.aborted,
        });
        try {
          return await downstream.request({ method: 'tools/call', params }, CallToolResultSchema, {
            signal: context.signal,
            timeout: 60_000,
            ...(context.progressToken === undefined
              ? {}
              : {
                  onprogress: (value) => {
                    progress.accept(value);
                  },
                }),
          });
        } finally {
          active = false;
        }
      },
    });
  } catch (error) {
    catalogController.abort();
    if (dynamicTools) downstream.removeNotificationHandler('notifications/tools/list_changed');
    throw error;
  }
  const server = new ImmediateEvidenceServer(
    { name: 'hpm-evidence-gateway', version: '0.1.0' },
    { capabilities: { tools: dynamicTools ? { listChanged: true } : {} } }
  );
  const catalogRefresh = createEvidenceGatewayCatalogRefresh({
    load: () => loadEvidenceGatewayCatalog(downstream, catalogController.signal),
    replace: (value) => session.replaceCatalog(value),
    suspend: () => session.suspendDispatch(),
    notify: () =>
      server.getClientVersion()
        ? server.notification({ method: 'notifications/tools/list_changed' })
        : undefined,
    isClosed: () => closed,
  });
  startupState.refresh = catalogRefresh;
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: session.definitions }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    // Async task creation, sampling and elicitation are not silently downgraded
    // into an immediate call. This version supports immediate tool calls only.
    if (request.params.task !== undefined)
      throw new McpError(ErrorCode.InvalidParams, 'gateway_task_mode_unsupported');
    return session.call(request.params.name, request.params.arguments ?? {}, {
      signal: extra.signal,
      progressToken: request.params._meta?.progressToken,
      sendProgress: (params) =>
        extra.sendNotification({ method: 'notifications/progress', params }),
    });
  });
  function dispose() {
    if (closed) return;
    closed = true;
    catalogController.abort();
    if (dynamicTools) downstream.removeNotificationHandler('notifications/tools/list_changed');
    session.close();
  }
  server.onclose = dispose;
  return {
    server,
    session,
    catalogRefresh,
    close: async () => {
      dispose();
      await server.close();
    },
    connect: (transport = new StdioServerTransport()) => server.connect(transport),
  };
}

module.exports = { createContextEvidenceGatewayMcpServer };
