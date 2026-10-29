'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
const testTempRoot = resolvePhysicalTestTempDirectory();
const { spawnSync } = require('node:child_process');
const {
  parseReviewRoute,
  readEvent,
  resolveReviewRoute,
} = require('../scripts/lib/nsis-review-route');
const { unpinnedActionReferences } = require('../lib/ci-governance');
const { discoverTestFiles } = require('../lib/test-discovery');
const sha = 'a'.repeat(40);
const uuid = '12345678-1234-4234-8234-123456789abc';
function fixture(lane = 'bridge', suffix = lane === 'bridge' ? `41-42-43-${uuid}` : '44') {
  const ref = `refs/heads/acceptance/${lane === 'bridge' ? 'windows-baseline-bridge' : 'windows-encrypted-lifecycle'}/${suffix}`;
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
      repository: { full_name: 'cbhandsun/https-proxy', private: true },
    },
  };
}
function temporary(t) {
  const root = fs.mkdtempSync(path.join(testTempRoot, 'hpm-route-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('review refs resolve only fixed typed outputs with exact target identity and canonical UUID', () => {
  const bridge = fixture();
  assert.deepEqual(parseReviewRoute('bridge', bridge.env, bridge.event), {
    release_id: '41',
    installer_asset_id: '42',
    identity_asset_id: '43',
    target_sha: sha,
    transfer_tag: `hpm-baseline-transfer-${uuid}`,
  });
  for (const id of ['1', '999999999999999']) {
    const encrypted = fixture('encrypted', id);
    assert.deepEqual(parseReviewRoute('encrypted', encrypted.env, encrypted.event), {
      baseline_artifact_id: id,
    });
  }
  const independentIdSpaces = fixture('bridge', `42-42-43-${uuid}`);
  assert.equal(
    parseReviewRoute('bridge', independentIdSpaces.env, independentIdSpaces.event).release_id,
    '42'
  );
});
test('empty, malformed, extreme and shell-shaped refs cannot inject output keys or values', () => {
  for (const lane of ['bridge', 'encrypted']) {
    const bad = [
      '',
      '0',
      '01',
      '-1',
      '1.0',
      '1e3',
      '1000000000000000',
      '99999999999999999999',
      '$(echo private)',
      '`private`',
      '1\nother=value',
      '1\r',
      '1/extra',
      '../1',
      '1%0aother=value',
      '1'.repeat(10000),
    ];
    for (const suffix of bad) {
      const sample = fixture(lane, lane === 'bridge' ? `${suffix}-42-43-${uuid}` : suffix);
      assert.throws(() => parseReviewRoute(lane, sample.env, sample.event));
    }
  }
  for (const suffix of [
    `41-42-42-${uuid}`,
    `41-42-43-${uuid.toUpperCase()}`,
    '41-42-43-12345678123442348234123456789abc',
    `41-42-43-${uuid.replace('-4234-', '-1234-')}`,
    `41-42-43-${uuid}\n`,
    `41-42-43-${uuid}\u2028`,
    `41-42-43-${uuid}\u2029`,
  ]) {
    const sample = fixture('bridge', suffix);
    assert.throws(() => parseReviewRoute('bridge', sample.env, sample.event));
  }
});
test('repository, event, ref and SHA boundaries refuse deletions, updates, force pushes and foreign sources', () => {
  const sample = fixture();
  for (const [key, value] of Object.entries({
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: 'foreign/repo',
    GITHUB_API_URL: 'https://enterprise.invalid',
    GITHUB_SERVER_URL: 'https://enterprise.invalid',
    GITHUB_ACTIONS: 'false',
    RUNNER_ENVIRONMENT: 'self-hosted',
    GITHUB_SHA: `${sha}\n`,
    GITHUB_REF: 'refs/tags/foreign',
  }))
    assert.throws(() => parseReviewRoute('bridge', { ...sample.env, [key]: value }, sample.event));
  for (const patch of [
    { after: 'b'.repeat(40) },
    { before: 'b'.repeat(40) },
    { created: false },
    { deleted: true },
    { deleted: 'false' },
    { forced: true },
    { ref: sample.event.ref + '/extra' },
    { repository: { full_name: 'foreign/repo', private: true } },
    { repository: { full_name: 'cbhandsun/https-proxy', private: false } },
  ])
    assert.throws(() => parseReviewRoute('bridge', sample.env, { ...sample.event, ...patch }));
  for (const event of [null, [], {}, '', 1])
    assert.throws(() => parseReviewRoute('bridge', sample.env, event));
  assert.throws(() => parseReviewRoute('unknown', sample.env, sample.event));
  const zero = { ...sample.env, GITHUB_SHA: '0'.repeat(40) };
  assert.throws(() =>
    parseReviewRoute('bridge', zero, { ...sample.event, after: zero.GITHUB_SHA })
  );
});
test('runtime writes validated fixed outputs only after event and actual checkout verification; failures write nothing', (t) => {
  const root = temporary(t);
  const sample = fixture();
  const eventFile = path.join(root, 'event.json');
  const output = path.join(root, 'output');
  fs.writeFileSync(eventFile, JSON.stringify(sample.event));
  fs.writeFileSync(output, '');
  const env = {
    ...sample.env,
    GITHUB_EVENT_PATH: eventFile,
    GITHUB_OUTPUT: output,
    GITHUB_WORKSPACE: root,
  };
  assert.throws(() => resolveReviewRoute('bridge', env, { checkoutCommit: () => 'b'.repeat(40) }));
  assert.equal(fs.readFileSync(output, 'utf8'), '');
  resolveReviewRoute('bridge', env, { checkoutCommit: () => sha });
  assert.equal(
    fs.readFileSync(output, 'utf8'),
    `release_id=41\ninstaller_asset_id=42\nidentity_asset_id=43\ntarget_sha=${sha}\ntransfer_tag=hpm-baseline-transfer-${uuid}\n`
  );
  fs.writeFileSync(eventFile, JSON.stringify({ ...sample.event, deleted: true }));
  fs.writeFileSync(output, '');
  assert.throws(() =>
    resolveReviewRoute('bridge', env, {
      checkoutCommit: () => assert.fail('invalid event must stop first'),
    })
  );
  assert.equal(fs.readFileSync(output, 'utf8'), '');
  fs.writeFileSync(eventFile, '{private-invalid-json');
  assert.throws(() => readEvent(eventFile));
  const result = spawnSync(process.execPath, ['scripts/resolve-nsis-review-route.cjs', 'bridge'], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'nsis_review_route_refused\n');
  fs.writeFileSync(eventFile, 'x'.repeat(1024 * 1024 + 1));
  assert.throws(() => readEvent(eventFile));
  fs.writeFileSync(eventFile, '');
  assert.throws(() => readEvent(eventFile));
  fs.writeFileSync(eventFile, JSON.stringify(sample.event));
  fs.writeFileSync(output, 'x'.repeat(65537));
  assert.throws(() => resolveReviewRoute('bridge', env, { checkoutCommit: () => sha }));
  assert.equal(fs.statSync(output).size, 65537);
  const expectedLines = `release_id=41\ninstaller_asset_id=42\nidentity_asset_id=43\ntarget_sha=${sha}\ntransfer_tag=hpm-baseline-transfer-${uuid}\n`;
  const available = 65536 - Buffer.byteLength(expectedLines, 'utf8');
  fs.writeFileSync(output, 'x'.repeat(available));
  resolveReviewRoute('bridge', env, { checkoutCommit: () => sha });
  assert.equal(fs.statSync(output).size, 65536);
  const oneTooMany = 'x'.repeat(available + 1);
  fs.writeFileSync(output, oneTooMany);
  assert.throws(() => resolveReviewRoute('bridge', env, { checkoutCommit: () => sha }));
  assert.equal(fs.readFileSync(output, 'utf8'), oneTooMany);
  fs.writeFileSync(output, 'x'.repeat(65536));
  assert.throws(() => resolveReviewRoute('bridge', env, { checkoutCommit: () => sha }));
  assert.equal(fs.statSync(output).size, 65536);
  assert.throws(() => readEvent(path.join(root, 'missing-event.json')));
});
test('review callers are independently scoped, SHA-pinned and permission-limited; reusable lanes retain original gates', () => {
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes('test/nsis-review-route.test.js')
  );
  for (const [lane, caller, reusable] of [
    [
      'bridge',
      'windows-baseline-artifact-bridge-review.yml',
      'windows-baseline-artifact-bridge.yml',
    ],
    ['encrypted', 'windows-encrypted-lifecycle-review.yml', 'windows-encrypted-lifecycle.yml'],
  ]) {
    const text = fs.readFileSync(path.join('.github/workflows', caller), 'utf8');
    assert.deepEqual(unpinnedActionReferences(text), []);
    assert.match(text, /permissions: \{\}/);
    assert.match(text, /ref: \$\{\{ github.sha \}\}/);
    assert.match(text, new RegExp(`run: node scripts/resolve-nsis-review-route.cjs ${lane}`));
    assert.match(text, /needs: resolve/);
    assert.ok(text.includes(`uses: ./.github/workflows/${reusable}`));
    assert.doesNotMatch(
      text,
      /secrets:|secrets\.|workflow_dispatch:|pull_request:|continue-on-error|always\(\)|\$\{\{ github.ref/
    );
    const resolver = text.slice(
      text.indexOf('  resolve:'),
      text.indexOf(lane === 'bridge' ? '  bridge:' : '  encrypted:')
    );
    assert.doesNotMatch(resolver, /contents: write|actions: write/);
    assert.match(resolver, /contents: read/);
    const reusableText = fs.readFileSync(path.join('.github/workflows', reusable), 'utf8');
    assert.match(reusableText, /workflow_call:/);
    assert.match(reusableText, /workflow_dispatch:/);
    assert.doesNotMatch(reusableText, /push:/);
    const callInputs = reusableText
      .slice(reusableText.indexOf('  workflow_call:'), reusableText.indexOf('  workflow_dispatch:'))
      .replace('workflow_call:', 'workflow_dispatch:')
      .trim();
    const dispatchInputs = reusableText
      .slice(reusableText.indexOf('  workflow_dispatch:'), reusableText.indexOf('\npermissions:'))
      .trim();
    assert.equal(callInputs, dispatchInputs);
    if (lane === 'bridge') {
      assert.match(text, /acceptance\/windows-baseline-bridge\/\*\*/);
      assert.match(text.slice(text.indexOf('  bridge:')), /contents: write/);
    } else {
      assert.match(text, /acceptance\/windows-encrypted-lifecycle\/\*\*/);
      assert.doesNotMatch(text, /contents: write|actions: write/);
      assert.match(text, /actions: read/);
      assert.match(reusableText, /npm run verify/);
      assert.match(reusableText, /npm audit --audit-level=high/);
      assert.ok(reusableText.indexOf('npm run verify') < reusableText.indexOf('tauri.js build'));
    }
  }
});
