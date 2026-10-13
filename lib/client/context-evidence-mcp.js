'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const {
  createContextEvidenceHookSession,
  CAPTURE_HOOK_TOOL,
} = require('./context-evidence-hook-session');

function createContextEvidenceMcpServer() {
  const session = createContextEvidenceHookSession();
  const server = new Server(
    { name: 'hpm-local-evidence', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: session.definitions.map((tool) => ({
      ...tool,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const reply = session.call(
      request.params.name,
      request.params.arguments ?? {},
      request.params._meta
    );
    // Hook refusals become hook failures, not blocking/rewrite feedback.
    if (request.params.name === CAPTURE_HOOK_TOOL && !reply.ok) throw new Error(reply.code);
    return {
      isError: !reply.ok,
      content: [
        { type: 'text', text: reply.text ?? JSON.stringify({ ok: false, error: reply.code }) },
      ],
    };
  });
  server.onclose = () => session.close();
  return { server, session, connect: () => server.connect(new StdioServerTransport()) };
}

module.exports = { createContextEvidenceMcpServer };
