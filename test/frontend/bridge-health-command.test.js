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
  const { requestContextRecoveryClear } =
    await import('../../tauri-ui/src/app/domains/context-recovery-controls.js');
  const { createContextRecoveryClearClient } =
    await import('../../tauri-ui/src/app/domains/context-recovery-clear-client.js');
  const { bindContextPolicyControls } =
    await import('../../tauri-ui/src/app/domains/context-policy-controls.js');
  const policyRevision = 'a'.repeat(64);
  function policyReply(path) {
    if (path.endsWith('/context-policy/preview'))
      return {
        ok: true,
        revision: policyRevision,
        fromVersion: 1,
        targetVersion: 2,
        migrationRequired: true,
        requestedPolicy: 'native-first',
        requestedRecovery: false,
        persistencePreference: false,
        impacts: ['automatic_trimming_disabled', 'evidence_dependent_history_requires_recovery'],
      };
    if (path.endsWith('/context-policy/apply'))
      return {
        ok: true,
        saved: true,
        changed: true,
        revision: 'b'.repeat(64),
        targetVersion: 2,
        runtimeApplication: 'pending',
      };
    return null;
  }
  const operationId = '12345678-1234-4123-8123-123456789abc';
  function operationReply(path, method) {
    if (!path.includes('/clear-operations')) return null;
    return {
      ok: true,
      scope: 'proxy_context_recovery',
      operationId,
      state: path.endsWith('/cancel')
        ? 'cancelled'
        : method === 'GET'
          ? 'succeeded'
          : path.endsWith('/start')
            ? 'running'
            : 'prepared',
    };
  }

  function loadBridge({ tauri }) {
    const calls = [];
    const window = {
      location: { origin: tauri ? 'tauri://localhost' : 'http://localhost:1430' },
      Response,
      fetch: async (url, options = {}) => {
        calls.push({ kind: 'fetch', url, method: options.method || 'GET', body: options.body });
        const data =
          policyReply(url) ||
          operationReply(url, options.method) ||
          (url.endsWith('/context-recovery/clear')
            ? { ok: true, scope: 'proxy_context_recovery' }
            : { ok: true, status: 'ok' });
        return new Response(JSON.stringify(data), {
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
              body: JSON.stringify(
                policyReply(payload.path) ||
                  operationReply(payload.path, payload.method) ||
                  (payload.path.endsWith('/context-recovery/clear')
                    ? { ok: true, scope: 'proxy_context_recovery' }
                    : { ok: true, status: 'ok' })
              ),
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
      installAppShortcutHandler() {},
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

  for (const tauri of [false, true]) {
    const bridge = loadBridge({ tauri });
    assert.equal(
      await requestContextRecoveryClear({
        fetchRequest: bridge.window.fetch.bind(bridge.window),
        getApiBase: () => '',
      }),
      'cleared'
    );
    assert.equal(bridge.calls.length, 1, 'clear must dispatch exactly once');
    const call = bridge.calls[0];
    assert.equal(call.kind, tauri ? 'invoke' : 'fetch');
    const request = tauri ? call.payload : call;
    assert.equal(tauri ? request.path : request.url, '/v1/local/context-recovery/clear');
    assert.equal(request.method, 'POST');
    assert.equal(request.body, '{"confirm":true}');
    if (tauri) {
      assert.equal(call.command, 'management_fetch_native');
      assert.equal(request.managementPort, null, 'native configuration owns the management port');
      assert.ok(!Object.hasOwn(request, 'token'), 'renderer must not supply a management secret');
    }
  }
  for (const tauri of [false, true]) {
    const bridge = loadBridge({ tauri });
    const saved = new Map();
    const client = createContextRecoveryClearClient({
      fetchRequest: bridge.window.fetch.bind(bridge.window),
      getApiBase: () => '',
      storage: {
        getItem: (key) => saved.get(key),
        setItem: (key, value) => saved.set(key, value),
        removeItem: (key) => saved.delete(key),
      },
    });
    assert.equal(await client.requestClear(), 'clearing');
    assert.equal(await client.readStatus(), 'cleared');
    assert.equal(bridge.calls.length, 3);
    assert.deepEqual(
      bridge.calls.map((call) => (tauri ? call.payload : call).method),
      ['POST', 'POST', 'GET']
    );
    assert.ok(bridge.calls.every((call) => !tauri || call.command === 'management_fetch_native'));
    assert.equal(saved.size, 0);
    saved.set('hpm_context_recovery_clear_operation_v1', operationId);
    const resumed = createContextRecoveryClearClient({
      fetchRequest: bridge.window.fetch.bind(bridge.window),
      getApiBase: () => '',
      storage: {
        getItem: (key) => saved.get(key) ?? null,
        setItem: (key, value) => saved.set(key, value),
        removeItem: (key) => saved.delete(key),
      },
    });
    assert.equal(await resumed.cancelPending(), 'cancelled');
    assert.equal(saved.size, 0);
    assert.equal(bridge.calls.length, 4);
    const last = bridge.calls[3];
    const request = tauri ? last.payload : last;
    assert.equal(
      tauri ? request.path : request.url,
      '/v1/local/context-recovery/clear-operations/cancel'
    );
    assert.equal(request.method, 'POST');
    assert.deepEqual(JSON.parse(request.body), { confirm: true, operationId });
    assert.ok(!Object.hasOwn(request, 'token'));
    if (tauri) assert.equal(last.command, 'management_fetch_native');
  }

  for (const tauri of [false, true]) {
    const bridge = loadBridge({ tauri });
    const current = { _revision: policyRevision, appSettings: {} };
    const button = { setAttribute() {} };
    const status = {};
    bindContextPolicyControls({
      getElement: (id) => (id === 'applyContextPolicy' ? button : status),
      getConfig: () => current,
      confirmAction: async () => true,
      fetchRequest: bridge.window.fetch.bind(bridge.window),
      getApiBase: () => '',
    });
    await button.onclick();
    assert.equal(current.appSettings.contextPolicyVersion, 2);
    assert.equal(bridge.calls.length, 2);
    for (const [index, method] of ['GET', 'POST'].entries()) {
      const call = bridge.calls[index];
      const request = tauri ? call.payload : call;
      assert.equal(request.method, method);
      assert.equal(
        tauri ? request.path : request.url,
        `/v1/local/context-policy/${index ? 'apply' : 'preview'}`
      );
      assert.ok(!Object.hasOwn(request, 'token'));
      if (tauri) assert.equal(call.command, 'management_fetch_native');
    }
  }
  console.log('[bridge-health-command.test] ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
