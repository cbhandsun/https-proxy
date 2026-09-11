'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createAgyBridgeServer } = require('../lib/proxy/agy-bridge-server');
const { createAgyRuntime } = require('../lib/proxy/agy-runtime');
const { createLogger } = require('../lib/proxy/logger');

const log = createLogger('agy-bridge');
async function main() {
  if (process.platform !== 'win32') throw new Error('Windows credential isolation is required');
  const executable =
    process.env.HPM_AGY_EXECUTABLE || path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
  const tokenPath = process.env.HPM_AGY_TOKEN_FILE;
  if (!tokenPath || !path.isAbsolute(tokenPath))
    throw new Error('HPM_AGY_TOKEN_FILE must name a private absolute path');
  const port = Number(process.env.HPM_AGY_PORT || 17863);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error('Invalid bridge port');
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  const bridge = createAgyBridgeServer({
    runtime: createAgyRuntime({ executable }),
    token,
    onRequest: (metadata) => log.info(metadata, 'AGY request completed'),
  });
  bridge.server.on('error', () => {
    log.error({ code: 'agy_listen_failed' }, 'AGY bridge failed');
    process.exitCode = 1;
  });
  bridge.server.listen(port, '127.0.0.1', () =>
    log.info({ port }, 'AGY bridge listening on loopback')
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      bridge.close().catch(() => {
        process.exitCode = 1;
      });
    });
}
main().catch(() => {
  log.error({ code: 'agy_startup_failed' }, 'AGY bridge startup failed; check local configuration');
  process.exitCode = 1;
});
