'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { discoverTestFiles } = require('../lib/test-discovery');
const { unpinnedActionReferences } = require('../lib/ci-governance');
const transfer = require('../scripts/lib/nsis-baseline-transfer');
const { Response, ReadableStream } = globalThis;
const sha = 'a'.repeat(40);
const remoteInstaller = 'HTTPS.Proxy.Manager_0.1.0_x64-setup.exe';
const repo = { full_name: transfer.REPOSITORY, private: true, permissions: { push: true } };
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-transfer-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test('local transfer defaults dry-run and rejects invalid options, missing or failed archives before remote calls', (t) => {
  const archive = temporary(t);
  assert.deepEqual(transfer.parseOptions(['--archive', archive, '--target', sha]), {
    execute: false,
    archive,
    target: sha,
  });
  for (const args of [
    [],
    ['--execute'],
    ['--target', sha],
    ['--archive', archive, '--target', 'HEAD'],
    ['--archive', archive, '--target', sha, '--execute', '--execute'],
    ['--archive', archive, '--target', sha, '--clobber'],
  ])
    assert.throws(() => transfer.parseOptions(args));
  assert.throws(() => transfer.validateArchive(archive));
  fs.writeFileSync(path.join(archive, 'archive-receipt.json'), JSON.stringify({ passed: false }));
  assert.throws(() => transfer.validateArchive(archive));
  assert.throws(() =>
    transfer.prepareTransfer(
      { archive, target: sha, execute: true },
      { gh: () => assert.fail('must not contact remote') }
    )
  );
  const result = transfer.prepareTransfer(
    { archive, target: sha, execute: false },
    {
      validateArchive: () => ({ receiptSha256: 'b'.repeat(64) }),
      gh: () => assert.fail('dry-run remote call'),
    }
  );
  assert.equal(result.remoteWrites, 0);
  assert.equal(fs.readdirSync(archive).length, 1);
  const cli = spawnSync(
    process.execPath,
    ['scripts/transfer-nsis-baseline.cjs', '--archive', archive, '--target', sha],
    { encoding: 'utf8' }
  );
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, '');
  assert.doesNotMatch(cli.stderr, /token|headers|cookie|\{.*passed/);
});
test('strict identity, private repository, release ownership and exact assets reject hostile boundaries', () => {
  transfer.assertIdentity(transfer.identity());
  for (const value of [
    null,
    [],
    {},
    { ...transfer.identity(), token: 'private' },
    { ...transfer.identity(), sourceCount: '625' },
  ])
    assert.throws(() => transfer.assertIdentity(value));
  transfer.assertRepository(repo);
  for (const value of [
    null,
    {},
    { ...repo, private: false },
    { ...repo, permissions: { push: false } },
    { ...repo, full_name: 'attacker/repo' },
  ])
    assert.throws(() => transfer.assertRepository(value));
  const expected = { id: 1, tag: 'owned', target: sha, marker: 'marker' };
  const release = {
    id: 1,
    draft: true,
    published_at: null,
    tag_name: 'owned',
    target_commitish: sha,
    body: 'marker',
  };
  transfer.assertRelease(release, expected);
  for (const patch of [
    { draft: false },
    { id: 2 },
    { published_at: 'now' },
    { body: 'foreign' },
    { target_commitish: 'main' },
  ])
    assert.throws(() => transfer.assertRelease({ ...release, ...patch }, expected));
  const assets = [
    { id: 2, name: remoteInstaller, state: 'uploaded', size: 28541417 },
    { id: 3, name: 'identity.json', state: 'uploaded', size: 250 },
  ];
  transfer.assertAssets(assets, [2, 3]);
  for (const value of [
    [],
    [...assets, assets[0]],
    [{ ...assets[0], size: 28541418 }, assets[1]],
    [assets[0], { ...assets[1], size: 4097 }],
    [assets[0], { ...assets[1], state: 'starter' }],
  ])
    assert.throws(() => transfer.assertAssets(value, [2, 3]));
  assert.throws(() => transfer.assertAssets(assets, [2, 2]));
});
test('GitHub canonical asset name is exact and distinct from the unchanged local installer name', () => {
  assert.equal(transfer.INSTALLER, 'HTTPS Proxy Manager_0.1.0_x64-setup.exe');
  assert.equal(transfer.REMOTE_INSTALLER, remoteInstaller);
  assert.notEqual(transfer.INSTALLER, transfer.REMOTE_INSTALLER);
  const installer = { id: 2, name: remoteInstaller, state: 'uploaded', size: 28541417 };
  const identity = { id: 3, name: 'identity.json', state: 'uploaded', size: 250 };
  assert.deepEqual(transfer.assertAssets([identity, installer], [2, 3]), [installer, identity]);
  for (const name of [
    transfer.INSTALLER,
    '',
    null,
    undefined,
    'HTTPS_Proxy_Manager_0.1.0_x64-setup.exe',
    'https.proxy.manager_0.1.0_x64-setup.exe',
    'HTTPS%20Proxy%20Manager_0.1.0_x64-setup.exe',
    `../${remoteInstaller}`,
    `${remoteInstaller}.exe`,
    `${remoteInstaller}\n`,
  ])
    assert.throws(() => transfer.assertAssets([{ ...installer, name }, identity], [2, 3]));
});
function remoteMock(calls, failure) {
  let release;
  return (args, input) => {
    calls.push(args);
    const route = args.find((value) => value.startsWith('repos/'));
    if (args[0] === 'release') {
      if (failure) throw new Error('hidden token secret');
      return null;
    }
    if (args.includes('POST')) {
      const body = JSON.parse(input);
      release = {
        id: 41,
        draft: body.draft,
        published_at: null,
        tag_name: body.tag_name,
        target_commitish: body.target_commitish,
        body: body.body,
      };
      return release;
    }
    if (args.includes('DELETE')) return null;
    if (route.endsWith('/assets'))
      return [
        { id: 2, name: remoteInstaller, state: 'uploaded', size: 28541417 },
        { id: 3, name: 'identity.json', state: 'uploaded', size: 250 },
      ];
    if (route.includes('/releases/')) return release;
    if (route.includes('/matching-refs/')) return [];
    if (route.includes('/commits/')) return { sha };
    return repo;
  };
}
test('execute lifecycle is mock-only, pins target and draft, uploads only two files; failure preserves remote resources', (t) => {
  for (const failure of [false, true]) {
    const archive = temporary(t);
    const calls = [];
    const dependencies = {
      validateArchive: () => ({
        installer: path.join(archive, transfer.INSTALLER),
        receiptSha256: 'b'.repeat(64),
      }),
      gh: remoteMock(calls, failure),
    };
    const options = { archive, target: sha, execute: true };
    if (failure)
      assert.throws(
        () => transfer.prepareTransfer(options, dependencies),
        /^Error: baseline_transfer_refused$/
      );
    else {
      const result = transfer.prepareTransfer(options, dependencies);
      assert.deepEqual(result.assetIds, [2, 3]);
      assert.equal(result.status, 'uploaded');
    }
    assert.equal(
      calls.some((args) => args.includes('--clobber')),
      false
    );
    assert.equal(
      calls.some((args) => args.includes('DELETE')),
      false
    );
    assert.equal(
      calls.some(
        (args) => args.includes('DELETE') && args.some((value) => value.includes('/git/refs/'))
      ),
      false
    );
    const upload = calls.find((args) => args[0] === 'release');
    assert.equal(upload.length, 7);
    assert.equal(upload[3], path.join(archive, transfer.INSTALLER));
    assert.equal(path.basename(upload[3]), 'HTTPS Proxy Manager_0.1.0_x64-setup.exe');
    const folder = fs.readdirSync(archive)[0];
    const state = JSON.parse(fs.readFileSync(path.join(archive, folder, 'transfer-state.json')));
    assert.equal(state.target, sha);
    assert.equal(state.cleanupRequired, true);
    if (failure) assert.equal(state.remoteResourcesPreserved, true);
    assert.equal(state.draftRemoved, undefined);
  }
});
test('bounded download refuses overflow, malformed length, truncation and network failure without writing excess', async (t) => {
  const archive = temporary(t);
  for (const [bytes, headers, maximum, success] of [
    ['abc', {}, 3, true],
    ['', {}, 3, true],
    ['abcd', {}, 3, false],
    ['ab', { 'content-length': '3' }, 3, false],
    ['abc', { 'content-length': 'NaN' }, 3, false],
    ['abc', { 'content-length': '4' }, 3, false],
  ]) {
    const file = path.join(archive, `output-${fs.readdirSync(archive).length}`);
    const fd = fs.openSync(file, 'wx');
    try {
      const result = transfer.readBounded(new Response(bytes, { headers }), maximum, fd);
      if (success) assert.equal(await result, bytes.length);
      else await assert.rejects(result);
    } finally {
      fs.closeSync(fd);
    }
    assert.ok(fs.statSync(file).size <= maximum);
  }
  await assert.rejects(transfer.readBounded(new Response('denied', { status: 403 }), 20));
  await assert.rejects(
    transfer.readBounded(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error('secret'));
          },
        })
      ),
      20
    )
  );
});
test('asset redirect allowlist strips authorization and refuses unsafe redirects; bridge refuses non-hosted and invalid inputs', async (t) => {
  const archive = temporary(t);
  const requests = [];
  const request = async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1
      ? new Response(null, {
          status: 302,
          headers: { location: 'https://release-assets.githubusercontent.com/owned' },
        })
      : new Response('abc');
  };
  await transfer.fetchAsset(2, 'synthetic-private', path.join(archive, 'safe'), 3, request);
  assert.equal(requests[0].options.headers.authorization, 'Bearer synthetic-private');
  assert.equal(requests[1].options.headers, undefined);
  for (const location of [
    'http://release-assets.githubusercontent.com/x',
    'https://attacker.invalid/x',
    'https://token@release-assets.githubusercontent.com/x',
    'https://release-assets.githubusercontent.com:444/x',
  ])
    await assert.rejects(
      transfer.fetchAsset(
        2,
        'synthetic',
        path.join(archive, 'refused'),
        3,
        async () => new Response(null, { status: 302, headers: { location } })
      )
    );
  await assert.rejects(transfer.runBridge({}, { gh: () => assert.fail('not hosted') }));
});
test('bridge is manual-only, pinned, job-scoped write, exact upload paths, and independently discovered by unified CI', () => {
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes('test/nsis-baseline-transfer.test.js')
  );
  const workflow = fs.readFileSync(
    '.github/workflows/windows-baseline-artifact-bridge.yml',
    'utf8'
  );
  assert.deepEqual(unpinnedActionReferences(workflow), []);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions: \{\}/);
  assert.equal((workflow.match(/contents: write/g) || []).length, 1);
  assert.match(workflow, /retention-days: 1/);
  assert.match(workflow, /overwrite: false/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.doesNotMatch(
    workflow,
    /continue-on-error|secrets\.|pull_request:|push:|\.\/.*\.exe|npm |release create/
  );
  assert.ok(
    workflow.indexOf('node scripts/bridge-nsis-baseline.cjs') <
      workflow.indexOf('uses: actions/upload-artifact')
  );
  const qualification = fs.readFileSync(
    '.github/workflows/windows-encrypted-lifecycle.yml',
    'utf8'
  );
  assert.doesNotMatch(qualification, /contents: write|upload-artifact/);
});

