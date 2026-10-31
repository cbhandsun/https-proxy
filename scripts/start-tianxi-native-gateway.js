'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createTianxiNativeGateway } = require('./lib/tianxi-native-gateway');

async function main() {
  const args = process.argv.slice(2);
  if (args.length) throw new Error('tianxi_native_arguments_invalid');
  const root = path.join(os.homedir(), '.codex', 'tianxi-native');
  const state = JSON.parse(fs.readFileSync(path.join(root, 'gateway.json'), 'utf8'));
  if (!Number.isSafeInteger(state.port) || state.port < 1024 || state.port > 65535)
    throw new Error('tianxi_native_port_invalid');
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'models.json'), 'utf8'));
  const gateway = createTianxiNativeGateway({ token: state.token, catalog });
  await new Promise((resolve, reject) => {
    gateway.server.once('error', reject);
    gateway.server.listen(state.port, '127.0.0.1', resolve);
  });
  for (const event of ['SIGINT', 'SIGTERM'])
    process.once(event, () =>
      gateway.close().catch(() => {
        process.exitCode = 1;
      })
    );
}
main().catch(() => {
  process.stderr.write('Tianxi native gateway failed. Check local state and port availability.\n');
  process.exitCode = 1;
});
