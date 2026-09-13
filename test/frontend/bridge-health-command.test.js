'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripEsmSyntax } = require('./helpers/strip-esm-syntax');
const { AbortController, Headers, Response } = globalThis;

const source = fs.readFileSync(
  path.resolve(__dirname, '../../tauri-ui/src/app/domains/bridge.js'),
  'utf8'
);

(async () => {
  const { executeHealthCommand } = await import('../../tauri-ui/src/app/models/proxy-command.js');

  function loadBridge({ tauri }) {
    const calls = [];
    const window = {
      location: { origin: tauri ? 'tauri://localhost' : 'http://localhost:1430' },
      Response,
      fetch: async (url, options = {}) => {
        calls.push({ kind: 'fetch', url, method: options.method || 'GET' });
        return new Response(JSON.stringify({ ok: true, status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    };
    if (tauri) {
      window.__TAURI__ = {
        core: {
          invoke: async (command, payload) => {
            calls.push({ kind: 'invoke', command, payload });
            if (command !== 'management_fetch_native') {
              throw new Error(`unexpected native command: ${command}`);
            }
            return {
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ok: true, status: 'ok' }),
            };
          },
        },
      };
    }

    const sandbox = {
      window,
      document: {
        getElementById: () => null,
        body: { appendChild() {} },
      },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      Headers,
      Response,
      URL,
      URLSearchParams,
      AbortController,
      setTimeout,
      clearTimeout,
      bindDomainDependencies: (_name, dependencies) => dependencies,
      reportFrontendError() {},
      executeHealthCommand,
    };
    vm.runInNewContext(stripEsmSyntax(source), sandbox);
    sandbox.fetch = window.fetch;
    sandbox.configureBridge({ config: {}, showToast() {}, assertConfigurationLoaded() {} });
    return { calls, window };
  }

  const browser = loadBridge({ tauri: false });
  const browserResult = await browser.window.proxyManager.command('health');
  assert.equal(browserResult.code, 0);
  assert.equal(browser.calls.length, 1);
  assert.match(browser.calls[0].url, /\/v1\/local\/health$/);

  const desktop = loadBridge({ tauri: true });
  const desktopResult = await desktop.window.proxyManager.command('health');
  assert.equal(desktopResult.code, 0);
  assert.equal(
    desktop.calls.some((call) => call.command === 'execute_proxy_command'),
    false,
    'desktop health checks must not enter the native process-command whitelist'
  );
  assert.equal(
    desktop.calls.filter((call) => call.command === 'management_fetch_native').length,
    1
  );
  assert.equal(desktop.calls.find((call) => call.command)?.payload.path, '/v1/local/health');

  console.log('[bridge-health-command.test] ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
