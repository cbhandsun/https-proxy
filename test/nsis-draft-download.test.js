'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
const { discoverTestFiles } = require('../lib/test-discovery');
const { unpinnedActionReferences } = require('../lib/ci-governance');
const transfer = require('../scripts/lib/nsis-baseline-transfer');
const { BASELINE_INSTALLER_SHA256 } = require('../scripts/lib/nsis-encrypted-contract');
const { runDraftDownload } = require('../scripts/lib/nsis-draft-download');
const { Response } = globalThis;

const sha = 'a'.repeat(40);
const baselineSha = 'b'.repeat(40);
const identityBytes = JSON.stringify(transfer.identity()) + '\n';
const installerBytes = Buffer.alloc(28541417);
function fixture(t, mode = '') {
  const root = fs.mkdtempSync(path.join(resolvePhysicalTestTempDirectory(), 'hpm-draft-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'current'));
  const env = {
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_REPOSITORY: transfer.REPOSITORY,
    GITHUB_API_URL: 'https://api.github.com',
    GH_TOKEN: 'synthetic-secret',
    RELEASE_ID: '41',
    INSTALLER_ASSET_ID: '2',
    IDENTITY_ASSET_ID: '3',
    GITHUB_SHA: sha,
    BASELINE_TARGET_SHA: baselineSha,
    GITHUB_WORKSPACE: root,
    TRANSFER_TAG: 'hpm-baseline-transfer-12345678-1234-1234-1234-123456789abc',
  };
  const calls = [];
  let metadataReads = 0;
  let anonymousReads = 0;
  const dependencies = {
    checkoutCommit: () => sha,
    metadata(route) {
      calls.push({ route });
      if (route === '') return { full_name: transfer.REPOSITORY, private: mode === 'private-repo' };
      if (route.endsWith('/assets'))
        return [
          { id: 2, name: transfer.REMOTE_INSTALLER, state: 'uploaded', size: 28541417 },
          { id: 3, name: 'identity.json', state: 'uploaded', size: identityBytes.length },
          ...(mode === 'extra-asset' ? [{ id: 4 }] : []),
        ];
      metadataReads++;
      return {
        id: 41,
        draft: !(mode === 'published' || (mode === 'published-after' && metadataReads > 1)),
        published_at: null,
        tag_name: env.TRANSFER_TAG,
        target_commitish: mode === 'wrong-baseline' ? sha : baselineSha,
        body: `hpm-private-baseline-v1:${env.TRANSFER_TAG}`,
      };
    },
    digest(file) {
      assert.equal(file, path.join(root, 'old-baseline', transfer.INSTALLER));
      return mode === 'digest' ? 'f'.repeat(64) : BASELINE_INSTALLER_SHA256;
    },
    async fetch(url, options) {
      calls.push({ url, options });
      assert.equal(options.redirect, 'manual');
      if (!options.headers.authorization) {
        anonymousReads++;
        assert.deepEqual(Object.keys(options.headers), ['accept']);
        if (mode === 'network') throw new Error('synthetic-secret');
        return new Response(null, {
          status:
            mode === 'visible' || (mode === 'visible-after' && anonymousReads > 7)
              ? 302
              : mode === 'rate-limit'
                ? 429
                : 404,
        });
      }
      assert.equal(options.headers.authorization, 'Bearer synthetic-secret');
      if (url.endsWith('/2')) return new Response(mode === 'truncated' ? 'short' : installerBytes);
      return new Response(mode === 'identity' ? '{}'.padEnd(identityBytes.length) : identityBytes);
    },
  };
  return { root, env, dependencies, calls };
}

test('direct draft download pins distinct old/candidate identities and never publishes or uploads', async (t) => {
  const { root, env, dependencies, calls } = fixture(t);
  assert.equal(await runDraftDownload(env, dependencies), path.join(root, 'old-baseline'));
  assert.deepEqual(
    fs.readdirSync(path.join(root, 'old-baseline')).sort(),
    [transfer.INSTALLER, 'identity.json'].sort()
  );
  assert.equal(fs.statSync(path.join(root, 'old-baseline', transfer.INSTALLER)).size, 28541417);
  assert.equal(calls.filter((call) => call.options?.headers.authorization).length, 2);
  assert.equal(
    calls.filter((call) => call.options && !call.options.headers.authorization).length,
    14
  );
  assert.equal(calls.filter((call) => call.route !== undefined).length, 5);
  assert.equal(
    calls.some((call) => call.options?.method),
    false
  );
  await assert.rejects(
    runDraftDownload(env, dependencies),
    /^Error: baseline_draft_download_refused$/
  );
});

test('empty, hostile, extreme and invalid inputs fail before remote or filesystem mutation', async (t) => {
  const { root, env, dependencies } = fixture(t);
  let metadataCalls = 0;
  const noRemote = {
    ...dependencies,
    metadata: () => {
      metadataCalls++;
      throw new Error('remote must not run');
    },
  };
  for (const value of [
    null,
    undefined,
    {},
    new Proxy(
      {},
      {
        get() {
          throw new Error('synthetic-secret');
        },
      }
    ),
  ])
    await assert.rejects(
      runDraftDownload(value, noRemote),
      /^Error: baseline_draft_download_refused$/
    );
  for (const [key, value] of Object.entries({
    GITHUB_ACTIONS: 'false',
    RUNNER_ENVIRONMENT: 'self-hosted',
    GITHUB_REPOSITORY: 'foreign/repo',
    GITHUB_API_URL: 'http://api.github.com',
    GH_TOKEN: 'synthetic\nsecret',
    RELEASE_ID: '9007199254740992',
    INSTALLER_ASSET_ID: '-1',
    IDENTITY_ASSET_ID: '2',
    GITHUB_SHA: 'HEAD',
    BASELINE_TARGET_SHA: '',
    TRANSFER_TAG: '../escape',
    GITHUB_WORKSPACE: '',
  }))
    await assert.rejects(
      runDraftDownload({ ...env, [key]: value }, noRemote),
      /^Error: baseline_draft_download_refused$/
    );
  await assert.rejects(runDraftDownload(env, { ...noRemote, checkoutCommit: () => baselineSha }));
  assert.equal(metadataCalls, 0);
  assert.deepEqual(fs.readdirSync(root), ['current']);
});

test('privacy, metadata and network failures stop before downloading; original private bridge still refuses public repos', async (t) => {
  for (const mode of [
    'private-repo',
    'extra-asset',
    'published',
    'wrong-baseline',
    'visible',
    'rate-limit',
    'network',
  ]) {
    const { root, env, dependencies, calls } = fixture(t, mode);
    await assert.rejects(
      runDraftDownload(env, dependencies),
      /^Error: baseline_draft_download_refused$/
    );
    assert.equal(
      calls.some((call) => call.options?.headers.authorization),
      false,
      mode
    );
    assert.deepEqual(fs.readdirSync(root), ['current'], mode);
  }
  assert.throws(() =>
    transfer.assertRepository({
      full_name: transfer.REPOSITORY,
      private: false,
      permissions: { push: true },
    })
  );
});

test('download corruption and publication/anonymous visibility changes never produce success', async (t) => {
  for (const mode of ['truncated', 'digest', 'identity', 'published-after', 'visible-after']) {
    const { root, env, dependencies } = fixture(t, mode);
    await assert.rejects(
      runDraftDownload(env, dependencies),
      /^Error: baseline_draft_download_refused$/
    );
    assert.equal(fs.existsSync(path.join(root, 'old-baseline')), true);
  }
});

test('draft download tests enter unified discovery and CLI has only bounded failure output', () => {
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes('test/nsis-draft-download.test.js')
  );
  const cli = require('node:child_process').spawnSync(
    process.execPath,
    ['scripts/download-nsis-draft.cjs'],
    {
      encoding: 'utf8',
      env: {},
      windowsHide: true,
    }
  );
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, '');
  assert.equal(cli.stderr, 'baseline_draft_download_refused\n');
});

