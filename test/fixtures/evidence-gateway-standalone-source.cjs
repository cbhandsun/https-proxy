'use strict';
const readline = require('node:readline');
let calls = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize')
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'standalone-synthetic-source', version: '1' },
    };
  else if (request.method === 'tools/list')
    result = {
      tools: [
        { name: 'fresh_source', inputSchema: { type: 'object', additionalProperties: false } },
      ],
    };
  else if (request.method === 'tools/call')
    result = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            calls: ++calls,
            pid: process.pid,
            text: '独立原文🙂'.repeat(400),
          }),
        },
      ],
    };
  else {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: 'fixture_method_unavailable' },
      }) + '\n'
    );
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
