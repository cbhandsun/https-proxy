'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const transfer = require('./nsis-baseline-transfer');
const { safePath, digest, BASELINE_INSTALLER_SHA256 } = require('./nsis-encrypted-contract');

const refused = () => new Error('baseline_draft_download_refused');
const positive = (value) =>
  typeof value === 'string' &&
  /^[1-9][0-9]{0,14}$/.test(value) &&
  Number.isSafeInteger(Number(value));

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

async function assertAnonymousDenied(expected, ids, request) {
  const api = `https://api.github.com/repos/${transfer.REPOSITORY}/releases`;
  const browser = `https://github.com/${transfer.REPOSITORY}/releases/download/${expected.tag}`;
  const probes = [[`${api}/${expected.id}`, 'application/vnd.github+json']];
  for (const [index, id] of ids.entries()) {
    probes.push(
      [`${api}/assets/${id}`, 'application/vnd.github+json'],
      [`${api}/assets/${id}`, 'application/octet-stream'],
      [
        `${browser}/${[transfer.REMOTE_INSTALLER, 'identity.json'][index]}`,
        'application/octet-stream',
      ]
    );
  }
  for (const [url, accept] of probes) {
    // No inherited headers or credentials, and never follow a signed redirect.
    const response = await request(url, {
      headers: { accept },
      redirect: 'manual',
      signal: globalThis.AbortSignal.timeout(15000),
    });
    await response.body?.cancel();
    if (response.status !== 404) throw refused();
  }
}

async function runDraftDownload(env, dependencies = {}) {
  try {
    if (
      env.GITHUB_ACTIONS !== 'true' ||
      env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      env.GITHUB_REPOSITORY !== transfer.REPOSITORY ||
      env.GITHUB_API_URL !== 'https://api.github.com' ||
      typeof env.GH_TOKEN !== 'string' ||
      !/^[\x21-\x7e]{1,4096}$/.test(env.GH_TOKEN) ||
      !positive(env.RELEASE_ID) ||
      !positive(env.INSTALLER_ASSET_ID) ||
      !positive(env.IDENTITY_ASSET_ID) ||
      env.INSTALLER_ASSET_ID === env.IDENTITY_ASSET_ID ||
      !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '') ||
      !/^[a-f0-9]{40}$/.test(env.BASELINE_TARGET_SHA || '') ||
      !/^hpm-baseline-transfer-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
        env.TRANSFER_TAG || ''
      )
    )
      throw refused();
    const workspace = safePath(env.GITHUB_WORKSPACE, true);
    // Baseline identity and candidate checkout are separately pinned. The old
    // draft must never be retargeted merely to match a newer candidate.
    const candidate = safePath(path.join(workspace, 'current'), true);
    if ((dependencies.checkoutCommit || transfer.checkoutCommit)(candidate) !== env.GITHUB_SHA)
      throw refused();
    const api = dependencies.metadata || metadata;
    const request = dependencies.fetch || fetch;
    const repository = api('');
    if (repository?.full_name !== transfer.REPOSITORY || repository.private !== false)
      throw refused();
    const expected = {
      id: Number(env.RELEASE_ID),
      tag: env.TRANSFER_TAG,
      target: env.BASELINE_TARGET_SHA,
      marker: `hpm-private-baseline-v1:${env.TRANSFER_TAG}`,
    };
    const ids = [Number(env.INSTALLER_ASSET_ID), Number(env.IDENTITY_ASSET_ID)];
    const checkMetadata = () => {
      transfer.assertRelease(api(`/releases/${expected.id}`), expected);
      return transfer.assertAssets(api(`/releases/${expected.id}/assets`), ids);
    };
    const assets = checkMetadata();
    await assertAnonymousDenied(expected, ids, request);
    const directory = path.join(workspace, 'old-baseline');
    fs.mkdirSync(directory); // Refuse stale output, including directory links.
    safePath(directory, true);
    for (const [index, name] of [transfer.INSTALLER, 'identity.json'].entries()) {
      const destination = path.join(directory, name);
      const size = await transfer.fetchAsset(
        ids[index],
        env.GH_TOKEN,
        destination,
        [28541417, 4096][index],
        request
      );
      if (size !== assets[index].size) throw refused();
    }
    if (
      (dependencies.digest || digest)(path.join(directory, transfer.INSTALLER)) !==
      BASELINE_INSTALLER_SHA256
    )
      throw refused();
    transfer.assertIdentity(
      JSON.parse(fs.readFileSync(path.join(directory, 'identity.json'), 'utf8'))
    );
    const after = checkMetadata();
    if (after.some((asset, index) => asset.size !== assets[index].size)) throw refused();
    await assertAnonymousDenied(expected, ids, request);
    // Return only a local directory. Nothing is uploaded, published or deleted.
    return directory;
  } catch {
    // Never inspect or forward errors from subprocesses, fetch, or hostile values.
    throw refused();
  }
}

module.exports = { runDraftDownload };
