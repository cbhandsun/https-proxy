'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  safePath,
  digest,
  BASELINE_INSTALLER_SHA256,
  BASELINE_MANIFEST_SHA256,
} = require('./nsis-encrypted-contract');
const REPOSITORY = 'cbhandsun/https-proxy';
const INSTALLER = 'HTTPS Proxy Manager_0.1.0_x64-setup.exe';
// GitHub canonicalizes spaces in uploaded release asset names to periods.
const REMOTE_INSTALLER = 'HTTPS.Proxy.Manager_0.1.0_x64-setup.exe';
const fail = () => new Error('baseline_transfer_refused');
const bridgeFailureCodes = Object.freeze({
  input: 'baseline_bridge_input_refused',
  checkout: 'baseline_bridge_checkout_refused',
  repository: 'baseline_bridge_repository_refused',
  release: 'baseline_bridge_release_refused',
  assets: 'baseline_bridge_assets_refused',
  temp: 'baseline_bridge_temp_refused',
  download_installer: 'baseline_bridge_download_installer_refused',
  download_identity: 'baseline_bridge_download_identity_refused',
  installer_digest: 'baseline_bridge_installer_digest_refused',
  identity: 'baseline_bridge_identity_refused',
  release_recheck: 'baseline_bridge_release_recheck_refused',
});
const bridgeFailures = new WeakMap();
async function bridgeStage(stage, operation) {
  try {
    return await operation();
  } catch {
    const code = bridgeFailureCodes[stage];
    const error = new Error(code);
    bridgeFailures.set(error, code);
    throw error;
  }
}
function formatBridgeError(error) {
  // Do not inspect untrusted errors, including their message, cause or Proxy traps.
  return (
    (error !== null && typeof error === 'object' && bridgeFailures.get(error)) ||
    'baseline_transfer_refused'
  );
}
const identity = () => ({
  installerSha256: BASELINE_INSTALLER_SHA256,
  manifestSha256: BASELINE_MANIFEST_SHA256,
  sourceCount: 625,
});
function assertIdentity(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(Object.keys(identity()).sort()) ||
    Object.entries(identity()).some(([key, expected]) => value[key] !== expected)
  )
    throw fail();
}
function parseOptions(args) {
  if (!Array.isArray(args)) throw fail();
  const options = { execute: false };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--execute' && !options.execute) options.execute = true;
    else if (
      ['--archive', '--target'].includes(key) &&
      !options[key.slice(2)] &&
      typeof args[i + 1] === 'string'
    )
      options[key.slice(2)] = args[++i];
    else throw fail();
  }
  if (!options.archive || !/^[a-f0-9]{40}$/.test(options.target || '')) throw fail();
  return options;
}
function validateArchive(archive) {
  safePath(archive, true);
  const receiptFile = safePath(path.join(archive, 'archive-receipt.json'));
  if (fs.statSync(receiptFile).size > 8 * 1024 * 1024) throw fail();
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  if (
    receipt.passed !== true ||
    receipt.kind !== 'immutable-old-artifact-archive' ||
    receipt.installerSha256 !== BASELINE_INSTALLER_SHA256 ||
    receipt.manifestSha256 !== BASELINE_MANIFEST_SHA256 ||
    receipt.sourceCount !== 625 ||
    receipt.sourceUnchangedAcrossCopy !== true ||
    receipt.bundledNodeNativeLockAndDependenciesCopied !== true ||
    receipt.installersExecuted !== false ||
    receipt.packagedCodeExecuted !== false ||
    receipt.modelRequests !== 0
  )
    throw fail();
  const installer = safePath(path.join(archive, INSTALLER));
  if (
    fs.statSync(installer).size !== 28541417 ||
    digest(installer) !== BASELINE_INSTALLER_SHA256 ||
    digest(safePath(path.join(archive, 'runtime/release-runtime-manifest.json'))) !==
      BASELINE_MANIFEST_SHA256
  )
    throw fail();
  return { installer, receiptSha256: digest(receiptFile) };
}
function ghInvocation(args, environment = process.env) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) throw fail();
  let pinned;
  if (args[0] === 'api' && !args.some((value) => /^--hostname(?:=|$)/.test(value)))
    pinned = ['api', '--hostname', 'github.com', ...args.slice(1)];
  else if (
    args[0] === 'release' &&
    args[1] === 'upload' &&
    args.at(-2) === '--repo' &&
    args.at(-1) === `github.com/${REPOSITORY}`
  )
    pinned = [...args];
  else throw fail();
  const sanitized = Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        !['GH_HOST', 'GH_REPO', 'GH_PROMPT_DISABLED', 'GH_DEBUG'].includes(key.toUpperCase())
    )
  );
  return {
    args: pinned,
    env: {
      ...sanitized,
      GH_HOST: 'github.com',
      GH_REPO: `github.com/${REPOSITORY}`,
      GH_PROMPT_DISABLED: '1',
      GH_DEBUG: '',
    },
  };
}
function gh(args, input) {
  const pinned = ghInvocation(args);
  const result = spawnSync('gh', pinned.args, {
    env: pinned.env,
    input,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0) throw fail();
  if (args[0] === 'release') return null;
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
function assertRelease(release, expected) {
  if (
    !release ||
    release.id !== expected.id ||
    release.draft !== true ||
    release.published_at !== null ||
    release.tag_name !== expected.tag ||
    release.target_commitish !== expected.target ||
    release.body !== expected.marker
  )
    throw fail();
}
function assertRepository(value) {
  if (
    !value ||
    value.full_name !== REPOSITORY ||
    value.private !== true ||
    value.permissions?.push !== true
  )
    throw fail();
}
function assertAssets(assets, ids) {
  if (
    !Array.isArray(assets) ||
    assets.length !== 2 ||
    !Array.isArray(ids) ||
    ids.length !== 2 ||
    ids[0] === ids[1]
  )
    throw fail();
  const ordered = ids.map((id) => assets.find((asset) => asset.id === id));
  for (const [index, asset] of ordered.entries()) {
    if (
      !asset ||
      !Number.isSafeInteger(asset.id) ||
      asset.id < 1 ||
      asset.state !== 'uploaded' ||
      asset.name !== [REMOTE_INSTALLER, 'identity.json'][index] ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 1 ||
      asset.size > [28541417, 4096][index] ||
      (index === 0 && asset.size !== 28541417)
    )
      throw fail();
  }
  return ordered;
}
function prepareTransfer(options, dependencies = {}) {
  if (
    !options ||
    typeof options.execute !== 'boolean' ||
    !/^[a-f0-9]{40}$/.test(options.target || '') ||
    typeof options.archive !== 'string' ||
    !path.isAbsolute(options.archive)
  )
    throw fail();
  const validate = dependencies.validateArchive || validateArchive;
  const api = dependencies.gh || gh;
  const checked = validate(options.archive);
  if (!options.execute)
    return {
      mode: 'dry-run',
      repository: REPOSITORY,
      target: options.target,
      receiptSha256: checked.receiptSha256,
      remoteWrites: 0,
    };
  assertRepository(api(['api', `repos/${REPOSITORY}`]));
  const commit = api(['api', `repos/${REPOSITORY}/commits/${options.target}`]);
  if (commit?.sha !== options.target) throw fail();
  const tag = `hpm-baseline-transfer-${randomUUID()}`;
  if (api(['api', `repos/${REPOSITORY}/git/matching-refs/tags/${tag}`])?.length !== 0) throw fail();
  const marker = `hpm-private-baseline-v1:${tag}`;
  const stateDirectory = fs.mkdtempSync(path.join(safePath(options.archive, true), 'transfer-'));
  const identityFile = path.join(stateDirectory, 'identity.json');
  fs.writeFileSync(identityFile, JSON.stringify(identity()) + '\n', { flag: 'wx' });
  assertIdentity(JSON.parse(fs.readFileSync(identityFile, 'utf8')));
  const stateFile = path.join(stateDirectory, 'transfer-state.json');
  const state = {
    repository: REPOSITORY,
    tag,
    target: options.target,
    marker,
    id: null,
    status: 'prepared',
    cleanupRequired: true,
  };
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
  save();
  try {
    const release = api(
      ['api', '--method', 'POST', `repos/${REPOSITORY}/releases`, '--input', '-'],
      JSON.stringify({
        tag_name: tag,
        target_commitish: options.target,
        name: tag,
        body: marker,
        draft: true,
        prerelease: false,
        make_latest: 'false',
      })
    );
    if (!Number.isSafeInteger(release?.id) || release.id < 1) throw fail();
    state.id = release.id;
    save();
    assertRelease(release, state);
    validate(options.archive);
    api([
      'release',
      'upload',
      tag,
      checked.installer,
      identityFile,
      '--repo',
      `github.com/${REPOSITORY}`,
    ]);
    assertRelease(api(['api', `repos/${REPOSITORY}/releases/${state.id}`]), state);
    const assets = api(['api', `repos/${REPOSITORY}/releases/${state.id}/assets`]);
    const ids = [REMOTE_INSTALLER, 'identity.json'].map(
      (name) => assets.find((asset) => asset.name === name)?.id
    );
    assertAssets(assets, ids);
    state.assetIds = ids;
    state.status = 'uploaded';
    save();
    return { ...state, stateFile };
  } catch {
    state.status = 'failed';
    // Never delete a draft after failure: another writer may have added assets.
    // Keep all remote resources for separate explicit ownership reconciliation.
    state.cleanupRequired = true;
    state.remoteResourcesPreserved = true;
    save();
    throw fail();
  }
}
async function readBounded(response, maximum, output) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 104857600) throw fail();
  if (!response.ok || !response.body) throw fail();
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) throw fail();
  let total = 0;
  const chunks = [];
  try {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > maximum) throw fail();
      if (output !== undefined) fs.writeFileSync(output, chunk);
      else chunks.push(Buffer.from(chunk));
    }
  } catch {
    await response.body.cancel().catch(() => {});
    throw fail();
  }
  if (length !== null && Number(length) !== total) throw fail();
  return output !== undefined ? total : Buffer.concat(chunks);
}
async function fetchAsset(id, token, destination, maximum, request = fetch) {
  const url = `https://api.github.com/repos/${REPOSITORY}/releases/assets/${id}`;
  let response = await request(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/octet-stream',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'manual',
    signal: globalThis.AbortSignal.timeout(30000),
  });
  if (response.status === 302) {
    const redirect = new URL(response.headers.get('location'));
    if (
      redirect.protocol !== 'https:' ||
      !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(
        redirect.hostname
      ) ||
      redirect.username ||
      redirect.password ||
      redirect.port
    )
      throw fail();
    await response.body?.cancel();
    // The signed cross-origin URL must never receive the repository token.
    response = await request(redirect.href, {
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(30000),
    });
  }
  const fd = fs.openSync(destination, 'wx');
  try {
    return await readBounded(response, maximum, fd);
  } finally {
    fs.closeSync(fd);
  }
}
function gitInvocation(workspace, environment = process.env) {
  return {
    cwd: safePath(workspace, true),
    env: Object.fromEntries(
      Object.entries(environment).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
    ),
  };
}
function checkoutCommit(workspace) {
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    ...gitInvocation(workspace),
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw fail();
  return result.stdout.trim();
}
async function runBridge(env, dependencies = {}) {
  const api = dependencies.gh || gh;
  const positive = (value) =>
    typeof value === 'string' &&
    /^[1-9][0-9]{0,14}$/.test(value) &&
    Number.isSafeInteger(Number(value));
  await bridgeStage('input', () => {
    if (
      env.GITHUB_ACTIONS !== 'true' ||
      env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      env.GITHUB_REPOSITORY !== REPOSITORY ||
      env.GITHUB_API_URL !== 'https://api.github.com' ||
      !env.GH_TOKEN ||
      !positive(env.RELEASE_ID) ||
      !positive(env.INSTALLER_ASSET_ID) ||
      !positive(env.IDENTITY_ASSET_ID) ||
      !/^[a-f0-9]{40}$/.test(env.TARGET_SHA || '') ||
      env.GITHUB_SHA !== env.TARGET_SHA ||
      !/^hpm-baseline-transfer-[a-f0-9-]{36}$/.test(env.TRANSFER_TAG || '')
    )
      throw fail();
  });
  await bridgeStage('checkout', () => {
    if ((dependencies.checkoutCommit || checkoutCommit)(env.GITHUB_WORKSPACE) !== env.TARGET_SHA)
      throw fail();
  });
  await bridgeStage('repository', () => assertRepository(api(['api', `repos/${REPOSITORY}`])));
  const expected = {
    id: Number(env.RELEASE_ID),
    tag: env.TRANSFER_TAG,
    target: env.TARGET_SHA,
    marker: `hpm-private-baseline-v1:${env.TRANSFER_TAG}`,
  };
  await bridgeStage('release', () =>
    assertRelease(api(['api', `repos/${REPOSITORY}/releases/${expected.id}`]), expected)
  );
  const ids = [Number(env.INSTALLER_ASSET_ID), Number(env.IDENTITY_ASSET_ID)];
  await bridgeStage('assets', () =>
    assertAssets(api(['api', `repos/${REPOSITORY}/releases/${expected.id}/assets`]), ids)
  );
  const directory = await bridgeStage('temp', () => {
    const output = path.join(safePath(env.RUNNER_TEMP, true), 'hpm-baseline-bridge');
    fs.mkdirSync(output); // Existing output is refused; never reuse stale files.
    return output;
  });
  for (const [index, name] of [INSTALLER, 'identity.json'].entries())
    await bridgeStage(index === 0 ? 'download_installer' : 'download_identity', () =>
      fetchAsset(
        ids[index],
        env.GH_TOKEN,
        path.join(directory, name),
        [28541417, 4096][index],
        dependencies.fetch || fetch
      )
    );
  await bridgeStage('installer_digest', () => {
    if (digest(path.join(directory, INSTALLER)) !== BASELINE_INSTALLER_SHA256) throw fail();
  });
  await bridgeStage('identity', () =>
    assertIdentity(JSON.parse(fs.readFileSync(path.join(directory, 'identity.json'), 'utf8')))
  );
  await bridgeStage('release_recheck', () =>
    assertRelease(api(['api', `repos/${REPOSITORY}/releases/${expected.id}`]), expected)
  );
  // Upload only runs after success; failed partial files stay isolated for disposal.
  return directory;
}
module.exports = {
  REPOSITORY,
  INSTALLER,
  REMOTE_INSTALLER,
  identity,
  assertIdentity,
  parseOptions,
  validateArchive,
  assertRepository,
  assertRelease,
  assertAssets,
  prepareTransfer,
  readBounded,
  fetchAsset,
  runBridge,
  formatBridgeError,
  ghInvocation,
  checkoutCommit,
  gitInvocation,
};
