'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Headers, Response, AbortController } = globalThis;
const { stripEsmSyntax } = require('./helpers/strip-esm-syntax');

const source = fs.readFileSync(
  path.resolve(__dirname, '../../tauri-ui/src/app/runtime/configuration-load-state.js'),
  'utf8'
);
const sandbox = {};
vm.runInNewContext(stripEsmSyntax(source), sandbox);
const { configurationLoadNotice, assertConfigurationLoaded } = sandbox;
for (const config of [undefined, null, '', 123, [], { __fallback: true }, { __fallback: 'true' }]) {
  assert.notEqual(configurationLoadNotice(config), '');
  assert.throws(() => assertConfigurationLoaded(config), /已阻止保存/);
}
for (const config of [
  { profiles: [], modelRoutes: [] },
  { __fallback: false, profiles: [{ id: 'test' }] },
]) {
  assert.equal(configurationLoadNotice(config), '');
  assert.doesNotThrow(() => assertConfigurationLoaded(config));
}
const untrusted = { __fallback: true, error: '<script>secret-token</script>' };
assert.ok(!configurationLoadNotice(untrusted).includes('secret-token'));
assert.ok(!configurationLoadNotice(untrusted).includes('<script>'));
const bridgeSource = fs.readFileSync(
  path.resolve(__dirname, '../../tauri-ui/src/app/domains/bridge.js'),
  'utf8'
);
(async () => {
  const requests = [];
  const browser = {
    window: {
      location: { origin: 'http://localhost:1430' },
      fetch: async (url, options = {}) => {
        requests.push({ url, method: options.method || 'GET' });
        return new Response(
          JSON.stringify(
            options.method === 'POST'
              ? { ok: true, revision: 'test' }
              : { error: 'Unauthorized management access' }
          ),
          { status: options.method === 'POST' ? 200 : 401 }
        );
      },
    },
    document: { getElementById: () => null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Headers,
    Response,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    bindDomainDependencies: (_name, dependencies) => dependencies,
    installAppShortcutHandler() {},
    reportFrontendError() {},
    assertConfigurationLoaded,
  };
  vm.runInNewContext(stripEsmSyntax(bridgeSource), browser);
  browser.fetch = browser.window.fetch;
  browser.configureBridge({ config: {}, showToast() {}, assertConfigurationLoaded });
  const fallback = await browser.window.proxyManager.readConfig({ attempts: 1, quiet: true });
  assert.equal(fallback.__fallback, true);
  await assert.rejects(browser.window.proxyManager.saveConfig(fallback), /已阻止保存/);
  assert.equal(requests.length, 1, 'a failed configuration read must not be followed by a save');
  await browser.window.proxyManager.saveConfig({ profiles: [], modelRoutes: [], localServer: {} });
  assert.equal(
    requests[1].method,
    'POST',
    'successfully loaded empty configurations remain savable'
  );
  console.log('[configuration-load-state.test] ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
