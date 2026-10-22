'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { normalizeRecoveryStateData } = require('../lib/proxy/context-recovery-state-data');
const {
  normalizeEvidenceLedgerEnvelope,
} = require('../lib/proxy/context-evidence-payload-envelope');
const { parseEvidenceLedgerState } = require('../lib/proxy/context-evidence-ledger-state');

const copy = (input) => globalThis.structuredClone(input);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const limits = {
  ttlMs: 1000,
  maxEntries: 64,
  maxOutputBytes: 1024 * 1024,
  maxBytes: 4 * 1024 * 1024,
};
function fixture(output = 'synthetic 中文🙂\r\n') {
  return {
    version: 9,
    other: { mutable: true },
    ledger: {
      version: 1,
      kind: 'evidence-ledger',
      ownerBinding: sha(JSON.stringify(['synthetic-owner', 'synthetic-thread'])),
      policy: { ...limits },
      observedAt: 100,
      capturedCount: 1,
      readCount: 0,
      sources: [
        {
          sourceId: 'hce_' + 'a'.repeat(32),
          callId: 'synthetic-call',
          toolName: 'synthetic',
          argumentsDigest: sha('{}'),
          bytes: Buffer.byteLength(output),
          digest: sha(output),
          output,
          createdAt: 100,
          expiresAt: 1100,
          coveredThrough: 0,
          readComplete: false,
        },
      ],
    },
  };
}
function api() {
  return require('../lib/proxy/context-recovery-ledger-admission');
}
function parsed(owned, settings = limits, owner = owned.state.ledger.ownerBinding) {
  return require('../lib/proxy/context-evidence-ledger-state').parseOwnedEvidenceLedgerState(
    owned.state.ledger,
    owner,
    settings,
    owned.proof
  );
}

function repeatedFixture(outputs) {
  const input = fixture();
  input.ledger.policy.maxEntries = 512;
  input.ledger.capturedCount = outputs.length;
  input.ledger.sources = outputs.map((output, index) => ({
    ...fixture(output).ledger.sources[0],
    sourceId: 'hce_' + index.toString(16).padStart(32, '0'),
    callId: 'synthetic-' + index,
  }));
  return input;
}

function validationCounts(t, outputs, fallback = false) {
  const watched = new Set(outputs);
  const counts = new Map();
  const count = (text) => {
    if (watched.has(text)) counts.set(text, (counts.get(text) ?? 0) + 1);
  };
  const descriptor = Object.getOwnPropertyDescriptor(String.prototype, 'isWellFormed');
  const original = descriptor?.value;
  t.after(() => {
    if (descriptor) Object.defineProperty(String.prototype, 'isWellFormed', descriptor);
    else delete String.prototype.isWellFormed;
  });
  if (fallback) {
    Object.defineProperty(String.prototype, 'isWellFormed', {
      configurable: true,
      value: undefined,
    });
    const from = Buffer.from;
    t.mock.method(Buffer, 'from', (value, ...args) => {
      if (typeof value === 'string') count(value);
      return Reflect.apply(from, Buffer, [value, ...args]);
    });
  } else {
    Object.defineProperty(String.prototype, 'isWellFormed', {
      configurable: true,
      value() {
        count(this);
        return typeof original === 'function'
          ? Reflect.apply(original, this, [])
          : Buffer.from(this, 'utf8').toString('utf8') === this;
      },
    });
  }
  return counts;
}

function normalizeRepeated(input, settings = { ...limits, maxEntries: 512 }) {
  const owned = api().admitRecoveryRoot(input);
  return api().normalizeOwnedRecoveryLedger(owned.state.ledger, owned.proof, settings);
}

test('owned successful-text cache scans repeated output once per invocation including empty text', (t) => {
  const text = 'cache-synthetic-中文🙂';
  const counts = validationCounts(t, [text, '']);
  const input = repeatedFixture([text, text, '', '', text]);
  assert.equal(normalizeRepeated(input).sources.length, 5);
  assert.equal(counts.get(text), 1);
  assert.equal(counts.get(''), 1);
  normalizeRepeated(input);
  assert.equal(counts.get(text), 2, 'a later invocation must validate again');
  assert.equal(counts.get(''), 2);
});