test('direct encrypted workflow retains full gates and private artifact workflow remains separate', () => {
  const workflow = fs.readFileSync(
    '.github/workflows/windows-encrypted-draft-lifecycle.yml',
    'utf8'
  );
  assert.deepEqual(unpinnedActionReferences(workflow), []);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /permissions: \{\}/);
  assert.equal((workflow.match(/contents: write/g) || []).length, 1);
  assert.equal((workflow.match(/GH_TOKEN:/g) || []).length, 2);
  const tokenSteps = workflow.split(/(?=^ {6}-)/m).filter((step) => step.includes('GH_TOKEN:'));
  assert.equal(tokenSteps.length, 2);
  for (const step of tokenSteps) {
    assert.match(step, /GH_TOKEN: \$\{\{ github.token \}\}/);
    assert.match(
      step,
      /node current\/scripts\/(?:download-nsis-draft|receive-legacy-runtime)\.cjs/
    );
    assert.doesNotMatch(step, /qualify-|restore-legacy-runtime/);
  }
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /path: current/);
  assert.match(workflow, /npm run verify/);
  assert.match(workflow, /npm audit --audit-level=high/);
  assert.match(workflow, /qualify-nsis-lifecycle.ps1.*-EncryptedRecovery/);
  assert.doesNotMatch(
    workflow,
    /upload-artifact|continue-on-error|secrets\.|pull_request:|push:|release create|release upload/
  );
  assert.ok(
    workflow.indexOf('node current/scripts/download-nsis-draft.cjs') < workflow.indexOf('npm ci')
  );
  const original = fs.readFileSync('.github/workflows/windows-encrypted-lifecycle.yml', 'utf8');
  assert.match(original, /Receive-HpmPrivateBaselineArtifact/);
  assert.doesNotMatch(original, /contents: write|download-nsis-draft/);
});

