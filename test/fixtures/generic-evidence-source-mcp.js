'use strict';

const { randomBytes } = require('node:crypto');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  McpError,
  ErrorCode,
} = require('@modelcontextprotocol/sdk/types.js');
const { SOURCE } = require('../../scripts/lib/generic-evidence-acceptance');

async function main() {
  let sideEffectCount = 0;
  const server = new Server(
    { name: 'generic-synthetic-source', version: '1' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: SOURCE,
        description:
          'Create a fresh, synthetic report once. Mutates only this isolated process counter, never files or network. Never repeat without new user permission.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, (call) => {
    if (
      call.params.name !== SOURCE ||
      !call.params.arguments ||
      Object.keys(call.params.arguments).length ||
      sideEffectCount
    )
      throw new McpError(ErrorCode.InvalidParams, 'synthetic_operation_refused');
    sideEffectCount++;
    const rows = Array.from({ length: 80 }, (_, row) => ({
      row,
      value: randomBytes(16).toString('hex'),
      label: '原始结果-é-✅-' + row,
    }));
    return { content: [{ type: 'text', text: JSON.stringify({ sideEffectCount, rows }) }] };
  });
  await server.connect(new StdioServerTransport());
}
main().catch(() => {
  process.stderr.write('generic_synthetic_source_failed\n');
  process.exitCode = 1;
});
