'use strict';

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { parseEvidenceGatewayArguments } = require('./evidence-gateway-config');
const { selectEvidenceGatewayEnvironment } = require('./evidence-gateway-environment');
const {
  createContextEvidenceGatewayMcpServer,
} = require('../../lib/client/context-evidence-gateway-mcp');

// A real stdio entrypoint for compatible MCP hosts, not a Codex plugin. Only
// explicitly owner-selected environment names are forwarded, without logging.
async function startEvidenceGateway(argv) {
  const config = parseEvidenceGatewayArguments(argv);
  const environment = selectEvidenceGatewayEnvironment(config.environmentKeys ?? []);
  const downstream = new Client(
    { name: 'hpm-evidence-gateway-downstream', version: '0.1.0' },
    { capabilities: {} }
  );
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: environment,
    stderr: 'pipe',
  });
  // Drain, never relay untrusted stderr (it can contain credentials or content).
  transport.stderr?.on('data', () => {});
  let runtime;
  let closePromise;
  function close() {
    if (closePromise) return closePromise;
    runtime?.session.close();
    // Defer work so re-entrant transport callbacks observe the same promise.
    closePromise = Promise.resolve().then(async () => {
      try {
        await runtime?.close();
      } finally {
        await downstream.close();
      }
    });
    return closePromise;
  }
  try {
    await downstream.connect(transport);
    runtime = await createContextEvidenceGatewayMcpServer(downstream, config.options);
    const onUpstreamClose = runtime.server.onclose;
    runtime.server.onclose = () => {
      onUpstreamClose();
      close().catch(() => {
        process.stderr.write('evidence_gateway_close_failed\n');
        process.exitCode = 1;
      });
    };
    downstream.onclose = () => {
      close().catch(() => {
        process.stderr.write('evidence_gateway_close_failed\n');
        process.exitCode = 1;
      });
    };
    await runtime.connect();
    return { ...runtime, close };
  } catch {
    try {
      await close();
    } catch {
      process.stderr.write('evidence_gateway_close_failed\n');
    }
    throw new Error('evidence_gateway_start_failed');
  }
}

module.exports = { parseEvidenceGatewayArguments, startEvidenceGateway };