test('owned successful-text cache retains at most 128 successful distinct outputs', (t) => {
  const outputs = Array.from({ length: 129 }, (_, index) => 'cache-entry-' + index);
  const counts = validationCounts(t, outputs);
  normalizeRepeated(
    repeatedFixture([...outputs, outputs[0], outputs[127], outputs[128], outputs[128]])
  );
  assert.equal(counts.get(outputs[0]), 1);
  assert.equal(counts.get(outputs[127]), 1);
  assert.equal(counts.get(outputs[128]), 3, 'overflow entries are checked again, never retained');
});

test('owned successful-text cache preserves the exact four MiB raw retention bound', (t) => {
  const a = 'a'.repeat(2 * 1024 * 1024);
  const b = 'b'.repeat(2 * 1024 * 1024);
  const c = 'uncached-byte-overflow';
  const counts = validationCounts(t, [a, b, c]);
  const settings = {
    ...limits,
    maxEntries: 512,
    maxOutputBytes: 2 * 1024 * 1024,
    maxBytes: 16 * 1024 * 1024,
  };
  normalizeRepeated(repeatedFixture([a, b, a, b, c, c]), settings);
  assert.equal(counts.get(a), 1);
  assert.equal(counts.get(b), 1);
  assert.equal(counts.get(c), 2, 'no room remains for even one further raw byte');
  const input = repeatedFixture([a, a]);
  assert.throws(() => normalizeRepeated(input, { ...settings, maxOutputBytes: a.length - 1 }));
  assert.equal(
    counts.get(a),
    1,
    'each source raw limit is checked before UTF validation/cache use'
  );
});

test('owned successful-text cache keeps per-receipt semantic checks and never retains invalid UTF text', (t) => {
  const text = '🙂cache-receipt';
  const invalid = '\ud800';
  const counts = validationCounts(t, [text, invalid]);
  const settings = { ...limits, maxEntries: 512 };
  for (const change of [
    (s) => {
      s.digest = '0'.repeat(64);
    },
    (s) => {
      s.bytes--;
    },
    (s) => {
      s.coveredThrough = 1;
    },
    (s) => {
      s.expiresAt++;
    },
    (s) => {
      s.toolName = 'bad name';
    },
  ]) {
    const input = repeatedFixture([text, text]);
    change(input.ledger.sources[1]);
    assert.throws(() => parsed(api().admitRecoveryRoot(input), settings), {
      code: 'invalid_evidence_ledger_state',
    });
  }
  const bad = api().admitRecoveryRoot(repeatedFixture([invalid, invalid]));
  for (let index = 0; index < 2; index++)
    assert.throws(() => api().normalizeOwnedRecoveryLedger(bad.state.ledger, bad.proof, settings));
  assert.equal(counts.get(invalid), 2, 'failed validation must run again');
});

test('owned successful-text cache avoids duplicate older-runtime UTF8 fallback allocations while rejecting lone surrogates', (t) => {
  const text = 'fallback-cache-中文🙂';
  const invalid = '\udfff';
  const counts = validationCounts(t, [text, invalid], true);
  assert.equal(normalizeRepeated(repeatedFixture([text, text, text])).sources.length, 3);
  assert.equal(counts.get(text), 1);
  const bad = repeatedFixture([invalid]);
  assert.throws(() => normalizeRepeated(bad));
  assert.throws(() => normalizeRepeated(bad));
  assert.equal(counts.get(invalid), 2);
});

test('public root and ledger normalizers and parsers keep mutable isolated clones', () => {
  const input = fixture();
  const state = normalizeRecoveryStateData(input);
  const envelope = normalizeEvidenceLedgerEnvelope(input.ledger, limits.maxOutputBytes, 64);
  const ledger = parseEvidenceLedgerState(input.ledger, input.ledger.ownerBinding, limits);
  for (const value of [state.ledger, envelope, ledger]) {
    assert.equal(Object.isFrozen(value), false);
    assert.equal(Object.isFrozen(value.policy), false);
    assert.equal(Object.isFrozen(value.sources), false);
    assert.equal(Object.isFrozen(value.sources[0]), false);
    value.sources[0].output = 'mutable synthetic output';
    value.policy.ttlMs++;
    value.sources.push({ mutable: true });
    assert.notEqual(value.sources[0].output, input.ledger.sources[0].output);
  }
  state.other.mutable = false;
  assert.equal(input.other.mutable, true);
});

