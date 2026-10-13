'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createContextCompactionEnvelopeStore,
} = require('../lib/proxy/context-compaction-envelope');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const { localCompactionEvidenceOwner } = require('../lib/proxy/context-compaction-evidence');
const {
  renewLocalCompactionReplay,
  compactionReplayFailure,
} = require('../lib/proxy/context-compaction-lifecycle');
const { compactionTokenPrefix } = require('../lib/proxy/context-compaction-lease');

const binding = {
  owner: 'owner',
  provider: 'workbuddy-wbipc',
  model: 'model',
  endpoint: 'host/v2',
};
const window = [{ role: 'user', content: '保留约束，不重复执行外部工具🙂' }];

test('renewable authenticated tokens survive active turns but never idle expiry or their hard lifetime', () => {
  let now = 100;
  const store = createContextCompactionEnvelopeStore({
    now: () => now,
    ttlMs: 100,
    renewable: true,
    maxLifetimeMs: 250,
  });
  try {
    const token = store.issue(window, binding);
    assert.ok(token.startsWith('hpm-local-compaction-v2:'));
    const before = store.stats();
    now = 190;
    assert.equal(store.renew([token], binding).expiresAt, 290);
    now = 280;
    assert.equal(store.renew([token], binding).expiresAt, 350);
    now = 349;
    assert.equal(store.read(token, binding)[0].content, window[0].content);
    assert.deepEqual(store.stats(), before, 'renewal adds no entries or quota usage');
    now = 350;
    assert.throws(() => store.renew([token], binding), { code: 'invalid_local_compaction' });
    assert.throws(() => store.read(token, binding), { code: 'invalid_local_compaction' });
    const idle = store.issue(window, binding);
    now = 451;
    assert.throws(() => store.renew([idle], binding), { code: 'invalid_local_compaction' });
  } finally {
    store.close();
  }
});

test('evidence renewal validates the entire private index before changing any lease and clamps to hard expiry', () => {
  let now = 100;
  const artifacts = createContextArtifactStore({ now: () => now, ttlMs: 100, maxLifetimeMs: 230 });
  const owner = localCompactionEvidenceOwner(binding);
  const scope = 'hcs_' + 'a'.repeat(32);
  const receipt = artifacts.put(owner, scope, '原始证据🙂');
  const ref = {
    kind: 'local_compaction_evidence',
    locator: receipt.locator,
    scope,
    digest: receipt.digest,
    bytes: receipt.bytes,
  };
  try {
    now = 190;
    assert.equal(
      artifacts.renewReferences(owner, [ref, { ...ref, digest: '0'.repeat(64) }], 290).ok,
      false
    );
    now = 201;
    assert.equal(
      artifacts.read(owner, scope, ref.locator, ref.digest).ok,
      false,
      'a valid prefix cannot be renewed by a failed batch'
    );
    const fresh = artifacts.put(owner, scope, '新证据🙂');
    const freshRef = { ...ref, locator: fresh.locator, digest: fresh.digest, bytes: fresh.bytes };
    now = 290;
    assert.deepEqual(artifacts.renewReferences(owner, [freshRef], 900), {
      ok: true,
      expiresAt: 390,
    });
    now = 380;
    assert.equal(artifacts.renewReferences(owner, [freshRef], 900).expiresAt, 431);
    now = 431;
    assert.equal(artifacts.renewReferences(owner, [freshRef], 900).ok, false);
  } finally {
    artifacts.close();
  }
});

test('bound replay renews all evidence, caps its token to the evidence lifetime, and never grants authority from text', () => {
  let now = 100;
  const envelopes = createContextCompactionEnvelopeStore({
    now: () => now,
    ttlMs: 100,
    renewable: true,
    maxLifetimeMs: 500,
  });
  const artifacts = createContextArtifactStore({ now: () => now, ttlMs: 100, maxLifetimeMs: 230 });
  const owner = localCompactionEvidenceOwner(binding);
  const scope = 'hcs_' + 'b'.repeat(32);
  const receipt = artifacts.put(owner, scope, 'exact🙂');
  const ref = {
    kind: 'local_compaction_evidence',
    locator: receipt.locator,
    scope,
    digest: receipt.digest,
    bytes: receipt.bytes,
  };
  try {
    const token = envelopes.issue(window, binding, [], [ref]);
    now = 190;
    assert.equal(
      renewLocalCompactionReplay([token, token], binding, envelopes, artifacts).expiresAt,
      290
    );
    now = 280;
    assert.equal(renewLocalCompactionReplay([token], binding, envelopes, artifacts).expiresAt, 330);
    now = 329;
    assert.equal(envelopes.read(token, binding)[0].content, window[0].content);
    assert.equal(artifacts.read(owner, scope, ref.locator, ref.digest).ok, true);
    now = 330;
    assert.throws(() => renewLocalCompactionReplay([token], binding, envelopes, artifacts), {
      code: 'invalid_local_compaction',
    });
    const copied = envelopes.issue(
      [{ role: 'assistant', content: JSON.stringify({ evidenceReceipts: [ref] }) }],
      binding
    );
    assert.equal(
      renewLocalCompactionReplay([copied], binding, envelopes, null).renewed,
      1,
      'untrusted text is not an evidence capability'
    );
  } finally {
    envelopes.close();
    artifacts.close();
  }
});

