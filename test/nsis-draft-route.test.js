'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
const { discoverTestFiles } = require('../lib/test-discovery');
const { unpinnedActionReferences } = require('../lib/ci-governance');
const { parseReviewRoute, resolveReviewRoute } = require('../scripts/lib/nsis-review-route');
const sha = 'a'.repeat(40);
const oldSha = 'b'.repeat(40);
const uuid = '12345678-1234-4234-8234-123456789abc';
function fixture(suffix = `41-42-43-${uuid}-${oldSha}`) {
  const ref = `refs/heads/acceptance/windows-encrypted-draft/${suffix}`;
  return {
    env: {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REPOSITORY: 'cbhandsun/https-proxy',
      GITHUB_API_URL: 'https://api.github.com',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted',
      GITHUB_SHA: sha,
      GITHUB_REF: ref,
    },
    event: {
      ref,
      after: sha,
      before: '0'.repeat(40),
      created: true,
      deleted: false,
      forced: false,
      repository: { full_name: 'cbhandsun/https-proxy', private: false },
    },
  };
}
const expected = {
  release_id: '41',
  installer_asset_id: '42',
  identity_asset_id: '43',
  baseline_target_sha: oldSha,
  transfer_tag: `hpm-baseline-transfer-${uuid}`,
};

test('draft review route pins separately selected old baseline and current source with fixed outputs', () => {
  const { env, event } = fixture();
  assert.deepEqual(parseReviewRoute('draft', env, event), expected);
  for (const lane of ['bridge', 'encrypted'])
    assert.throws(() => parseReviewRoute(lane, env, event));
  assert.throws(() =>
    parseReviewRoute('draft', env, { ...event, repository: { ...event.repository, private: true } })
  );
});

test('draft route rejects empty, invalid, extreme and output-injecting identities', () => {
  for (const suffix of [
    '',
    '41',
    `0-42-43-${uuid}-${oldSha}`,
    `01-42-43-${uuid}-${oldSha}`,
    `9999999999999999-42-43-${uuid}-${oldSha}`,
    `41-42-42-${uuid}-${oldSha}`,
    `41-42-43-${uuid}-${'0'.repeat(40)}`,
    `41-42-43-${uuid}-HEAD`,
    `41-42-43-${uuid.replace('-4234-', '-1234-')}-${oldSha}`,
    `41-42-43-${uuid}-${oldSha}\nother=value`,
    `41-42-43-${uuid}-${oldSha}/extra`,
    '$(secret)',
    '`secret`',
    'x'.repeat(10000),
  ]) {
    const { env, event } = fixture(suffix);
    assert.throws(() => parseReviewRoute('draft', env, event));
  }
});

test('candidate-specific draft review reuses the private baseline only with the exact new checkout SHA', () => {
  const base = `41-42-43-${uuid}-${oldSha}`;
  const { env, event } = fixture(`${base}-${sha}`);
  assert.deepEqual(parseReviewRoute('draft', env, event), expected);
  for (const suffix of [
    oldSha,
    '0'.repeat(40),
    sha.toUpperCase(),
    'a'.repeat(39),
    'a'.repeat(41),
    `${sha}-${sha}`,
    `${sha}\nother=value`,
  ]) {
    const sample = fixture(`${base}-${suffix}`);
    assert.throws(() => parseReviewRoute('draft', sample.env, sample.event));
  }
  for (const patch of [{ created: false }, { forced: true }, { before: oldSha }, { after: oldSha }])
    assert.throws(() => parseReviewRoute('draft', env, { ...event, ...patch }));
});

test('draft route refuses updates, force pushes, deletions, foreign repository and host boundaries', () => {
  const { env, event } = fixture();
  for (const patch of [
    { before: oldSha },
    { after: oldSha },
    { created: false },
    { forced: true },
    { deleted: true },
    { repository: { full_name: 'foreign/repo', private: false } },
    { repository: { full_name: 'cbhandsun/https-proxy', private: 'false' } },
  ])
    assert.throws(() => parseReviewRoute('draft', env, { ...event, ...patch }));
  for (const [key, value] of Object.entries({
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_REPOSITORY: 'foreign/repo',
    GITHUB_API_URL: 'http://api.github.com',
    GITHUB_SERVER_URL: 'https://foreign.invalid',
    RUNNER_ENVIRONMENT: 'self-hosted',
    GITHUB_ACTIONS: 'false',
    GITHUB_SHA: 'HEAD',
  }))
    assert.throws(() => parseReviewRoute('draft', { ...env, [key]: value }, event));
});

test('draft resolver writes no outputs for wrong checkout and emits only validated pinned identities', (t) => {
  const root = fs.mkdtempSync(path.join(resolvePhysicalTestTempDirectory(), 'hpm-draft-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sample = fixture();
  const output = path.join(root, 'output');
  const eventFile = path.join(root, 'event.json');
  fs.writeFileSync(output, '');
  fs.writeFileSync(eventFile, JSON.stringify(sample.event));
  const env = {
    ...sample.env,
    GITHUB_OUTPUT: output,
    GITHUB_EVENT_PATH: eventFile,
    GITHUB_WORKSPACE: root,
  };
  assert.throws(() => resolveReviewRoute('draft', env, { checkoutCommit: () => oldSha }));
  assert.equal(fs.readFileSync(output, 'utf8'), '');
  assert.deepEqual(resolveReviewRoute('draft', env, { checkoutCommit: () => sha }), expected);
  assert.equal(
    fs.readFileSync(output, 'utf8'),
    Object.entries(expected)
      .map(([key, value]) => `${key}=${value}\n`)
      .join('')
  );
});

test('draft review caller is pinned, uses read-only resolver and invokes full encrypted qualification', () => {
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes('test/nsis-draft-route.test.js')
  );
  const caller = fs.readFileSync(
    '.github/workflows/windows-encrypted-draft-lifecycle-review.yml',
    'utf8'
  );
  assert.deepEqual(unpinnedActionReferences(caller), []);
  assert.match(caller, /acceptance\/windows-encrypted-draft\/\*\*/);
  assert.match(caller, /permissions: \{\}/);
  assert.match(caller, /ref: \$\{\{ github.sha \}\}/);
  assert.match(caller, /run: node scripts\/resolve-nsis-review-route.cjs draft/);
  const resolver = caller.slice(caller.indexOf('  resolve:'), caller.indexOf('  encrypted:'));
  assert.match(resolver, /contents: read/);
  assert.doesNotMatch(resolver, /contents: write|GH_TOKEN:/);
  assert.match(caller, /needs: resolve/);
  assert.match(caller, /uses: .\/.github\/workflows\/windows-encrypted-draft-lifecycle.yml/);
  for (const key of Object.keys(expected))
    assert.ok(caller.includes(`${key}: $` + `{{ needs.resolve.outputs.${key} }}`));
  assert.equal((caller.match(/contents: write/g) || []).length, 1);
  assert.doesNotMatch(caller, /secrets:|secrets\.|pull_request:|continue-on-error|upload-artifact/);
});