test('bridge validates every runtime input before remote access and rejects changed asset bytes after bounded download', async (t) => {
  const root = temporary(t);
  const env = {
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_REPOSITORY: transfer.REPOSITORY,
    GITHUB_API_URL: 'https://api.github.com',
    GH_TOKEN: 'synthetic-secret',
    RELEASE_ID: '41',
    INSTALLER_ASSET_ID: '2',
    IDENTITY_ASSET_ID: '3',
    TARGET_SHA: sha,
    GITHUB_SHA: sha,
    GITHUB_WORKSPACE: root,
    TRANSFER_TAG: 'hpm-baseline-transfer-12345678-1234-1234-1234-123456789abc',
    RUNNER_TEMP: root,
  };
  for (const [key, value] of Object.entries({
    GITHUB_ACTIONS: 'false',
    RUNNER_ENVIRONMENT: 'self-hosted',
    GITHUB_REPOSITORY: 'foreign/repo',
    GITHUB_API_URL: 'http://api.github.com',
    GH_TOKEN: '',
    RELEASE_ID: '-1',
    INSTALLER_ASSET_ID: '2;exit',
    IDENTITY_ASSET_ID: '0',
    TARGET_SHA: 'main',
    GITHUB_SHA: 'f'.repeat(40),
    TRANSFER_TAG: '../escape',
  })) {
    await assert.rejects(
      transfer.runBridge(
        { ...env, [key]: value },
        { gh: () => assert.fail('invalid input reached remote') }
      )
    );
  }
  let downloaded = 0;
  const api = (args) => {
    const route = args.find((value) => value.startsWith('repos/'));
    if (route.endsWith('/assets'))
      return [
        { id: 2, name: remoteInstaller, state: 'uploaded', size: 28541417 },
        { id: 3, name: 'identity.json', state: 'uploaded', size: 250 },
      ];
    if (route.includes('/releases/'))
      return {
        id: 41,
        draft: true,
        published_at: null,
        tag_name: env.TRANSFER_TAG,
        target_commitish: sha,
        body: `hpm-private-baseline-v1:${env.TRANSFER_TAG}`,
      };
    return repo;
  };
  await assert.rejects(
    transfer.runBridge(env, {
      checkoutCommit: () => sha,
      gh: api,
      fetch: async () => {
        downloaded++;
        return new Response(
          downloaded === 1 ? 'tampered-exe' : JSON.stringify(transfer.identity())
        );
      },
    })
  );
  assert.equal(downloaded, 2);
  assert.equal(
    fs.readFileSync(path.join(root, 'hpm-baseline-bridge', transfer.INSTALLER), 'utf8'),
    'tampered-exe'
  );
  assert.equal(fs.existsSync(path.join(root, 'hpm-baseline-bridge', remoteInstaller)), false);
  await assert.rejects(
    transfer.runBridge(env, {
      checkoutCommit: () => sha,
      gh: api,
      fetch: () => assert.fail('must refuse stale output'),
    })
  );
});