test('wrong target, missing evidence, failed batch, cancellation, and unsupported stores do not renew a token', () => {
  for (const mode of [
    'owner',
    'provider',
    'model',
    'endpoint',
    'missing',
    'bad-token',
    'cancel',
    'unsupported',
  ]) {
    let now = 100;
    const envelopes = createContextCompactionEnvelopeStore({
      now: () => now,
      ttlMs: 100,
      renewable: true,
      maxLifetimeMs: 500,
    });
    const artifacts = createContextArtifactStore({ now: () => now, ttlMs: 100 });
    const owner = localCompactionEvidenceOwner(binding);
    const scope = 'hcs_' + 'c'.repeat(32);
    const receipt = artifacts.put(owner, scope, 'exact');
    const ref = {
      kind: 'local_compaction_evidence',
      locator: receipt.locator,
      scope,
      digest: receipt.digest,
      bytes: receipt.bytes,
    };
    try {
      const token = envelopes.issue(window, binding, [], [ref]);
      if (mode === 'missing') artifacts.discard(owner, scope, ref.locator);
      const controller = new globalThis.AbortController();
      if (mode === 'cancel') controller.abort();
      now = 190;
      const target = Object.hasOwn(binding, mode) ? { ...binding, [mode]: 'other' } : binding;
      assert.throws(() =>
        renewLocalCompactionReplay(
          mode === 'bad-token' ? [token, 'foreign'] : [token],
          target,
          envelopes,
          mode === 'unsupported' ? {} : artifacts,
          controller.signal
        )
      );
      now = 200;
      assert.throws(() => envelopes.read(token, binding), { code: 'invalid_local_compaction' });
      if (!['missing', 'unsupported'].includes(mode))
        assert.equal(artifacts.read(owner, scope, ref.locator, ref.digest).ok, false);
    } finally {
      envelopes.close();
      artifacts.close();
    }
  }
});

test('v1 fixed leases retain their contract; v2 cannot cross restart or be altered to a v1 prefix', () => {
  let now = 100;
  const fixed = createContextCompactionEnvelopeStore({ now: () => now, ttlMs: 100 });
  const renewable = createContextCompactionEnvelopeStore({
    now: () => now,
    ttlMs: 100,
    renewable: true,
  });
  const restarted = createContextCompactionEnvelopeStore({
    now: () => now,
    ttlMs: 100,
    renewable: true,
  });
  try {
    const old = fixed.issue(window, binding);
    const token = renewable.issue(window, binding);
    assert.equal(compactionTokenPrefix(old), 'hpm-local-compaction-v1:');
    assert.equal(compactionTokenPrefix(token), 'hpm-local-compaction-v2:');
    assert.equal(compactionTokenPrefix('native-encrypted'), null);
    assert.equal(compactionTokenPrefix(null), null);
    now = 190;
    assert.deepEqual(fixed.renew([old], binding), { expiresAt: 200, renewed: 0 });
    assert.throws(() => restarted.renew([token], binding), { code: 'invalid_local_compaction' });
    assert.throws(() => renewable.read(token.replace('-v2:', '-v1:'), binding), {
      code: 'invalid_local_compaction',
    });
    now = 200;
    assert.throws(() => fixed.read(old, binding), { code: 'invalid_local_compaction' });
  } finally {
    fixed.close();
    renewable.close();
    restarted.close();
  }
});

