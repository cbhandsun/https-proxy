'use strict';

const os = require('node:os');
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
    { name: 'hpm-local-evidence', version: '0.1.1' },
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

// A native installer may retire its version directory while stdio is active.
// Load the server's module graph first, then release that disposable cwd before
// accepting requests. This changes no host cwd for ordinary library consumers.
async function startContextEvidencePlugin(dependencies = {}) {
  let runtime;
  try {
    if (!dependencies || ![Object.prototype, null].includes(Object.getPrototypeOf(dependencies)))
      throw new Error('invalid');
    const values = Object.create(null);
    for (const key of Reflect.ownKeys(dependencies)) {
      const slot = Object.getOwnPropertyDescriptor(dependencies, key);
      if (
        !['createRuntime', 'changeDirectory', 'runtimeDirectory'].includes(key) ||
        !slot?.enumerable ||
        !Object.hasOwn(slot, 'value') ||
        typeof slot.value !== 'function'
      )
        throw new Error('invalid');
      values[key] = slot.value;
    }
    runtime = (values.createRuntime ?? createContextEvidenceMcpServer)();
    const directory = (values.runtimeDirectory ?? os.tmpdir)();
    (values.changeDirectory ?? ((value) => process.chdir(value)))(directory);
    await runtime.connect();
    return runtime;
  } catch {
    try {
      runtime?.session?.close();
    } catch {
      // Cleanup failure cannot turn a failed startup into success.
    }
    throw new Error('evidence_mcp_start_failed');
  }
}

module.exports = { createContextEvidenceMcpServer, startContextEvidencePlugin };