test('local execution refuses unavailable target and always preserves changed, unknown or extra remote assets', (t) => {
  for (const mode of ['target', 'create', 'foreign-cleanup', 'unknown-asset']) {
    const archive = temporary(t);
    const calls = [];
    const base = remoteMock(calls, mode !== 'unknown-asset');
    const api = (args, input) => {
      if (mode === 'target' && args.some((value) => value.includes('/commits/')))
        return { sha: 'f'.repeat(40) };
      if (mode === 'create' && args.includes('POST')) throw new Error('ambiguous timed-out create');
      const response = base(args, input);
      if (mode === 'unknown-asset' && args.some((value) => value.endsWith('/assets')))
        return [...response, { id: 100, name: 'unknown-user-data', size: 100, state: 'uploaded' }];
      if (
        mode === 'foreign-cleanup' &&
        args.some((value) => /\/releases\/41$/.test(value)) &&
        !args.includes('POST')
      )
        return { ...response, body: 'foreign-owner' };
      return response;
    };
    assert.throws(() =>
      transfer.prepareTransfer(
        { archive, target: sha, execute: true },
        {
          validateArchive: () => ({
            installer: path.join(archive, transfer.INSTALLER),
            receiptSha256: 'b'.repeat(64),
          }),
          gh: api,
        }
      )
    );
    assert.equal(
      calls.some((args) => args.includes('DELETE')),
      false
    );
    if (mode === 'target') assert.equal(fs.readdirSync(archive).length, 0);
    else {
      const state = JSON.parse(
        fs.readFileSync(path.join(archive, fs.readdirSync(archive)[0], 'transfer-state.json'))
      );
      assert.equal(state.status, 'failed');
      assert.equal(state.cleanupRequired, true);
      assert.equal(state.remoteResourcesPreserved, true);
    }
  }
});

