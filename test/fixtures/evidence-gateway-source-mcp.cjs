'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const server = new Server(
  { name: 'fresh-gateway-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } }
);
let calls = 0;
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'fresh_source',
      inputSchema: { type: 'object', additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, () => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        fixture: 'fresh-synthetic-only',
        calls: ++calls,
        pid: process.pid,
        selectedEnvironmentPresent:
          process.env.HPM_GATEWAY_FIXTURE_ALLOWED === 'synthetic-fixture-only',
        unselectedEnvironmentPresent: process.env.HPM_GATEWAY_FIXTURE_UNSELECTED !== undefined,
        payload: '中文🙂'.repeat(400),
      }),
    },
  ],
}));
server.connect(new StdioServerTransport()).catch(() => {
  process.stderr.write('fixture_start_failed\n');
  process.exitCode = 1;
});