test('owned root admission freezes only private root shell and ledger with unchanged semantics', () => {
  const input = fixture();
  const owned = api().admitRecoveryRoot(input);
  assert.notEqual(owned.state, input);
  assert.equal(Object.isFrozen(owned.state), true);
  for (const value of [
    owned.state.ledger,
    owned.state.ledger.policy,
    owned.state.ledger.sources,
    owned.state.ledger.sources[0],
  ])
    assert.equal(Object.isFrozen(value), true);
  owned.state.other.mutable = false;
  assert.equal(input.other.mutable, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(parsed(owned))),
    JSON.parse(JSON.stringify(input.ledger))
  );
  input.ledger.sources[0].output = 'later external mutation';
  assert.notEqual(parsed(owned).sources[0].output, input.ledger.sources[0].output);
  assert.throws(() => {
    owned.state.ledger = input.ledger;
  }, TypeError);
});

test('owned proof cannot be forged or transferred to other input and retains component limits', () => {
  const owned = api().admitRecoveryRoot(fixture());
  const normalize = api().normalizeOwnedRecoveryLedger;
  for (const proof of [undefined, null, false, {}, Object.freeze({}), copy(owned.proof)])
    assert.throws(() => normalize(owned.state.ledger, proof, limits));
  for (const input of [
    copy(owned.state.ledger),
    Object.freeze(copy(owned.state.ledger)),
    fixture().ledger,
  ])
    assert.throws(() => normalize(input, owned.proof, limits));
  const another = api().admitRecoveryRoot(fixture());
  assert.throws(() => normalize(another.state.ledger, owned.proof, limits));
  assert.throws(() => parsed(owned, { ...limits, maxOutputBytes: 1 }));
  assert.throws(() => parsed(owned, { ...limits, maxEntries: 0 }));
  assert.throws(() => parsed(owned, limits, 'different-owner'));
  for (const version of [undefined, 1, 8, 11])
    assert.throws(() => api().admitRecoveryRoot({ ...fixture(), version }));
});

test('owned envelope preserves empty sources and rejects hostile descriptors without running hooks', () => {
  const empty = fixture('');
  empty.ledger.sources = [];
  empty.ledger.capturedCount = 0;
  assert.equal(parsed(api().admitRecoveryRoot(empty)).sources.length, 0);
  const emptyBody = fixture('');
  emptyBody.ledger.sources[0].readComplete = true;
  emptyBody.ledger.readCount = 1;
  assert.equal(parsed(api().admitRecoveryRoot(emptyBody)).sources[0].output, '');
  let touched = 0;
  const hook = () => {
    touched++;
    throw new Error('synthetic hook executed');
  };
  const getter = fixture();
  Object.defineProperty(getter.ledger.sources[0], 'output', { enumerable: true, get: hook });
  const sparse = fixture();
  sparse.ledger.sources = Array(1);
  const symbol = fixture();
  symbol.ledger[Symbol('synthetic')] = 1;
  const custom = fixture();
  Object.setPrototypeOf(custom.ledger, { toJSON: hook });
  const method = fixture();
  method.ledger.toJSON = hook;
  for (const input of [null, [], getter, sparse, symbol, custom, method])
    assert.throws(() => api().admitRecoveryRoot(input));
  assert.equal(touched, 0);
});

test('owned structural proof never bypasses digest, policy, expiry, coverage or duplicate checks', () => {
  const cases = [
    (s) => {
      s.sources[0].digest = '0'.repeat(64);
    },
    (s) => {
      s.sources[0].expiresAt++;
    },
    (s) => {
      s.sources[0].coveredThrough = 1;
      s.sources[0].readComplete = true;
    },
    (s) => {
      s.sources[0].createdAt++;
    },
    (s) => {
      s.policy.ttlMs++;
    },
    (s) => {
      s.sources.push({ ...s.sources[0] });
      s.capturedCount++;
    },
    (s) => {
      s.readCount = -1;
    },
    (s) => {
      s.sources[0].bytes++;
    },
    (s) => {
      s.sources[0].output = '\ud800';
    },
    (s) => {
      s.sources[0].toolName = { nested: true };
    },
    (s) => {
      s.policy.extra = 1;
    },
  ];
  for (const change of cases) {
    const input = fixture();
    change(input.ledger);
    const owned = api().admitRecoveryRoot(input);
    assert.throws(() => parsed(owned), { code: 'invalid_evidence_ledger_state' });
  }
});