test('gh subprocess pins github.com despite inherited host and repository overrides', () => {
  const inherited = {
    GH_HOST: 'enterprise.invalid',
    GH_REPO: 'enterprise.invalid/cbhandsun/https-proxy',
    GH_DEBUG: 'api',
    GH_TOKEN: 'synthetic-secret',
    Gh_Host: 'mixed-enterprise.invalid',
    gh_repo: 'mixed-enterprise.invalid/foreign/repo',
    Gh_Debug: 'api',
    gh_prompt_disabled: '0',
  };
  const api = transfer.ghInvocation(['api', 'repos/cbhandsun/https-proxy'], inherited);
  assert.deepEqual(api.args, ['api', '--hostname', 'github.com', 'repos/cbhandsun/https-proxy']);
  assert.equal(api.env.GH_HOST, 'github.com');
  assert.equal(api.env.GH_REPO, 'github.com/cbhandsun/https-proxy');
  assert.equal(api.env.GH_DEBUG, '');
  assert.equal(api.env.GH_TOKEN, inherited.GH_TOKEN);
  for (const key of ['Gh_Host', 'gh_repo', 'Gh_Debug', 'gh_prompt_disabled'])
    assert.equal(Object.hasOwn(api.env, key), false);
  const upload = [
    'release',
    'upload',
    'owned',
    'installer',
    'identity',
    '--repo',
    'github.com/cbhandsun/https-proxy',
  ];
  assert.deepEqual(transfer.ghInvocation(upload, inherited).args, upload);
  for (const args of [
    ['api', '--hostname', 'enterprise.invalid', 'repos/cbhandsun/https-proxy'],
    ['api', '--hostname=enterprise.invalid'],
    [...upload.slice(0, -1), 'cbhandsun/https-proxy'],
    ['release', 'delete', 'owned'],
    [],
  ])
    assert.throws(() => transfer.ghInvocation(args, inherited));
  assert.equal(inherited.GH_HOST, 'enterprise.invalid');
});

