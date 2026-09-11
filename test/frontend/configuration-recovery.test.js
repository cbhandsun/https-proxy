'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripEsmSyntax } = require('./helpers/strip-esm-syntax');
const { Response, Headers, AbortController } = globalThis;
const source = fs.readFileSync(
  path.resolve(__dirname, '../../tauri-ui/src/app/runtime/configuration-recovery.js'),
  'utf8'
);
const sandbox = { setTimeout, clearTimeout };
vm.runInNewContext(stripEsmSyntax(source), sandbox);
const { createConfigurationRecovery, createConfigurationRecoveryView } = sandbox;
const valid = { profiles: [], modelRoutes: [] };

async function main() {
  assert.throws(() => createConfigurationRecovery({}), /callbacks/);
  const elements = new Map();
  const document = {
    getElementById: (id) => elements.get(id),
    createElement: () => ({
      children: [],
      setAttribute() {},
      addEventListener(_type, listener) {
        this.click = listener;
      },
      append(...children) {
        this.children.push(...children);
      },
      get firstChild() {
        return this.children[0];
      },
      get lastChild() {
        return this.children[this.children.length - 1];
      },
      remove() {
        elements.delete(this.id);
      },
    }),
  };
  elements.set('summary', { after: (panel) => elements.set(panel.id, panel) });
  let manualRetries = 0;
  let statusRefreshes = 0;
  const render = createConfigurationRecoveryView(
    document,
    () => manualRetries++,
    () => statusRefreshes++
  );
  render({ phase: 'connecting', attempts: 1 });
  const panel = elements.get('configurationRecovery');
  assert.equal(panel.lastChild.disabled, true);
  render({ phase: 'waiting', attempts: 1, retryMs: 1000 });
  assert.match(panel.firstChild.textContent, /1 秒后自动重试/);
  assert.equal(panel.lastChild.disabled, false);
  panel.lastChild.click();
  assert.equal(manualRetries, 1);
  render({ phase: 'connected', attempts: 0 });
  assert.equal(elements.has('configurationRecovery'), false);
  assert.equal(statusRefreshes, 1, 'recovery immediately refreshes the status card');
  render({ phase: 'connected', attempts: 0 });
  assert.equal(statusRefreshes, 1, 'steady-state heartbeats do not duplicate refreshes');
  const initialConnection = createConfigurationRecoveryView(
    document,
    () => {},
    () => statusRefreshes++
  );
  initialConnection({ phase: 'connected', attempts: 0 });
  assert.equal(statusRefreshes, 2, 'an initially successful load refreshes status too');
  const jobs = new Map();
  const states = [];
  let loaded = false;
  let applied = 0;
  let readCount = 0;
  let finish;
  let next = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const recovery = createConfigurationRecovery({
    read: () => {
      readCount++;
      return next();
    },
    isLoaded: () => loaded,
    apply: (value) => {
      assert.equal(value, valid);
      loaded = true;
      applied++;
    },
    onState: (state) => states.push(state),
    schedule: (fn, delay) => {
      const id = Symbol();
      jobs.set(id, { fn, delay });
      return id;
    },
    cancel: (id) => jobs.delete(id),
  });
  const first = recovery.run();
  assert.equal(recovery.run(), first, 'manual and heartbeat requests share one pending read');
  await Promise.resolve();
  assert.equal(readCount, 1);
  finish({ __fallback: true });
  assert.equal(await first, false);
  assert.equal(applied, 0);
  assert.equal(jobs.size, 1);
  assert.equal([...jobs.values()][0].delay, 1000);
  for (const bad of [
    null,
    [],
    {},
    { profiles: [] },
    { profiles: {}, modelRoutes: [] },
    { __fallback: true, error: '<script>secret</script>' },
  ]) {
    next = () => bad;
    assert.equal(await recovery.run(), false);
    assert.equal(applied, 0);
    assert.equal(jobs.size, 1, 'manual retry replaces the scheduled retry');
  }
  next = () => {
    throw Error('token=secret');
  };
  for (let i = 0; i < 8; i++) await recovery.run();
  assert.equal([...jobs.values()][0].delay, 30000, 'backoff stays bounded');
  assert.ok(!JSON.stringify(states).includes('secret'), 'UI recovery never exposes input/errors');
  next = () => valid;
  const job = [...jobs.values()][0];
  jobs.clear();
  job.fn();
  await recovery.run();
  assert.equal(applied, 1, 'retry applies recovered configuration without saving');
  assert.equal(jobs.size, 0);
  const before = readCount;
  assert.equal(await recovery.run(), true);
  assert.equal(readCount, before, 'loaded config is not re-read on every heartbeat');
  loaded = false;
  next = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = recovery.run();
  await Promise.resolve();
  recovery.stop();
  finish(valid);
  assert.equal(await pending, false);
  assert.equal(applied, 1, 'closed pages ignore late responses');
  assert.equal(await recovery.run(), false);

  // Exercise the actual renderer -> native bridge with stale cached ports.
  let calls = 0;
  let hanging = false;
  let healthBody = { appId: 'https-proxy-manager' };
  const browser = {
    window: {
      location: { origin: 'http://tauri.localhost' },
      Response,
      fetch: async () => {
        throw Error('native routing must not use browser networking');
      },
      __TAURI__: {
        core: {
          invoke: async (command, args) => {
            calls++;
            assert.equal(command, 'management_fetch_native');
            assert.equal(
              args.managementPort,
              null,
              'installed host resolves the authoritative port'
            );
            if (hanging) return new Promise(() => {});
            if (args.path === '/v1/local/health')
              return { status: 200, body: JSON.stringify(healthBody) };
            return { status: 200, body: JSON.stringify(valid) };
          },
        },
      },
    },
    document: { getElementById: () => null },
    localStorage: { getItem: () => '65500', setItem() {}, removeItem() {} },
    Headers,
    Response,
    AbortController,
    URL,
    setTimeout,
    clearTimeout,
    bindDomainDependencies: (_name, dependencies) => dependencies,
    reportFrontendError() {},
  };
  vm.runInNewContext(
    stripEsmSyntax(
      fs.readFileSync(path.resolve(__dirname, '../../tauri-ui/src/app/domains/bridge.js'), 'utf8')
    ),
    browser
  );
  browser.fetch = browser.window.fetch;
  browser.configureBridge({ config: {}, showToast() {}, assertConfigurationLoaded() {} });
  assert.equal((await browser.window.proxyManager.readConfig({ attempts: 1 })).profiles.length, 0);
  assert.equal(calls, 1);
  assert.equal((await browser.checkProxyHealth()).appId, 'https-proxy-manager');
  healthBody = { appId: 'unrelated-service' };
  assert.equal(await browser.checkProxyHealth(), null);
  healthBody = null;
  assert.equal(await browser.checkProxyHealth(), null);
  hanging = true;
  const unavailable = await browser.window.proxyManager.readConfig({
    attempts: 1,
    timeoutMs: 100,
    quiet: true,
  });
  assert.equal(unavailable.__fallback, true, 'an unresolved IPC request times out and can recover');
  hanging = false;
  assert.equal(
    (await browser.window.proxyManager.readConfig({ attempts: 1 })).modelRoutes.length,
    0
  );
  console.log('[configuration-recovery.test] ok');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
