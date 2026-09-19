'use strict';

const { createTianxiBridgeServer } = require('../lib/proxy/tianxi-bridge-server');
const { createLogger } = require('../lib/proxy/logger');
const { createTianxiNativeRuntime } = require('../lib/proxy/tianxi-native-runtime');

const log = createLogger('tianxi-bridge');

function parsePort(value) {
  const port = Number(value || 49305);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Invalid Tianxi bridge port');
  }
  return port;
}

async function main() {
  const runtime = createTianxiNativeRuntime();
  const bridge = createTianxiBridgeServer({
    runtime,
    token: process.env.HPM_TIANXI_TOKEN || '',
    onRequest: (metadata) => log.info(metadata, 'Tianxi bridge request completed'),
  });
  const port = parsePort(process.env.HPM_TIANXI_PORT);
  bridge.server.on('error', () => {
    log.error({ code: 'tianxi_bridge_listen_failed' }, 'Tianxi bridge failed');
    process.exitCode = 1;
  });
  bridge.server.listen(port, '127.0.0.1', () =>
    log.info({ port, runtime: runtime.name || 'custom' }, 'Tianxi bridge listening on loopback')
  );
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      bridge.close().catch(() => {
        process.exitCode = 1;
      });
    });
  }
}

main().catch(() => {
  log.error(
    { code: 'tianxi_bridge_startup_failed' },
    'Tianxi bridge startup failed; check local configuration'
  );
  process.exitCode = 1;
});