test('owned clone shares original exact encoded byte, depth, node and alias admission', () => {
  const normalize = api().admitRecoveryRoot;
  const input = fixture('quotes"\\\u0000🙂');
  const size = Buffer.byteLength(JSON.stringify(input));
  assert.doesNotThrow(() => normalize(input, size));
  assert.throws(() => normalize(input, size - 1));
  const cyclic = fixture();
  cyclic.other.self = cyclic.other;
  assert.throws(() => normalize(cyclic));
  const alias = fixture();
  alias.copy = alias.other;
  const cloned = normalize(alias).state;
  assert.notEqual(cloned.other, cloned.copy);
  for (const input of [
    { version: 9, ledger: Array(65535).fill(null) },
    { version: 9, ledger: { nested: Array(65534).fill(null) } },
  ]) {
    assert.throws(() => normalizeRecoveryStateData(input));
    assert.throws(() => normalize(input));
  }
  let deep = null;
  for (let index = 0; index < 63; index++) deep = { child: deep };
  assert.doesNotThrow(() => normalize({ version: 9, ledger: deep }));
  assert.throws(() => normalize({ version: 9, ledger: { child: deep } }));
});

test('modified global toJSON retains original envelope fallback and does not grant proof authority', () => {
  const owned = api().admitRecoveryRoot(fixture());
  const original = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  let calls = 0;
  try {
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      value() {
        calls++;
        return Array.from(this);
      },
    });
    const actual = parsed(owned);
    assert.ok(calls > 0);
    assert.equal(Object.isFrozen(actual), false, 'fallback keeps original normalization');
    assert.equal(actual.sources.length, 1);
  } finally {
    if (original) Object.defineProperty(Array.prototype, 'toJSON', original);
    else delete Array.prototype.toJSON;
  }
});

for (const mode of ['throw', 'encoded-limit'])
  test(`inherited array toJSON ${mode} keeps original envelope refusal`, () => {
    const owned = api().admitRecoveryRoot(fixture());
    const previous = Object.getPrototypeOf(Array.prototype);
    const intermediate = Object.create(previous);
    let calls = 0;
    Object.defineProperty(intermediate, 'toJSON', {
      value() {
        calls++;
        if (mode === 'throw') throw new Error('synthetic inherited serialization failure');
        return 'x'.repeat(12 * 1024 * 1024);
      },
    });
    let originalError, ownedError;
    try {
      Object.setPrototypeOf(Array.prototype, intermediate);
      try {
        normalizeEvidenceLedgerEnvelope(owned.state.ledger, limits.maxOutputBytes, 64);
      } catch (error) {
        originalError = error;
      }
      try {
        api().normalizeOwnedRecoveryLedger(owned.state.ledger, owned.proof, limits);
      } catch (error) {
        ownedError = error;
      }
    } finally {
      Object.setPrototypeOf(Array.prototype, previous);
    }
    assert.ok(originalError instanceof Error, 'original envelope must refuse the hook');
    assert.ok(ownedError instanceof Error, 'owned envelope must preserve original refusal');
    assert.equal(calls, 2, 'both routes must observe the inherited serialization hook');
  });

test('owned envelope retains independent source metadata, ledger metadata and encoded ceilings', () => {
  const check = (input, settings = limits) => {
    const owned = api().admitRecoveryRoot(input);
    const envelopeBytes =
      settings.maxBytes > 8 * 1024 * 1024 ? 112 * 1024 * 1024 : 12 * 1024 * 1024;
    let expected, failure;
    try {
      expected = normalizeEvidenceLedgerEnvelope(
        input.ledger,
        settings.maxOutputBytes,
        settings.maxEntries,
        envelopeBytes
      );
    } catch (error) {
      failure = error;
    }
    if (failure)
      assert.throws(() =>
        api().normalizeOwnedRecoveryLedger(owned.state.ledger, owned.proof, settings)
      );
    else
      assert.deepEqual(
        JSON.parse(
          JSON.stringify(
            api().normalizeOwnedRecoveryLedger(owned.state.ledger, owned.proof, settings)
          )
        ),
        JSON.parse(JSON.stringify(expected))
      );
  };
  const meta = fixture('').ledger.sources[0];
  delete meta.output;
  const overhead = Buffer.byteLength(JSON.stringify(meta)) - meta.callId.length;
  for (const extra of [0, 1]) {
    const input = fixture('');
    input.ledger.sources[0].callId = 'x'.repeat(8192 - overhead + extra);
    check(input);
  }
  const empty = fixture();
  empty.ledger.sources = [];
  empty.ledger.policy = { filler: '' };
  const ledgerMeta = { ...empty.ledger };
  delete ledgerMeta.sources;
  const ledgerOverhead = Buffer.byteLength(JSON.stringify(ledgerMeta));
  for (const extra of [0, 1]) {
    const input = copy(empty);
    input.ledger.policy.filler = 'x'.repeat(256 * 1024 - ledgerOverhead + extra);
    check(input);
  }
  for (const extra of [0, 1])
    check(fixture('x'.repeat(2 * 1024 * 1024 + extra)), {
      ...limits,
      maxOutputBytes: 2 * 1024 * 1024,
    });
  const encoded = fixture('\\'.repeat(1024 * 1024));
  encoded.ledger.sources = Array.from({ length: 6 }, () => ({ ...encoded.ledger.sources[0] }));
  check(encoded);
  check(encoded, { ...limits, maxBytes: 16 * 1024 * 1024 });
});