test('dispatch, transfer target and checked-out HEAD must all match before remote access', async (t) => {
  const root = temporary(t);
  const gitOptions = transfer.gitInvocation(root, {
    PATH: 'synthetic',
    GIT_DIR: 'foreign',
    Git_Work_Tree: 'foreign',
    git_config_count: '1',
    GIT_TRACE: '1',
  });
  assert.deepEqual(gitOptions.env, { PATH: 'synthetic' });
  assert.equal(gitOptions.cwd, root);
  const env = {
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_REPOSITORY: transfer.REPOSITORY,
    GITHUB_API_URL: 'https://api.github.com',
    GH_TOKEN: 'synthetic',
    RELEASE_ID: '41',
    INSTALLER_ASSET_ID: '2',
    IDENTITY_ASSET_ID: '3',
    TARGET_SHA: sha,
    GITHUB_SHA: sha,
    GITHUB_WORKSPACE: root,
    TRANSFER_TAG: 'hpm-baseline-transfer-12345678-1234-1234-1234-123456789abc',
    RUNNER_TEMP: root,
  };
  await assert.rejects(
    transfer.runBridge(
      { ...env, GITHUB_SHA: 'f'.repeat(40) },
      {
        checkoutCommit: () => assert.fail('dispatch mismatch must stop first'),
        gh: () => assert.fail('must not reach remote'),
      }
    )
  );
  await assert.rejects(
    transfer.runBridge(env, {
      checkoutCommit: () => 'f'.repeat(40),
      gh: () => assert.fail('checkout mismatch must stop before remote'),
    })
  );
  assert.throws(() => transfer.checkoutCommit(root));
  const workflow = fs.readFileSync(
    '.github/workflows/windows-baseline-artifact-bridge.yml',
    'utf8'
  );
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}/);
  assert.match(workflow, /\$env:GITHUB_SHA -cne \$env:TARGET_SHA/);
  assert.ok(
    workflow.indexOf('Bridge dispatch and target identity mismatch') <
      workflow.indexOf('uses: actions/checkout')
  );
});