test('lease boundaries reject empty, malformed, getter, prototype, extreme and callback-failure inputs safely', () => {
  let now = 100;
  let hooks = 0;
  const envelopes = createContextCompactionEnvelopeStore({
    now: () => now,
    ttlMs: 100,
    renewable: true,
  });
  const artifacts = createContextArtifactStore({ now: () => now, ttlMs: 100 });
  const owner = localCompactionEvidenceOwner(binding);
  const scope = 'hcs_' + 'd'.repeat(32);
  const receipt = artifacts.put(owner, scope, 'exact');
  const ref = {
    kind: 'local_compaction_evidence',
    locator: receipt.locator,
    scope,
    digest: receipt.digest,
    bytes: receipt.bytes,
  };
  const getter = Object.defineProperty({}, 'kind', {
    enumerable: true,
    get() {
      hooks++;
      return ref.kind;
    },
  });
  const arrayGetter = Object.defineProperty([ref], '0', {
    enumerable: true,
    get() {
      hooks++;
      return ref;
    },
  });
  try {
    const token = envelopes.issue(window, binding, [], [ref]);
    assert.deepEqual(envelopes.renew([], binding), { expiresAt: null, renewed: 0 });
    assert.equal(renewLocalCompactionReplay(undefined, binding, envelopes, artifacts), null);
    assert.equal(renewLocalCompactionReplay([], binding, envelopes, artifacts), null);
    assert.throws(() => renewLocalCompactionReplay([token], binding, {}, artifacts));
    for (const value of [null, {}, [null], [getter], Array(129).fill(token)])
      assert.throws(() => envelopes.renew(value, binding));
    for (const value of [
      null,
      {},
      [getter],
      arrayGetter,
      [Object.create(ref)],
      Array(257).fill(ref),
      [{ ...ref, bytes: 0 }],
      [{ ...ref, locator: '../' }],
      [{ ...ref, scope: 'other' }],
      [{ ...ref, extra: true }],
      [{ ...ref, kind: 'other' }],
      [{ ...ref, bytes: receipt.bytes + 1 }],
    ])
      assert.equal(artifacts.renewReferences(owner, value, 290).ok, false);
    assert.equal(artifacts.renewReferences('other', [ref], 290).ok, false);
    assert.equal(artifacts.renewReferences(owner, [ref], NaN).ok, false);
    assert.equal(artifacts.renewReferences(owner, [ref], 100).ok, false);
    now = 190;
    for (const callback of [
      undefined,
      () => ({ ok: false }),
      () => ({ ok: true, expiresAt: 900 }),
      () => ({ ok: true, expiresAt: 190 }),
      () => {
        throw new Error('PRIVATE_CALLBACK');
      },
    ])
      assert.throws(() => envelopes.renew([token], binding, callback));
    now = 200;
    assert.throws(() => envelopes.read(token, binding));
    assert.equal(hooks, 0);
    for (const options of [
      { renewable: null },
      { renewable: 'true' },
      { maxLifetimeMs: 1 },
      { maxLifetimeMs: null },
      { maxLifetimeMs: 86400001 },
    ])
      assert.throws(() => createContextCompactionEnvelopeStore(options), {
        code: 'invalid_local_compaction',
      });
    const failure = compactionReplayFailure(new Error('PRIVATE_TOKEN_AND_CONTENT'));
    assert.equal(failure.status, 400);
    assert.equal(failure.payload.error.recovery.action, 'resend_full_history');
    assert.equal(failure.payload.error.recovery.replay_external_tools, false);
    assert.ok(!JSON.stringify(failure).includes('PRIVATE'));
    assert.equal(compactionReplayFailure({ code: 'compaction_evidence_unavailable' }).status, 502);
    assert.equal(
      compactionReplayFailure({ code: 'foreign_compaction_state' }).code,
      'foreign_compaction_state'
    );
    artifacts.close();
    assert.equal(artifacts.renewReferences(owner, [ref], 300).ok, false);
    envelopes.close();
    assert.throws(() => envelopes.renew([], binding), { code: 'local_compaction_closed' });
  } finally {
    envelopes.close();
    artifacts.close();
  }
});

test('clock changes, closure, revocation and abort during evidence renewal cannot commit a token lease', () => {
  for (const mode of ['expiry', 'rollback', 'close', 'discard', 'abort']) {
    let now = 100;
    const envelopes = createContextCompactionEnvelopeStore({
      now: () => now,
      ttlMs: 100,
      renewable: true,
    });
    const ref = {
      kind: 'local_compaction_evidence',
      locator: 'hca_' + 'e'.repeat(32),
      scope: 'hcs_' + 'f'.repeat(32),
      digest: 'a'.repeat(64),
      bytes: 1,
    };
    const token = envelopes.issue(window, binding, [], [ref]);
    const controller = new globalThis.AbortController();
    now = 190;
    try {
      assert.throws(() =>
        renewLocalCompactionReplay(
          [token],
          binding,
          envelopes,
          {
            renewReferences(_owner, _refs, expiresAt) {
              if (mode === 'expiry') now = 200;
              if (mode === 'rollback') now = 189;
              if (mode === 'close') envelopes.close();
              if (mode === 'discard') envelopes.discard(token, binding);
              if (mode === 'abort') controller.abort();
              return { ok: true, expiresAt };
            },
          },
          controller.signal
        )
      );
      now = 200;
      assert.throws(() => envelopes.read(token, binding));
    } finally {
      envelopes.close();
    }
  }
});