test('owned artifact reconstruction keeps creation time, closes failed stores and preserves default output limit', (t) => {
  const storeModule = require('../lib/proxy/context-artifact-store');
  const create = storeModule.createContextArtifactStore;
  const file = require.resolve('../lib/proxy/context-evidence-ledger');
  const cached = require.cache[file];
  let mode = 'normal',
    closes = 0;
  const putTimes = [];
  t.mock.method(storeModule, 'createContextArtifactStore', (settings) => {
    const store = create(settings);
    return {
      ...store,
      put(...args) {
        putTimes.push(settings.now());
        if (mode === 'throw') throw new Error('synthetic storage failure');
        const receipt = store.put(...args);
        return mode === 'wrong-expiry' ? { ...receipt, expiresAt: receipt.expiresAt + 1 } : receipt;
      },
      close() {
        closes++;
        return store.close();
      },
    };
  });
  let restored;
  try {
    delete require.cache[file];
    const ledger = require('../lib/proxy/context-evidence-ledger');
    const owned = api().admitRecoveryRoot(fixture());
    let time = 200;
    const settings = {
      owner: 'synthetic-owner',
      threadId: 'synthetic-thread',
      ttlMs: 1000,
      now: () => time,
    };
    restored = ledger.restoreOwnedContextEvidenceLedger(settings, owned.state.ledger, owned.proof);
    assert.deepEqual(putTimes, [100]);
    assert.equal(ledger.exportContextEvidenceLedger(restored).sources[0].expiresAt, 1100);
    assert.match(
      restored.capture({
        callId: 'after-restore',
        toolName: 'synthetic',
        arguments: {},
        output: 'fresh',
        completed: true,
      }).sourceId,
      /^hce_[a-f0-9]{32}$/
    );
    assert.equal(ledger.exportContextEvidenceLedger(restored).sources.length, 2);
    time = 1100;
    assert.equal(ledger.exportContextEvidenceLedger(restored).sources.length, 1);
    restored.close();
    restored = null;
    time = 200;
    for (mode of ['throw', 'wrong-expiry']) {
      const before = closes;
      assert.throws(
        () => ledger.restoreOwnedContextEvidenceLedger(settings, owned.state.ledger, owned.proof),
        { code: 'invalid_evidence_ledger_state' }
      );
      assert.equal(closes, before + 1);
    }
    mode = 'normal';
    const large = api().admitRecoveryRoot(fixture('x'.repeat(1024 * 1024 + 1)));
    assert.throws(
      () => ledger.restoreOwnedContextEvidenceLedger(settings, large.state.ledger, large.proof),
      { code: 'invalid_evidence_ledger_state' }
    );
    assert.throws(
      () => ledger.restoreOwnedContextEvidenceLedger(settings, owned.state.ledger, {}),
      { code: 'invalid_evidence_ledger_state' }
    );
    assert.throws(() => ledger.restoreOwnedContextEvidenceLedger(settings, owned.state.ledger), {
      code: 'invalid_evidence_ledger_state',
    });
    assert.throws(
      () =>
        ledger.restoreOwnedContextEvidenceLedger(
          { ...settings, now: () => 99 },
          owned.state.ledger,
          owned.proof
        ),
      { code: 'invalid_evidence_ledger_state' }
    );
  } finally {
    restored?.close();
    if (cached) require.cache[file] = cached;
    else delete require.cache[file];
  }
});
