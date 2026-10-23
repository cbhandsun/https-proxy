'use strict';

const fs = require('node:fs');
const { safePath } = require('./nsis-encrypted-contract');
const { checkoutCommit } = require('./nsis-baseline-transfer');
const REPOSITORY = 'cbhandsun/https-proxy';
const ID = '[1-9][0-9]{0,14}';
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const fail = () => new Error('nsis_review_route_refused');
function parseReviewRoute(lane, env, event) {
  if (
    !['bridge', 'encrypted', 'draft'].includes(lane) ||
    !env ||
    !event ||
    typeof event !== 'object' ||
    Array.isArray(event) ||
    env.GITHUB_EVENT_NAME !== 'push' ||
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    env.GITHUB_API_URL !== 'https://api.github.com' ||
    env.GITHUB_SERVER_URL !== 'https://github.com' ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    typeof env.GITHUB_SHA !== 'string' ||
    env.GITHUB_SHA.length !== 40 ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA) ||
    env.GITHUB_SHA === '0'.repeat(40) ||
    typeof env.GITHUB_REF !== 'string' ||
    env.GITHUB_REF.length > 256 ||
    /[\0\r\n]/.test(env.GITHUB_REF) ||
    event.ref !== env.GITHUB_REF ||
    event.after !== env.GITHUB_SHA ||
    event.before !== '0'.repeat(40) ||
    event.created !== true ||
    event.deleted !== false ||
    event.forced !== false ||
    event.repository?.full_name !== REPOSITORY ||
    event.repository.private !== (lane !== 'draft')
  )
    throw fail();
  const pattern =
    lane === 'bridge'
      ? new RegExp(
          `^refs/heads/acceptance/windows-baseline-bridge/(${ID})-(${ID})-(${ID})-(${UUID})$`
        )
      : lane === 'draft'
        ? new RegExp(
            `^refs/heads/acceptance/windows-encrypted-draft/(${ID})-(${ID})-(${ID})-(${UUID})-([a-f0-9]{40})$`
          )
        : new RegExp(`^refs/heads/acceptance/windows-encrypted-lifecycle/(${ID})$`);
  const match = pattern.exec(env.GITHUB_REF);
  if (!match || match[0] !== env.GITHUB_REF) throw fail();
  const ids = match.slice(1, lane === 'encrypted' ? 2 : 4);
  if (
    ids.some((value) => !Number.isSafeInteger(Number(value))) ||
    (lane !== 'encrypted' && match[2] === match[3]) ||
    (lane === 'draft' && match[5] === '0'.repeat(40))
  )
    throw fail();
  if (lane === 'draft')
    return {
      release_id: match[1],
      installer_asset_id: match[2],
      identity_asset_id: match[3],
      baseline_target_sha: match[5],
      transfer_tag: `hpm-baseline-transfer-${match[4]}`,
    };
  return lane === 'bridge'
    ? {
        release_id: match[1],
        installer_asset_id: match[2],
        identity_asset_id: match[3],
        target_sha: env.GITHUB_SHA,
        transfer_tag: `hpm-baseline-transfer-${match[4]}`,
      }
    : { baseline_artifact_id: match[1] };
}
function readEvent(file) {
  const fd = fs.openSync(safePath(file), 'r');
  try {
    const limit = 1024 * 1024;
    const stat = fs.fstatSync(fd);
    if (stat.size < 2 || stat.size > limit) throw fail();
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length !== stat.size) throw fail();
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}
function resolveReviewRoute(lane, env, dependencies = {}) {
  const values = parseReviewRoute(lane, env, readEvent(env.GITHUB_EVENT_PATH));
  if ((dependencies.checkoutCommit || checkoutCommit)(env.GITHUB_WORKSPACE) !== env.GITHUB_SHA)
    throw fail();
  const output = safePath(env.GITHUB_OUTPUT);
  const lines = Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
  if (fs.statSync(output).size + Buffer.byteLength(lines, 'utf8') > 65536) throw fail();
  fs.appendFileSync(output, lines, { encoding: 'utf8' });
  return values;
}
module.exports = { parseReviewRoute, readEvent, resolveReviewRoute };
