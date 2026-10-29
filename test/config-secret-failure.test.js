'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');

for (const [name, secrets] of [
  ['profile', { profiles: [{ apiKey: 'fixture-private-secret' }] }],
  ['entry', { entryAuth: { enabled: true, keys: [{ key: 'fixture-private-secret' }] } }],
  ['desktop', { claudeDesktop: { token: 'fixture-private-secret' } }],
  ['MCP', { mcpHub: { servers: [{ bearerToken: 'fixture-private-secret' }] } }],
]) {
  test(`configuration ${name} protection failure cannot return unauthenticated defaults`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-config-protect-'));
    try {
      const file = path.join(directory, 'proxy.config.json');
      const original = JSON.stringify(secrets);
      fs.writeFileSync(file, original, { mode: 0o600 });
      const program = `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const crypto = require('./lib/proxy/secret-crypto');
        const failure = Object.assign(new Error('PRIVATE_NATIVE_FAILURE'), {
          code: 'ERR_SECRET_ENCRYPTION_FAILED'
        });
        let calls = 0;
        crypto.encryptKey = () => { calls++; throw failure; };
        const config = require('./lib/proxy/config');
        for (const options of [{}, { throwOnError: false }, { throwOnError: true }]) {
          assert.throws(() => config.loadConfig(options), error => error === failure);
        }
        assert.equal(calls, 3);
        assert.equal(fs.readFileSync(config.CONFIG_FILE, 'utf8'), ${JSON.stringify(original)});
        assert.deepEqual(fs.readdirSync(${JSON.stringify(directory)}), ['proxy.config.json']);
      `;
      const child = spawnSync(process.execPath, ['-e', program], {
        cwd: repo,
        env: {
          ...process.env,
          PROXY_CONFIG_DIR: directory,
          HPM_MASTER_KEY_FILE: path.join(directory, 'unused-master.key'),
        },
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 16384,
        windowsHide: true,
      });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, 'configuration protection must fail closed');
      assert.equal(child.stdout, '');
      assert.equal(child.stderr, '');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
