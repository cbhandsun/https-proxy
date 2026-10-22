'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');

async function probe() {
  const bridgeFile = path.resolve(__dirname, '../lib/proxy/tianxi-bridge-runtime.js');
  const originalLoad = Module._load;
  let mode = 'blocked';
  let loads = 0;
  let factories = 0;
  let calls = 0;
  let injectedCalls = 0;
  const completed = { frames: [{ type: 'task_status', data: { status: 'COMPLETED' } }] };
  Module._load = function (specifier, parent, isMain) {
    const resolved = Module._resolveFilename(specifier, parent, isMain);
    if (resolved !== bridgeFile) return Reflect.apply(originalLoad, this, arguments);
    loads++;
    if (mode === 'blocked' || mode === 'load_failure') throw new Error('probe_load_failure');
    return {
      createTianxiBridgeRuntime(dependencies) {
        factories++;
        assert.equal(typeof dependencies.makeRequest, 'function');
        assert.equal(typeof dependencies.getTianxiOfficialBridgeUrl, 'function');
        if (mode === 'factory_failure') throw new Error('probe_factory_failure');
        return {
          async callTianxiOfficialBridge(payload, profile) {
            calls++;
            assert.equal(payload.model, 'super');
            assert.equal(payload.input, 'ping');
            assert.equal(profile.protocol, 'tianxi');
            if (mode === 'call_failure') throw new Error('probe_call_failure');
            return completed;
          },
        };
      },
    };
  };
  try {
    const { createManagementProfileHandlers } = require('../lib/proxy/handlers/management-profile');
    assert.equal(loads, 0, 'import must not load the default Tianxi bridge');
    let requests = 0;
    const dependencies = {
      sendJson() {},
      async makeRequest() {
        requests++;
        return { statusCode: 200, body: '{"models":[]}' };
      },
      async resolveOfficialCredentials({ profile }) {
        return { profile };
      },
      resolveConfiguredProfile: (profile) => profile,
      getProfilesSnapshot: () => [],
      readLatestAgentCoreHeader: () => null,
    };
    const handlers = createManagementProfileHandlers(dependencies);
    assert.equal(loads, 0, 'construction must not load the default Tianxi bridge');
    assert.equal(
      (await handlers.testProfileAuthUpstream('gemini', 'https://example.invalid', 'synthetic')).ok,
      true
    );
    assert.equal(requests, 1);
    assert.equal(
      (await handlers.testProfileAuthUpstream('unknown', 'https://example.invalid')).ok,
      false
    );
    assert.equal(loads, 0, 'non-Tianxi probes must not load the default bridge');

    const injected = createManagementProfileHandlers({
      ...dependencies,
      async callTianxiOfficialBridge() {
        injectedCalls++;
        return completed;
      },
    });
    assert.equal(
      (await injected.testProfileAuthUpstream('tianxi', 'https://example.invalid')).ok,
      true
    );
    assert.equal(injectedCalls, 1);
    assert.equal(loads, 0, 'injected bridge must retain its short circuit');

    mode = 'success';
    assert.equal(
      (await handlers.testProfileAuthUpstream('tianxi', 'https://example.invalid')).ok,
      true
    );
    assert.equal(loads, 1);
    assert.equal(factories, 1);
    assert.equal(calls, 1);

    for (const failure of ['load_failure', 'factory_failure', 'call_failure']) {
      mode = failure;
      const result = await handlers.testProfileAuthUpstream('tianxi', 'https://example.invalid');
      assert.deepEqual(result, { ok: false, error: `Network error: probe_${failure}` });
    }
    assert.equal(requests, 1, 'default bridge stubs must never make a network request');
    assert.equal(
      require.cache[path.resolve(__dirname, '../lib/proxy/tianxi-sdk-runtime.js')],
      undefined
    );
  } finally {
    Module._load = originalLoad;
  }
}

if (process.argv.includes('--management-profile-lazy-probe')) {
  probe().catch((error) => {
    process.stderr.write(
      error?.message === 'probe_load_failure'
        ? 'management_profile_eager_bridge_load_blocked\n'
        : 'management_profile_lazy_probe_failed\n'
    );
    process.exitCode = 1;
  });
} else {
  test('management profile loads the default SDK bridge only for a Tianxi probe', () => {
    const child = spawnSync(process.execPath, [__filename, '--management-profile-lazy-probe'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 65536,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, child.stderr);
  });
}
