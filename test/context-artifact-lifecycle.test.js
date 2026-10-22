'use strict';

const assert = require('node:assert/strict');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const {
  artifactLifecyclePolicy,
  canAdmitArtifact,
  MAX_LIFETIME_MS,
} = require('../lib/proxy/context-artifact-lifecycle');
const {
  contextArtifactContinuation,
  CONTEXT_ARTIFACT_TOOL_NAME,
  contextArtifactToolDefinition,
} = require('../lib/proxy/context-artifact-tool');
const { createEvidenceReceipt } = require('../lib/proxy/context-checkpoint');

function fixture(options = {}) {
  let time = 1000;
  const store = createContextArtifactStore({
    now: () => time,
    ttlMs: 100,
    maxLifetimeMs: 300,
    ...options,
  });
  return {
    store,
    setTime(value) {
      time = value;
    },
  };
}

// Success, rather than a failed read attempt, renews the idle lease. Renewal
// neither changes the receipt/digest nor permits resurrection after expiry.
{
  const { store, setTime } = fixture();
  const receipt = store.put('owner', 'scope', '汉🙂abcdef');
  assert.equal(receipt.expiresAt, 1100);
  setTime(1090);
  assert.equal(store.read('owner', 'scope', receipt.locator, receipt.digest).expiresAt, 1190);
  setTime(1180);
  assert.deepEqual(store.renew('owner', 'scope', receipt.locator, receipt.digest), {
    ok: true,
    expiresAt: 1280,
    hardExpiresAt: 1300,
  });
  setTime(1270);
  assert.equal(store.read('owner', 'scope', receipt.locator).expiresAt, 1300);
  setTime(1300);
  assert.equal(store.renew('owner', 'scope', receipt.locator, receipt.digest).ok, false);
  assert.equal(store.read('owner', 'scope', receipt.locator).ok, false);
  assert.equal(store.stats().retainedBytes, 0);
  setTime(1301);
  assert.ok(store.put('owner', 'scope', 'new evidence'));
}

for (const invalidRead of [
  (s, r) => s.read('other', 'scope', r.locator, r.digest),
  (s, r) => s.read('owner', 'other', r.locator, r.digest),
  (s, r) => s.read('owner', 'scope', r.locator, '0'.repeat(64)),
  (s, r) => s.renew('owner', 'scope', r.locator),
  (s, r) => s.renew('owner', 'scope', r.locator, '0'.repeat(64)),
  (s, r) => s.renew('other', 'scope', r.locator, r.digest),
  (s, r) => s.readPage('owner', 'scope', r.locator, '0'.repeat(64), {}),
  (s, r) => s.readPage('owner', 'scope', r.locator, r.digest, { offsetBytes: 1 }),
  (s, r) => s.readPage('owner', 'scope', r.locator, r.digest, { limitBytes: 0 }),
  (s, r) => s.readPage('owner', 'scope', r.locator, r.digest, {}, 0),
]) {
  const { store, setTime } = fixture();
  const receipt = store.put('owner', 'scope', '汉🙂abcdef');
  setTime(1090);
  assert.equal(invalidRead(store, receipt).ok, false);
  setTime(1100);
  assert.equal(store.read('owner', 'scope', receipt.locator).ok, false, 'failure cannot renew');
}

// Exercise actual internal tool result envelopes and UTF-8 pagination across
// several idle leases, then the visible hard-expiry failure path.
{
  const { store, setTime } = fixture();
  const scope = 'hcs_' + '1'.repeat(32);
  const receipt = store.put('owner', scope, '汉🙂abcdef');
  const completion = (offsetBytes) => ({
    choices: [
      {
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: 'read_' + offsetBytes,
              type: 'function',
              function: {
                name: CONTEXT_ARTIFACT_TOOL_NAME,
                arguments: JSON.stringify({
                  ...receipt,
                  bytes: undefined,
                  expiresAt: undefined,
                  scope,
                  offsetBytes,
                  limitBytes: 7,
                }),
              },
            },
          ],
        },
      },
    ],
  });
  for (const [time, offset] of [
    [1090, 0],
    [1180, 7],
    [1270, 13],
  ]) {
    setTime(time);
    const continuation = contextArtifactContinuation(completion(offset), store, 'owner');
    assert.equal(continuation.resolvedCount, 1);
    assert.equal(JSON.parse(continuation.messages[1].content).page.offsetBytes, offset);
  }
  setTime(1300);
  const continuation = contextArtifactContinuation(completion(0), store, 'owner');
  assert.equal(continuation.resolvedCount, 0);
  assert.equal(continuation.unavailableCount, 1);
  assert.deepEqual(JSON.parse(continuation.messages[1].content), {
    ok: false,
    error: 'context_artifact_unavailable',
  });
  const description = contextArtifactToolDefinition().function.description;
  assert.match(description, /If evidence is unavailable, report that it is unavailable/);
  assert.match(description, /never infer its contents/);
  assert.match(description, /Do not automatically rerun the original tool/);
  assert.match(description, /Fresh source acquisition requires separate applicable authorization/);
  assert.doesNotMatch(description, /reacquire the original source/);
}

