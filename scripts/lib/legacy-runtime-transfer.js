'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { types } = require('node:util');
const transfer = require('./nsis-baseline-transfer');
const { safePath, digest } = require('./nsis-encrypted-contract');
const IDENTITY = Object.freeze({
  release: 423120279,
  asset: 673959578,
  tag: 'hpm-582-public-transfer-22d1b5ef-40af-484c-b4a0-53ac09359f19',
  target: '89d8c0001d805cb6b1913aee2d5942a061c6c547',
  name: 'hpm-582-public-runtime-without-node.zip',
  size: 1461331,
  archive: 'ced2c62a472107876b75dad73bd3161954988fa341f526d918f85b7be6812abb',
  manifest: '4eb1ea482224541c14e7ccddabbb94d75dd2cb698a14a78f6745f11eef43b66f',
  node: '780f44f2c53c108bae261ada21a525b4bfe733c020ac85e41bfe94479090ac9b',
});
const NODE_URL = 'https://nodejs.org/dist/v22.22.3/win-x64/node.exe';
const refused = () => new Error('legacy_runtime_transfer_refused');
function field(value, name) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) throw refused();
  const slot = Object.getOwnPropertyDescriptor(value, name);
  if (!slot || !slot.enumerable || !Object.hasOwn(slot, 'value')) throw refused();
  return slot.value;
}
function assertRelease(value) {
  for (const [name, expected] of Object.entries({
    id: IDENTITY.release,
    draft: true,
    published_at: null,
    tag_name: IDENTITY.tag,
    target_commitish: IDENTITY.target,
  }))
    if (field(value, name) !== expected) throw refused();
  if (field(field(value, 'author'), 'login') !== 'cbhandsun') throw refused();
  const assets = field(value, 'assets');
  if (types.isProxy(assets) || !Array.isArray(assets) || assets.length !== 1) throw refused();
  const asset = field(assets, '0');
  for (const [name, expected] of Object.entries({
    id: IDENTITY.asset,
    name: IDENTITY.name,
    size: IDENTITY.size,
    state: 'uploaded',
    digest: `sha256:${IDENTITY.archive}`,
  }))
    if (field(asset, name) !== expected) throw refused();
}
function metadata(route) {
  const invocation = transfer.ghInvocation(['api', `repos/${transfer.REPOSITORY}${route}`]);
  const result = spawnSync('gh', invocation.args, {
    env: invocation.env,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0) throw refused();
  return JSON.parse(result.stdout);
}
async function anonymousDenied(request) {
  const api = `https://api.github.com/repos/${transfer.REPOSITORY}/releases`;
  for (const [url, accept] of [
    [`${api}/${IDENTITY.release}`, 'application/vnd.github+json'],
    [`${api}/assets/${IDENTITY.asset}`, 'application/vnd.github+json'],
    [`${api}/assets/${IDENTITY.asset}`, 'application/octet-stream'],
    [
      `https://github.com/${transfer.REPOSITORY}/releases/download/${IDENTITY.tag}/${IDENTITY.name}`,
      'application/octet-stream',
    ],
  ]) {
    const response = await request(url, {
      headers: { accept },
      redirect: 'manual',
      signal: globalThis.AbortSignal.timeout(15000),
    });
    await response.body?.cancel();
    if (response.status !== 404) throw refused();
  }
}
async function receiveLegacyRuntime(env, dependencies = {}) {
  try {
    for (const [name, expected] of Object.entries({
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_OS: 'Windows',
      GITHUB_REPOSITORY: transfer.REPOSITORY,
      GITHUB_API_URL: 'https://api.github.com',
    }))
      if (field(env, name) !== expected) throw refused();
    const token = field(env, 'GH_TOKEN'),
      sha = field(env, 'GITHUB_SHA');
    if (
      typeof token !== 'string' ||
      !/^[\x21-\x7e]{1,4096}$/.test(token) ||
      typeof sha !== 'string' ||
      !/^[a-f0-9]{40}$/.test(sha)
    )
      throw refused();
    const workspace = safePath(field(env, 'GITHUB_WORKSPACE'), true);
    const candidate = safePath(path.join(workspace, 'current'), true);
    if ((dependencies.checkoutCommit || transfer.checkoutCommit)(candidate) !== sha)
      throw refused();
    const api = dependencies.metadata || metadata,
      request = dependencies.fetch || fetch;
    const repo = api('');
    if (
      field(repo, 'full_name') !== transfer.REPOSITORY ||
      field(repo, 'private') !== false ||
      field(field(repo, 'owner'), 'login') !== 'cbhandsun' ||
      field(repo, 'archived') !== false ||
      field(repo, 'disabled') !== false
    )
      throw refused();
    assertRelease(api(`/releases/${IDENTITY.release}`));
    await anonymousDenied(request);
    const directory = path.join(workspace, 'legacy-582-transfer');
    fs.mkdirSync(directory);
    safePath(directory, true);
    const archive = path.join(directory, IDENTITY.name);
    if (
      (await transfer.fetchAsset(IDENTITY.asset, token, archive, IDENTITY.size, request)) !==
        IDENTITY.size ||
      (dependencies.digest || digest)(archive) !== IDENTITY.archive
    )
      throw refused();
    // The official origin receives no inherited credentials or redirect authority.
    const response = await request(NODE_URL, {
      headers: { accept: 'application/octet-stream' },
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(30000),
    });
    const node = path.join(directory, 'node.exe');
    const fd = fs.openSync(node, 'wx');
    try {
      await transfer.readBounded(response, 104857600, fd);
    } finally {
      fs.closeSync(fd);
    }
    if ((dependencies.digest || digest)(node) !== IDENTITY.node) throw refused();
    assertRelease(api(`/releases/${IDENTITY.release}`));
    await anonymousDenied(request);
    return directory;
  } catch {
    throw refused();
  }
}
module.exports = { IDENTITY, NODE_URL, assertRelease, receiveLegacyRuntime };