test('failed candidate diagnostics retain the failed gate and cannot authorize build or installation', () => {
  const workflow = fs
    .readFileSync('.github/workflows/windows-encrypted-draft-lifecycle.yml', 'utf8')
    .replaceAll('\r\n', '\n');
  const diagnostic = workflow
    .split('      - name: Diagnose isolated native open after candidate gate failure\n')[1]
    ?.split('      - name: Build current test installer without publishing')[0];
  assert.ok(diagnostic);
  assert.match(
    diagnostic,
    /if: \$\{\{ failure\(\) && steps\.candidate_gates\.outcome == 'failure' \}\}/
  );
  assert.match(diagnostic, /working-directory: current/);
  assert.match(diagnostic, /node scripts\/diagnose-context-recovery-open\.js/);
  assert.match(diagnostic, /if \(\$LASTEXITCODE -ne 0\) \{ throw /);
  assert.doesNotMatch(
    diagnostic,
    /continue-on-error|--(?:timeout|directory)|qualify-|npm run verify|upload|secrets\.|GH_TOKEN/
  );
  const build = workflow
    .split('      - name: Build current test installer without publishing')[1]
    ?.split('      - name: Qualify installed same-format')[0];
  assert.ok(build);
  assert.doesNotMatch(build, /if:|continue-on-error/);
  assert.ok(workflow.indexOf('npm run verify') < workflow.indexOf('Diagnose isolated native open'));
});

test('582 installed migration is ordered after full gates and actual same-format install, before original clients', () => {
  const workflow = fs.readFileSync(
    '.github/workflows/windows-encrypted-draft-lifecycle.yml',
    'utf8'
  );
  const steps = [
    'receive-legacy-runtime.cjs',
    'restore-legacy-runtime.ps1',
    'npm run verify',
    'tauri.js build',
    'qualify-nsis-lifecycle.ps1',
    'qualify-nsis-installed-legacy-582.ps1',
    'qualify-nsis-installed-clients.ps1',
  ].map((name) => workflow.indexOf(name));
  assert.ok(steps.every((offset) => offset > 0));
  assert.ok(steps.every((offset, index) => index === 0 || offset > steps[index - 1]));
  const migration = workflow
    .split('      - name: Qualify installed default-worker 582 migration and old-reader refusal')[1]
    .split('      - name: Qualify installed Codex')[0];
  assert.doesNotMatch(migration, /if:|continue-on-error|GH_TOKEN|secrets/);
  assert.match(migration, /-CurrentSha \$env:CURRENT_SHA/);
  const files = discoverTestFiles(path.resolve(__dirname, '..'));
  for (const name of [
    'legacy-runtime-transfer.test.js',
    'legacy-runtime-archive.test.js',
    'installed-legacy-receipt.test.js',
    'installed-legacy-entry.test.js',
  ]) {
    assert.ok(
      files.some((file) => file.endsWith(name)),
      name
    );
  }
});
