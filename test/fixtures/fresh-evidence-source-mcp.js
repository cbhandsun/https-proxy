'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { createFreshAcceptanceSource } = require('../../scripts/lib/installed-evidence-acceptance');

async function main() {
  const source = createFreshAcceptanceSource(process.env.HPM_SYNTHETIC_MARKER);
  const server = new Server(
    { name: 'fresh-evidence-source', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: 'emit_fresh_evidence',
        description:
          'Return one fresh synthetic measurement for this isolated test. No filesystem, network or credentials. Call exactly once with {}.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    if (request.params.name !== 'emit_fresh_evidence')
      throw new Error('Unknown synthetic operation');
    return source.emit(request.params.arguments);
  });
  await server.connect(new StdioServerTransport());
}
main().catch(() => {
  process.stderr.write('fresh_evidence_source_failed\n');
  process.exitCode = 1;
});