// Independent entry and byte quotas, with no eviction of live leases, including
// those belonging to the requester. Provider quotas also bound fresh scopes.
for (const options of [
  { maxSessionEntries: 1 },
  { maxSessionBytes: 4 },
  { maxOwnerEntries: 1 },
  { maxOwnerBytes: 4 },
  { maxEntries: 1 },
  { maxBytes: 4 },
]) {
  const { store, setTime } = fixture({
    maxArtifactBytes: 4,
    maxBytes: 16,
    maxEntries: 4,
    ...options,
  });
  const original = store.put('owner', 'scope', '1234');
  assert.ok(original);
  const before = store.stats();
  assert.equal(store.put('owner', 'scope', '5678'), null);
  assert.deepEqual(store.stats(), before, 'admission failure has no eviction side effects');
  assert.equal(store.read('owner', 'scope', original.locator).value, '1234');
  if (options.maxOwnerEntries || options.maxOwnerBytes) {
    assert.equal(store.put('owner', 'fresh-scope', '5678'), null);
    assert.ok(store.put('other-owner', 'scope', '5678'));
  }
  if (options.maxSessionEntries || options.maxSessionBytes) {
    assert.ok(store.put('owner', 'other-scope', '5678'));
  }
  setTime(1100);
  assert.ok(store.put('owner', 'scope', 'new'));
}

{
  const { store } = fixture({ maxArtifactBytes: 4, maxBytes: 8, maxEntries: 2 });
  const a = store.put('a', 's', 'aaaa');
  const b = store.put('b', 's', 'bbbb');
  assert.ok(a && b);
  const denied = createEvidenceReceipt(
    { role: 'tool', content: 'cccc' },
    {
      artifactStore: store,
      artifactOwner: 'c',
      artifactScope: 's',
    }
  );
  assert.equal(denied.locator, undefined);
  assert.equal(denied.recovery, 'missing_no_guess_no_replay');
  assert.equal(store.read('a', 's', a.locator).value, 'aaaa');
  assert.equal(store.read('b', 's', b.locator).value, 'bbbb');
  assert.equal(store.discardSession('wrong', 's'), 0);
  assert.equal(store.discard('a', 's', a.locator), true);
  assert.ok(store.put('c', 's', 'cccc'));
}

for (const invalidTime of [999, NaN, Infinity, -1, 1000.5, Number.MAX_SAFE_INTEGER]) {
  const { store, setTime } = fixture();
  const receipt = store.put('owner', 'scope', 'original');
  setTime(invalidTime);
  assert.equal(store.read('owner', 'scope', receipt.locator).ok, false);
  assert.equal(store.put('owner', 'scope', 'new'), null);
  assert.equal(store.stats().retainedBytes, 0);
  setTime(1000);
  assert.ok(store.put('owner', 'scope', 'new'));
  assert.equal(store.read('owner', 'scope', receipt.locator).ok, false);
}

{
  const { store } = fixture();
  for (const value of ['', ' ', 'a\n', '\u0000', 'x'.repeat(257), null, {}, 10]) {
    assert.equal(store.put(value, 's', 'x'), null);
    assert.equal(store.put('o', value, 'x'), null);
  }
  const r = store.put('o', 's', 'x');
  store.close();
  store.close();
  assert.equal(store.stats().entries, 0);
  assert.equal(store.read('o', 's', r.locator).ok, false);
  assert.equal(store.put('o', 's', 'x'), null);
  assert.equal(store.lifecyclePolicy().persistence, 'memory');
  const restarted = createContextArtifactStore();
  assert.equal(restarted.read('o', 's', r.locator).ok, false, 'restart persistence is not claimed');
}

const limits = { ttlMs: 100, maxBytes: 1000, maxEntries: 10, maxArtifactBytes: 10 };
const defaultPolicy = artifactLifecyclePolicy({}, limits);
assert.deepEqual(
  artifactLifecyclePolicy(
    { maxOwnerBytes: NaN, maxSessionEntries: 0, maxLifetimeMs: '300' },
    limits
  ),
  defaultPolicy
);
const capped = artifactLifecyclePolicy(
  {
    maxLifetimeMs: Number.MAX_SAFE_INTEGER,
    maxOwnerBytes: 2000,
    maxSessionBytes: 3000,
    maxOwnerEntries: 100,
    maxSessionEntries: 100,
  },
  limits
);
assert.equal(capped.maxLifetimeMs, MAX_LIFETIME_MS);
assert.equal(capped.maxOwnerBytes, 1000);
assert.equal(capped.maxSessionBytes, 1000);
assert.equal(capped.maxOwnerEntries, 10);
assert.equal(capped.maxSessionEntries, 10);
assert.equal(artifactLifecyclePolicy({ maxLifetimeMs: 50 }, limits).maxLifetimeMs, 100);
assert.equal(canAdmitArtifact(new Map(), 'o', 's', 10, { ...limits, ...defaultPolicy }), true);
assert.equal(createContextArtifactStore(null).stats().entries, 0);
assert.equal(createContextArtifactStore([]).stats().entries, 0);

console.log('[context-artifact-lifecycle.test] ok');
