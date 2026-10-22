'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const transfer = require('../scripts/lib/nsis-baseline-transfer');
const contract = require('../scripts/lib/nsis-encrypted-contract');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
const { discoverTestFiles } = require('../lib/test-discovery');

const stages = [
  'input',
  'checkout',
  'repository',
  'release',
  'assets',
  'temp',
  'download_installer',
  'download_identity',
  'installer_digest',
  'identity',
  'release_recheck',
];
const sha = 'a'.repeat(40);

function fixture(t, failureStage) {
  const parent = resolvePhysicalTestTempDirectory();
  const root = fs.mkdtempSync(path.join(parent, 'hpm-bridge-diagnostics-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('hpm-bridge-diagnostics-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  let inspectedErrors = 0;
  const hostile = Object.create(null, {
    message: {
      get() {
        inspectedErrors++;
        throw new Error('PRIVATE_MESSAGE');
      },
    },
    cause: {
      get() {
        inspectedErrors++;
        throw new Error('PRIVATE_CAUSE');
      },
    },
  });
  const file = require.resolve('../scripts/lib/nsis-baseline-transfer');
  const scopedRequire = createRequire(file);
  const module = { exports: {} };
  // Synthetic fixture only: stub the imported installer digest so later stages
  // are reachable without executing or reading a real retained installer.
  vm.runInNewContext(
    fs.readFileSync(file, 'utf8'),
    {
      module,
      process,
      Buffer,
      AbortSignal: globalThis.AbortSignal,
      fetch,
      require(specifier) {
        if (specifier === './nsis-encrypted-contract')
          return {
            ...contract,
            digest() {
              if (failureStage === 'installer_digest') throw hostile;
              return contract.BASELINE_INSTALLER_SHA256;
            },
          };
        if (specifier === 'node:fs' && failureStage === 'temp')
          return {
            ...fs,
            mkdirSync() {
              throw hostile;
            },
          };
        return scopedRequire(specifier);
      },
    },
    { filename: file }
  );
  const api = module.exports;
  const env = {
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_REPOSITORY: transfer.REPOSITORY,
    GITHUB_API_URL: 'https://api.github.com',
    GH_TOKEN: 'synthetic-private',
    RELEASE_ID: '41',
    INSTALLER_ASSET_ID: '2',
    IDENTITY_ASSET_ID: '3',
    TARGET_SHA: sha,
    GITHUB_SHA: sha,
    GITHUB_WORKSPACE: root,
    RUNNER_TEMP: root,
    TRANSFER_TAG: 'hpm-baseline-transfer-12345678-1234-1234-1234-123456789abc',
  };
  if (failureStage === 'input')
    Object.defineProperty(env, 'GITHUB_ACTIONS', {
      get() {
        throw hostile;
      },
    });
  let releases = 0,
    downloads = 0;
  const dependencies = {
    checkoutCommit() {
      if (failureStage === 'checkout') throw hostile;
      return sha;
    },
    gh(args) {
      const route = args[1];
      if (route === `repos/${transfer.REPOSITORY}`) {
        if (failureStage === 'repository') throw hostile;
        return { full_name: transfer.REPOSITORY, private: true, permissions: { push: true } };
      }
      if (route.endsWith('/assets')) {
        if (failureStage === 'assets') throw hostile;
        return [
          { id: 2, name: transfer.REMOTE_INSTALLER, state: 'uploaded', size: 28541417 },
          { id: 3, name: 'identity.json', state: 'uploaded', size: 250 },
        ];
      }
      if (route.endsWith('/releases/41')) {
        releases++;
        if (
          (failureStage === 'release' && releases === 1) ||
          (failureStage === 'release_recheck' && releases === 2)
        )
          throw hostile;
        return {
          id: 41,
          draft: true,
          published_at: null,
          tag_name: env.TRANSFER_TAG,
          target_commitish: sha,
          body: `hpm-private-baseline-v1:${env.TRANSFER_TAG}`,
        };
      }
      assert.fail('unexpected mock API route');
    },
    async fetch() {
      downloads++;
      if (
        (failureStage === 'download_installer' && downloads === 1) ||
        (failureStage === 'download_identity' && downloads === 2)
      )
        throw hostile;
      return new globalThis.Response(
        downloads === 1
          ? 'synthetic-installer'
          : JSON.stringify(failureStage === 'identity' ? {} : transfer.identity())
      );
    },
  };
  return { root, api, env, dependencies, inspectedErrors: () => inspectedErrors };
}

test('bridge diagnostics preserve a successful synthetic flow and original local filenames', async (t) => {
  const current = fixture(t);
  const directory = await current.api.runBridge(current.env, current.dependencies);
  assert.equal(directory, path.join(current.root, 'hpm-baseline-bridge'));
  assert.deepEqual(fs.readdirSync(directory).sort(), [transfer.INSTALLER, 'identity.json'].sort());
  assert.equal(current.inspectedErrors(), 0);
});

test('every bridge stage wraps failures in its exact fixed code without inspecting the caught error', async (t) => {
  for (const stage of stages)
    await t.test(stage, async (sub) => {
      const current = fixture(sub, stage);
      await assert.rejects(current.api.runBridge(current.env, current.dependencies), (error) => {
        const code = `baseline_bridge_${stage}_refused`;
        assert.equal(error.message, code);
        assert.equal(current.api.formatBridgeError(error), code);
        Object.defineProperty(error, 'message', {
          get() {
            throw new Error('PRIVATE_MUTATED');
          },
        });
        assert.equal(current.api.formatBridgeError(error), code);
        return true;
      });
      assert.equal(current.inspectedErrors(), 0);
    });
});

test('safe bridge formatter rejects spoofed codes, hostile getters, proxies and revoked proxies without inspection', () => {
  let traps = 0;
  const hostile = Object.create(null, {
    message: {
      get() {
        traps++;
        throw new Error('PRIVATE');
      },
    },
  });
  const proxy = new Proxy(
    {},
    {
      get() {
        traps++;
        throw new Error('PRIVATE');
      },
      getPrototypeOf() {
        traps++;
        throw new Error('PRIVATE');
      },
    }
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const error of [
    undefined,
    null,
    '',
    0,
    false,
    Symbol('private'),
    () => {},
    {},
    hostile,
    proxy,
    revoked.proxy,
    new Error('baseline_bridge_repository_refused'),
    { message: 'baseline_bridge_assets_refused' },
  ])
    assert.equal(transfer.formatBridgeError(error), 'baseline_transfer_refused');
  assert.equal(traps, 0);
});

test('CLI outputs only branded fixed codes and masks unknown malicious errors', async () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../scripts/bridge-nsis-baseline.cjs'),
    'utf8'
  );
  let inspected = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        inspected++;
        throw new Error('PRIVATE');
      },
    }
  );
  for (const runBridge of [
    () => transfer.runBridge({}),
    () => Promise.reject(hostile),
    () => Promise.reject(new Error('baseline_bridge_repository_refused\nPRIVATE')),
  ]) {
    let stderr = '',
      stdout = '';
    const process = {
      env: {},
      stderr: {
        write(value) {
          stderr += value;
        },
      },
      stdout: {
        write(value) {
          stdout += value;
        },
      },
      exitCode: undefined,
    };
    await vm.runInNewContext(source, {
      process,
      require: () => ({ runBridge, formatBridgeError: transfer.formatBridgeError }),
    });
    assert.ok(['baseline_bridge_input_refused\n', 'baseline_transfer_refused\n'].includes(stderr));
    assert.equal(stdout, '');
    assert.equal(process.exitCode, 1);
  }
  assert.equal(inspected, 0);
});

test('bridge diagnostic regression is discovered by the unified unit gate', () => {
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes(
      'test/nsis-baseline-bridge-diagnostics.test.js'
    )
  );
});
