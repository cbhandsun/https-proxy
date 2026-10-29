'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Hash } = require('node:crypto');
const { createEvidencePayloadVerifier } = require('../lib/proxy/context-evidence-payload-verifier');
const { isWellFormedEvidenceText } = require('../lib/proxy/context-evidence-utf8');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  createContextEvidenceLedger,
  exportContextEvidenceLedger,
  restoreContextEvidenceLedger,
  readContextEvidenceStoredPage,
  exportContextEvidenceMetadata,
  exportContextEvidencePayloads,
  restoreContextEvidenceMetadata,
  evictContextEvidencePayloads,
  contextEvidenceResidency,
} = require('../lib/proxy/context-evidence-ledger');
const {
  parseEvidenceLedgerMetadata,
  parseEvidenceLedgerState,
} = require('../lib/proxy/context-evidence-ledger-state');
const { buildContextArtifactPage } = require('../lib/proxy/context-artifact-page');
const { openContextRecoveryStorage } = require('../lib/proxy/context-recovery-storage');
const {
  normalizeEvidenceLedgerEnvelope,
  normalizeEvidencePayloadEnvelope,
} = require('../lib/proxy/context-evidence-payload-envelope');
const { parseReferencePayloads } = require('../lib/proxy/context-recovery-reference-write');

const clone = (value) => JSON.parse(JSON.stringify(value));
const fail = { code: 'invalid_evidence_ledger_state' };
const capture = (ledger, callId, output) =>
  ledger.capture({ callId, toolName: 'synthetic', arguments: {}, output, completed: true });

test('native evidence text validation matches UTF-8 roundtrips and the older-runtime fallback', () => {
  const verify = () => {
    for (let unit = 0; unit <= 0xffff; unit++) {
      const text = String.fromCharCode(unit);
      assert.equal(isWellFormedEvidenceText(text), Buffer.from(text).toString('utf8') === text);
    }
    for (let point = 0x10000; point <= 0x10ffff; point += 2048) {
      const text = Array.from({ length: 2048 }, (_, index) =>
        String.fromCodePoint(point + index)
      ).join('');
      assert.equal(isWellFormedEvidenceText(text), true);
    }
    for (const text of [
      '',
      'ascii',
      '中文🙂',
      '\ud800\ud800\udc00',
      '\udc00\ud800',
      'x\udfff',
      '\ud800x',
      '\u0000\r\n"\\',
    ])
      assert.equal(isWellFormedEvidenceText(text), Buffer.from(text).toString('utf8') === text);
    let accessed = false;
    for (const input of [
      null,
      undefined,
      false,
      0,
      [],
      {
        toString() {
          accessed = true;
          return 'text';
        },
      },
    ])
      assert.equal(isWellFormedEvidenceText(input), false);
    assert.equal(accessed, false);
  };
  verify();
  const original = Object.getOwnPropertyDescriptor(String.prototype, 'isWellFormed');
  try {
    Object.defineProperty(String.prototype, 'isWellFormed', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    verify();
  } finally {
    if (original) Object.defineProperty(String.prototype, 'isWellFormed', original);
    else delete String.prototype.isWellFormed;
  }
});

test('native payload validation avoids full-text roundtrip copies while retaining hash and offset checks', (t) => {
  const text = 'retained-中文🙂\r\n'.repeat(32768);
  const bytes = Buffer.byteLength(text);
  const digest = createHash('sha256').update(text).digest('hex');
  const original = Buffer.from;
  let copies = 0;
  t.mock.method(Buffer, 'from', function (input, ...args) {
    if (input === text) copies++;
    return Reflect.apply(original, this, [input, ...args]);
  });
  const native = typeof String.prototype.isWellFormed === 'function';
  assert.equal(
    normalizeEvidencePayloadEnvelope([{ sourceId: 'hce_' + 'a'.repeat(32), output: text }])[0]
      .output,
    text
  );
  assert.equal(copies, native ? 0 : 1);
  const verify = createEvidencePayloadVerifier();
  assert.equal(verify(text, bytes, digest, 0), true);
  assert.equal(copies, native ? 1 : 3);
  const before = copies;
  assert.equal(verify(text, bytes, digest, bytes), true);
  assert.equal(verify(text, bytes, 'f'.repeat(64), 0), false);
  assert.equal(verify(text, bytes, digest, Buffer.byteLength('retained-') + 1), false);
  assert.equal(copies, before);
  assert.throws(() =>
    normalizeEvidencePayloadEnvelope([{ sourceId: 'hce_' + 'b'.repeat(32), output: '\ud800' }])
  );
  assert.equal(verify('\ud800', 3, digest, 0), false);
});

test('ledger parser verifies duplicate payload bytes once while rejecting changed receipts', () => {
  const f = fixture();
  try {
    const text = 'duplicate-中文😀'.repeat(1024);
    for (let index = 0; index < 3; index++) capture(f.ledger, 'duplicate-' + index, text);
    const state = exportContextEvidenceLedger(f.ledger);
    const digest = Hash.prototype.digest;
    let calls = 0;
    try {
      Hash.prototype.digest = function (...args) {
        calls++;
        return digest.apply(this, args);
      };
      assert.deepEqual(parseEvidenceLedgerState(state, state.ownerBinding, state.policy), state);
    } finally {
      Hash.prototype.digest = digest;
    }
    assert.equal(calls, 2, 'the first distinct payload and repeated payload each need one digest');
    for (const alter of [
      (source) => {
        source.digest = 'f'.repeat(64);
      },
      (source) => {
        source.bytes++;
      },
      (source) => {
        source.coveredThrough = Buffer.byteLength('duplicate-') + 1;
      },
    ]) {
      const changed = clone(state);
      alter(changed.sources.at(-1));
      assert.throws(
        () => parseEvidenceLedgerState(changed, state.ownerBinding, state.policy),
        fail
      );
    }
  } finally {
    f.ledger.close();
  }
});

test('payload verification preserves exact UTF-8 boundaries and rechecks each receipt on a cache hit', () => {
  const verify = createEvidencePayloadVerifier();
  for (const text of ['', 'ascii', '中文😀é', '\u0000\n"\\']) {
    const payload = Buffer.from(text);
    const digest = createHash('sha256').update(payload).digest('hex');
    for (let offset = 0; offset <= payload.length; offset++) {
      const prefix = payload.subarray(0, offset);
      assert.equal(
        verify(text, payload.length, digest, offset),
        Buffer.from(prefix.toString('utf8')).equals(prefix)
      );
    }
    assert.equal(verify(text, payload.length, 'f'.repeat(64), 0), false);
    assert.equal(verify(text, payload.length + 1, digest, 0), false);
  }
  const digest = createHash('sha256').update('a').digest('hex');
  for (const args of [
    [null, 1, digest, 0],
    ['a', -1, digest, 0],
    ['a', NaN, digest, 0],
    ['a', Infinity, digest, 0],
    ['a', 2097153, digest, 0],
    ['a', 1, null, 0],
    ['a', 1, 'G'.repeat(64), 0],
    ['a', 1, digest, -1],
    ['a', 1, digest, 2],
    ['a', 1, digest, 0.5],
    ['\ud800', 3, digest, 0],
  ])
    assert.equal(verify(...args), false);
});

test('payload verification retains only 128 entries and four MiB within one parser invocation', () => {
  const digest = Hash.prototype.digest;
  let calls = 0;
  try {
    Hash.prototype.digest = function (...args) {
      calls++;
      return digest.apply(this, args);
    };
    const sha = (text) => createHash('sha256').update(text).digest('hex');
    const values = Array.from({ length: 129 }, (_, index) => 'value-' + index);
    const hashes = values.map(sha);
    calls = 0;
    const verify = createEvidencePayloadVerifier();
    for (const [index, text] of values.entries())
      assert.equal(verify(text, Buffer.byteLength(text), hashes[index], 0), true);
    assert.equal(calls, 129);
    assert.equal(verify(values[0], values[0].length, hashes[0], 0), true);
    assert.equal(calls, 129);
    assert.equal(verify(values[128], values[128].length, hashes[128], 0), true);
    assert.equal(calls, 130);
    const large = ['a', 'b', 'c'].map((text) => text.repeat(2 * 1024 * 1024));
    const largeHashes = large.map(sha);
    calls = 0;
    const bounded = createEvidencePayloadVerifier();
    for (const [index, text] of large.entries())
      assert.equal(bounded(text, text.length, largeHashes[index], 0), true);
    assert.equal(calls, 3);
    assert.equal(bounded(large[0], large[0].length, largeHashes[0], 0), true);
    assert.equal(calls, 3);
    assert.equal(bounded(large[2], large[2].length, largeHashes[2], 0), true);
    assert.equal(calls, 4);
    assert.equal(
      createEvidencePayloadVerifier()(large[0], large[0].length, largeHashes[0], 0),
      true
    );
    assert.equal(
      calls,
      5,
      'separate parser invocations do not share raw originals or verification facts'
    );
  } finally {
    Hash.prototype.digest = digest;
  }
});

test('partitioned originals preserve JSON bytes at the exact aggregate bound without serializing outputs', () => {
  const maximum = 12 * 1024 * 1024;
  const perSource = 2 * 1024 * 1024;
  const values = Array.from({ length: 6 }, (_, index) => ({
    sourceId: 'hce_' + index.toString(16).padStart(32, '0'),
    output: '',
  }));
  const overhead = Buffer.byteLength(JSON.stringify(values));
  for (let index = 0; index < 5; index++) values[index].output = 'x'.repeat(perSource);
  const escaped = Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)).join('');
  const prefix = escaped + '"\\é🙂\u2028\u2029\u007f\u0085\u009f';
  const prefixBytes = Buffer.byteLength(JSON.stringify(prefix)) - 2;
  values[5].output = prefix + 'z'.repeat(maximum - overhead - 5 * perSource - prefixBytes);
  assert.equal(Buffer.byteLength(JSON.stringify(values)), maximum);
  const stringify = JSON.stringify;
  let serializations = 0;
  let parsed;
  try {
    JSON.stringify = (input, ...options) => {
      // The parser may encode small metadata, never a payload or full list.
      assert.equal(Array.isArray(input), false);
      assert.equal(typeof input, 'object');
      assert.equal(Object.hasOwn(input, 'output'), false);
      serializations++;
      return stringify(input, ...options);
    };
    parsed = parseReferencePayloads(values);
  } finally {
    JSON.stringify = stringify;
  }
  assert.ok(serializations > 0);
  assert.deepEqual(clone(parsed), values);
  parsed[0].output = 'independent';
  assert.equal(values[0].output.length, perSource);
  values[5].output += 'x';
  assert.throws(() => parseReferencePayloads(values), { code: 'invalid_recovery_reference_write' });
  assert.equal(normalizeEvidencePayloadEnvelope([]).length, 0);
});

test('payload batch uses the root version byte category while preserving the default ceiling', () => {
  const values = Array.from({ length: 16 }, (_, index) => ({
    sourceId: 'hce_' + index.toString(16).padStart(32, '0'),
    output: '\u0000'.repeat(1024 * 1024),
  }));
  assert.equal(parseReferencePayloads(values, 9).length, 16);
  assert.equal(parseReferencePayloads(values, 10).length, 16);
  for (const version of [undefined, 1, 7, 8, 11, '9', NaN, null])
    assert.throws(() => parseReferencePayloads(values, version));
  const overflow = Array.from({ length: 19 }, (_, index) => ({
    sourceId: 'hce_' + index.toString(16).padStart(32, '0'),
    output: values[0].output,
  }));
  assert.throws(() => parseReferencePayloads(overflow, 9));
  assert.throws(() => parseReferencePayloads(overflow, 10));
  assert.throws(() => normalizeEvidencePayloadEnvelope([], 113 * 1024 * 1024));
  assert.deepEqual(parseReferencePayloads([], 9), []);
});

test('partitioned ledger validation preserves receipts and never serializes original outputs', () => {
  const f = fixture();
  try {
    capture(f.ledger, 'escaped', '\u0000\b\t\n\f\r"\\🙂');
    capture(f.ledger, 'empty', '');
    const expected = exportContextEvidenceLedger(f.ledger);
    const stringify = JSON.stringify;
    let parsed;
    try {
      JSON.stringify = (input, ...options) => {
        assert.equal(typeof input, 'object');
        assert.equal(Array.isArray(input), false);
        assert.equal(Object.hasOwn(input, 'output'), false);
        if (Object.hasOwn(input, 'sources')) assert.equal(input.sources.length, 0);
        return stringify(input, ...options);
      };
      parsed = parseEvidenceLedgerState(expected, expected.ownerBinding, expected.policy);
    } finally {
      JSON.stringify = stringify;
    }
    assert.deepEqual(parsed, expected);
    assert.equal(parsed.sources[0].expiresAt, expected.sources[0].expiresAt);
    assert.equal(parsed.readCount, expected.readCount);
    parsed.sources[0].output = 'modified';
    assert.notEqual(expected.sources[0].output, 'modified');
  } finally {
    f.ledger.close();
  }
});

test('partitioned payload boundary rejects unsafe descriptors, invalid strings and resource overflow', () => {
  const payload = { sourceId: 'hce_' + 'a'.repeat(32), output: '' };
  let invoked = 0;
  const get = () => {
    invoked++;
    throw Error('synthetic-private-value');
  };
  const accessor = Object.defineProperty({ ...payload }, 'output', { enumerable: true, get });
  const arrayAccessor = Object.defineProperty([], '0', { enumerable: true, get });
  const nested = {
    ...payload,
    sourceId: {
      get value() {
        return get();
      },
    },
  };
  const values = [
    undefined,
    null,
    {},
    'invalid',
    [null],
    [1],
    Array(1),
    arrayAccessor,
    Object.assign(Object.create([]), [payload]),
    Object.assign([payload], { extra: true }),
    Object.assign([payload], { [Symbol('private')]: true }),
    [accessor],
    [nested],
    [Object.assign(Object.create({}), payload)],
    [Object.defineProperty({ ...payload }, 'output', { value: '', enumerable: false })],
    [{ ...payload, [Symbol('private')]: true }],
    [{ ...payload, toJSON: get }],
    [{ ...payload, sourceId: get }],
    [{ ...payload, output: null }],
    [{ ...payload, output: '\ud800' }],
    [{ ...payload, output: 'x'.repeat(2 * 1024 * 1024 + 1) }],
    Array(513).fill(payload),
    Array(3).fill({ ...payload, output: '\u0000'.repeat(1024 * 1024) }),
  ];
  for (const input of values) assert.throws(() => normalizeEvidencePayloadEnvelope(input));
  assert.equal(invoked, 0);
  const many = Array.from({ length: 512 }, (_, index) => ({
    ...payload,
    sourceId: 'hce_' + index.toString(16).padStart(32, '0'),
  }));
  assert.equal(parseReferencePayloads(many).length, 512);
  assert.throws(() => parseReferencePayloads([payload, payload]), {
    code: 'invalid_recovery_reference_write',
  });
});

test('partitioned ledger rejects malformed envelopes and retains scalar and aggregate limits', () => {
  const f = fixture();
  try {
    const state = exportContextEvidenceLedger(f.ledger);
    const parse = (input, maximum = state.policy.maxOutputBytes, count = state.policy.maxEntries) =>
      normalizeEvidenceLedgerEnvelope(input, maximum, count);
    let invoked = 0;
    const getter = () => {
      invoked++;
      return state.sources;
    };
    const accessor = Object.defineProperty({ ...state }, 'sources', {
      enumerable: true,
      get: getter,
    });
    for (const input of [
      null,
      [],
      {},
      accessor,
      { ...state, extra: true },
      { ...state, sources: null },
      { ...state, sources: Array(1) },
      { ...state, sources: [{ ...state.sources[0], bytes: {} }] },
      { ...state, sources: [{ ...state.sources[0], callId: 'x'.repeat(8192) }] },
    ])
      assert.throws(() => parse(input));
    assert.equal(invoked, 0);
    for (const limit of [0, -1, NaN, 1.5, 2 * 1024 * 1024 + 1])
      assert.throws(() => parse(state, limit));
    for (const count of [0, -1, NaN, 1.5, 513])
      assert.throws(() => parse(state, state.policy.maxOutputBytes, count));
    const sources = Array.from({ length: 7 }, () => ({
      ...state.sources[0],
      output: 'x'.repeat(2 * 1024 * 1024),
    }));
    assert.throws(() => parse({ ...state, sources }, 2 * 1024 * 1024));
    assert.equal(parse({ ...state, sources: [] }).sources.length, 0);
  } finally {
    f.ledger.close();
  }
});

test('partitioned ledger applies the aggregate bound to metadata plus escaped originals', () => {
  const f = fixture();
  try {
    const state = exportContextEvidenceLedger(f.ledger);
    state.policy.maxEntries = 512;
    state.policy.maxBytes = 8 * 1024 * 1024;
    state.sources = Array.from({ length: 6 }, (_, index) => ({
      ...state.sources[0],
      sourceId: 'hce_' + index.toString(16).padStart(32, '0'),
      callId: 'call' + index,
      output: '',
      bytes: 0,
      coveredThrough: 0,
      readComplete: false,
    }));
    state.capturedCount = state.sources.length;
    const overhead = Buffer.byteLength(JSON.stringify(state));
    for (const source of state.sources) source.output = '\\'.repeat(1024 * 1024);
    const last = state.sources.at(-1);
    // Byte counts may change the metadata width. First test the shape boundary
    // independently, then authenticate all digests/counts in the real parser.
    last.output = '\\'.repeat(1024 * 1024 - Math.ceil(overhead / 2)) + (overhead % 2 ? 'x' : '');
    assert.equal(Buffer.byteLength(JSON.stringify(state)), 12 * 1024 * 1024);
    assert.equal(normalizeEvidenceLedgerEnvelope(state, 1024 * 1024, 512).sources.length, 6);
    last.output += 'x';
    assert.throws(() => normalizeEvidenceLedgerEnvelope(state, 1024 * 1024, 512));
    last.output = last.output.slice(0, -32);
    for (const source of state.sources) {
      source.bytes = Buffer.byteLength(source.output);
      source.digest = createHash('sha256').update(source.output).digest('hex');
    }
    assert.equal(
      parseEvidenceLedgerState(state, state.ownerBinding, state.policy).sources.length,
      6
    );
  } finally {
    f.ledger.close();
  }
});
function fixture(overrides = {}) {
  let time = 100;
  const options = {
    owner: 'synthetic-owner',
    threadId: 'synthetic-thread',
    now: () => time,
    ...overrides,
  };
  const ledger = createContextEvidenceLedger(options);
  const receipt = capture(ledger, 'first', 'a🙂é\r\n原文');
  return {
    options,
    ledger,
    receipt,
    setTime(value) {
      time = value;
    },
  };
}

test('metadata restore retains cold evidence and validates exact asynchronous pages without resident originals', async () => {
  const f = fixture();
  let cold;
  try {
    const empty = capture(f.ledger, 'empty', '');
    f.ledger.read({ sourceId: f.receipt.sourceId, digest: f.receipt.digest, limitBytes: 1 });
    const metadata = exportContextEvidenceMetadata(f.ledger);
    cold = restoreContextEvidenceMetadata(f.options, metadata);
    assert.deepEqual(contextEvidenceResidency(cold), {
      residentBytes: 0,
      residentEntries: 0,
      coldEntries: 1,
    });
    assert.deepEqual(exportContextEvidenceMetadata(cold), metadata);
    assert.equal(
      cold.read({ sourceId: f.receipt.sourceId, digest: f.receipt.digest }).error,
      'context_evidence_unavailable'
    );
    assert.throws(() => exportContextEvidenceLedger(cold), fail);
    assert.throws(() => exportContextEvidencePayloads(cold, [f.receipt.sourceId]), fail);
    assert.deepEqual(exportContextEvidencePayloads(cold, [empty.sourceId]), [
      { sourceId: empty.sourceId, output: '' },
    ]);
    const page = await readContextEvidenceStoredPage(
      cold,
      { sourceId: f.receipt.sourceId, digest: f.receipt.digest },
      16384,
      async (source) => ({
        ...buildContextArtifactPage('a🙂é\r\n原文', 'utf8', source.digest),
        source,
      })
    );
    assert.equal(page.page.text, 'a🙂é\r\n原文');
    assert.equal(cold.inspect().readCount, metadata.readCount + 1);
    assert.equal(exportContextEvidenceMetadata(cold).sources[0].readComplete, true);
    assert.equal(
      exportContextEvidenceMetadata(cold).sources[0].expiresAt,
      metadata.sources[0].expiresAt
    );
    assert.equal(contextEvidenceResidency(cold).residentBytes, 0);
  } finally {
    f.ledger.close();
    cold?.close();
  }
});

test('eviction validates every source before discarding, is idempotent, and preserves logical capacity', () => {
  const f = fixture({ maxOutputBytes: 32, maxBytes: 32 });
  try {
    const empty = capture(f.ledger, 'empty', '');
    const before = exportContextEvidenceMetadata(f.ledger);
    const residency = contextEvidenceResidency(f.ledger);
    assert.ok(residency.residentBytes > 0);
    for (const ids of [
      null,
      {},
      [f.receipt.sourceId, 'hce_' + 'f'.repeat(32)],
      [f.receipt.sourceId, f.receipt.sourceId],
      Array(65).fill(empty.sourceId),
    ]) {
      assert.throws(() => evictContextEvidencePayloads(f.ledger, ids), fail);
      assert.deepEqual(contextEvidenceResidency(f.ledger), residency);
    }
    evictContextEvidencePayloads(f.ledger, [f.receipt.sourceId, empty.sourceId]);
    evictContextEvidencePayloads(f.ledger, [f.receipt.sourceId]);
    assert.deepEqual(contextEvidenceResidency(f.ledger), {
      residentBytes: 0,
      residentEntries: 0,
      coldEntries: 1,
    });
    assert.deepEqual(exportContextEvidenceMetadata(f.ledger), before);
    assert.equal(capture(f.ledger, 'first', 'a🙂é\r\n原文').sourceId, f.receipt.sourceId);
    assert.throws(() => capture(f.ledger, 'first', 'changed'), {
      code: 'evidence_source_conflict',
    });
    assert.throws(() => capture(f.ledger, 'oversized-total', 'x'.repeat(32)), {
      code: 'evidence_ledger_quota',
    });
    capture(f.ledger, 'remaining', 'x');
    assert.equal(contextEvidenceResidency(f.ledger).residentBytes, 1);
    f.setTime(before.sources[0].expiresAt);
    assert.deepEqual(contextEvidenceResidency(f.ledger), {
      residentBytes: 0,
      residentEntries: 0,
      coldEntries: 0,
    });
    assert.deepEqual(f.ledger.list().sources, []);
  } finally {
    f.ledger.close();
  }
  assert.throws(() => evictContextEvidencePayloads(f.ledger, []), fail);
  assert.throws(() => contextEvidenceResidency(f.ledger), fail);
  assert.throws(() => evictContextEvidencePayloads({}, []), fail);
  assert.throws(() => contextEvidenceResidency({}), fail);
});

test('metadata restore rejects full payloads, foreign owners, malformed sources and unsafe input', () => {
  const f = fixture();
  try {
    const metadata = exportContextEvidenceMetadata(f.ledger);
    for (const value of [
      undefined,
      null,
      [],
      {},
      exportContextEvidenceLedger(f.ledger),
      { ...metadata, ownerBinding: 'foreign' },
      { ...metadata, sources: [{ ...metadata.sources[0], output: 'private' }] },
      {
        ...metadata,
        sources: [{ ...metadata.sources[0], expiresAt: metadata.sources[0].expiresAt + 1 }],
      },
    ])
      assert.throws(() => restoreContextEvidenceMetadata(f.options, value), fail);
    assert.throws(
      () => restoreContextEvidenceMetadata({ ...f.options, owner: 'other' }, metadata),
      fail
    );
    const empty = restoreContextEvidenceMetadata(f.options, {
      ...metadata,
      sources: [],
      capturedCount: 0,
    });
    assert.deepEqual(contextEvidenceResidency(empty), {
      residentBytes: 0,
      residentEntries: 0,
      coldEntries: 0,
    });
    empty.close();
  } finally {
    f.ledger.close();
  }
});

test('selected payload export validates all IDs before access and preserves exact bytes, counters and expiry', () => {
  const f = fixture();
  const empty = capture(f.ledger, 'empty', '');
  try {
    const before = exportContextEvidenceMetadata(f.ledger);
    assert.deepEqual(exportContextEvidencePayloads(f.ledger, []), []);
    assert.deepEqual(exportContextEvidencePayloads(f.ledger, [empty.sourceId]), [
      { sourceId: empty.sourceId, output: '' },
    ]);
    const result = exportContextEvidencePayloads(f.ledger, [f.receipt.sourceId]);
    assert.deepEqual(result, [{ sourceId: f.receipt.sourceId, output: 'a🙂é\r\n原文' }]);
    result[0].output = 'modified';
    let invoked = 0;
    for (const ids of [
      null,
      {},
      [f.receipt.sourceId, f.receipt.sourceId],
      ['hce_' + 'f'.repeat(32)],
      ['../private'],
      Array(65).fill(empty.sourceId),
      Object.defineProperty([], '0', {
        enumerable: true,
        get() {
          invoked++;
          throw Error('private');
        },
      }),
    ])
      assert.throws(() => exportContextEvidencePayloads(f.ledger, ids), fail);
    assert.equal(invoked, 0);
    assert.deepEqual(exportContextEvidenceMetadata(f.ledger), before);
    assert.equal(
      exportContextEvidencePayloads(f.ledger, [f.receipt.sourceId])[0].output,
      'a🙂é\r\n原文'
    );
    f.setTime(before.sources[0].expiresAt);
    assert.throws(() => exportContextEvidencePayloads(f.ledger, [f.receipt.sourceId]), fail);
  } finally {
    f.ledger.close();
  }
  assert.throws(() => exportContextEvidencePayloads(f.ledger, []), fail);
  assert.throws(() => exportContextEvidencePayloads({}, []), fail);
});

test('metadata exports preserve owner, policy, receipts and progress without raw outputs or private handles', () => {
  const f = fixture();
  try {
    f.ledger.read({ sourceId: f.receipt.sourceId, digest: f.receipt.digest, limitBytes: 1 });
    const full = exportContextEvidenceLedger(f.ledger);
    const metadata = exportContextEvidenceMetadata(f.ledger);
    assert.deepEqual(
      clone(metadata),
      clone({
        ...full,
        kind: 'evidence-ledger-metadata',
        sources: full.sources.map(({ output: _output, ...source }) => source),
      })
    );
    assert.equal(metadata.sources[0].coveredThrough, 1);
    assert.equal(Object.hasOwn(metadata.sources[0], 'locator'), false);
    assert.deepEqual(
      parseEvidenceLedgerMetadata(metadata, full.ownerBinding, full.policy),
      metadata
    );
    assert.throws(() => parseEvidenceLedgerState(metadata, full.ownerBinding, full.policy), fail);
    assert.throws(() => parseEvidenceLedgerMetadata(full, full.ownerBinding, full.policy), fail);
    assert.throws(() => parseEvidenceLedgerMetadata(metadata, 'other', full.policy), fail);
    metadata.sources[0].coveredThrough = 0;
    metadata.policy.maxEntries++;
    assert.equal(exportContextEvidenceMetadata(f.ledger).sources[0].coveredThrough, 1);
    assert.equal(exportContextEvidenceMetadata(f.ledger).policy.maxEntries, full.policy.maxEntries);
  } finally {
    f.ledger.close();
  }
});

test('metadata parsers reject unsafe fields, duplicate identities, inconsistent counters and capacity violations', () => {
  const f = fixture();
  let invoked = 0;
  try {
    const metadata = exportContextEvidenceMetadata(f.ledger);
    const parse = (value) =>
      parseEvidenceLedgerMetadata(value, metadata.ownerBinding, metadata.policy);
    const source = metadata.sources[0];
    for (const value of [
      null,
      [],
      { ...metadata, version: 2 },
      { ...metadata, capturedCount: 0 },
      { ...metadata, readCount: -1 },
      { ...metadata, policy: { ...metadata.policy, maxBytes: 1 } },
      { ...metadata, sources: [source, source] },
      { ...metadata, sources: Array(65).fill(source) },
      { ...metadata, sources: [{ ...source, output: 'private' }] },
      { ...metadata, sources: [{ ...source, locator: 'private' }] },
      { ...metadata, sources: [{ ...source, bytes: metadata.policy.maxOutputBytes + 1 }] },
      { ...metadata, sources: [{ ...source, expiresAt: source.expiresAt + 1 }] },
      { ...metadata, sources: [{ ...source, createdAt: metadata.observedAt + 1 }] },
      { ...metadata, sources: [{ ...source, coveredThrough: source.bytes + 1 }] },
      { ...metadata, sources: [{ ...source, readComplete: true }] },
      { ...metadata, sources: [{ ...source, coveredThrough: source.bytes, readComplete: true }] },
      { ...metadata, extra: 'x'.repeat(256 * 1024) },
      Object.create({ injected: true }),
      Object.defineProperty({}, 'kind', {
        enumerable: true,
        get() {
          invoked++;
          throw Error('private');
        },
      }),
    ])
      assert.throws(() => parse(value), fail);
    const second = { ...source, sourceId: 'hce_' + 'f'.repeat(32) };
    assert.throws(() => parse({ ...metadata, capturedCount: 2, sources: [source, second] }), fail);
    const narrow = { ...metadata.policy, maxBytes: source.bytes - 1 };
    assert.throws(
      () =>
        parseEvidenceLedgerMetadata({ ...metadata, policy: narrow }, metadata.ownerBinding, narrow),
      fail
    );
    assert.equal(invoked, 0);
  } finally {
    f.ledger.close();
  }
});

test('metadata keeps empty evidence and absolute expiry and fails safely after close or invalid owners', () => {
  const f = fixture();
  try {
    const empty = capture(f.ledger, 'empty', '');
    const before = exportContextEvidenceMetadata(f.ledger);
    assert.equal(before.sources.find((source) => source.sourceId === empty.sourceId).bytes, 0);
    f.setTime(before.sources[0].expiresAt);
    const expired = exportContextEvidenceMetadata(f.ledger);
    assert.deepEqual(expired.sources, []);
    assert.equal(expired.capturedCount, before.capturedCount);
    f.ledger.close();
    assert.throws(() => exportContextEvidenceMetadata(f.ledger), fail);
    assert.throws(() => exportContextEvidenceMetadata({}), fail);
  } finally {
    f.ledger.close();
  }
});

test('async stored pages validate ranges before fetching and update only contiguous successful progress', async () => {
  const f = fixture();
  let reads = 0;
  const args = { sourceId: f.receipt.sourceId, digest: f.receipt.digest };
  const fetch = async (source, range) => {
    reads++;
    return {
      ...buildContextArtifactPage('a🙂é\r\n原文', 'utf8', source.digest, {
        offsetBytes: range.offsetBytes,
        limitBytes: range.limitBytes,
      }),
      source,
    };
  };
  try {
    for (const change of [
      { offsetBytes: -1 },
      { limitBytes: 0 },
      { limitBytes: 65537 },
      { extra: 1 },
    ])
      await assert.rejects(
        readContextEvidenceStoredPage(f.ledger, { ...args, ...change }, 16384, fetch)
      );
    for (const max of [-1, 65537, NaN])
      await assert.rejects(readContextEvidenceStoredPage(f.ledger, args, max, fetch));
    assert.equal(reads, 0);
    const missing = await readContextEvidenceStoredPage(
      f.ledger,
      { ...args, digest: 'f'.repeat(64) },
      16384,
      fetch
    );
    assert.equal(missing.error, 'context_evidence_unavailable');
    assert.equal(reads, 0);
    await readContextEvidenceStoredPage(f.ledger, { ...args, offsetBytes: 5 }, 16384, fetch);
    assert.equal(exportContextEvidenceLedger(f.ledger).sources[0].coveredThrough, 0);
    await readContextEvidenceStoredPage(f.ledger, { ...args, limitBytes: 1 }, 16384, fetch);
    assert.equal(exportContextEvidenceLedger(f.ledger).sources[0].coveredThrough, 1);
    await readContextEvidenceStoredPage(f.ledger, { ...args, offsetBytes: 1 }, 16384, fetch);
    assert.equal(f.ledger.inspect().fullyReadSources, 1);
    assert.equal(f.ledger.inspect().readCount, 3);
    const refused = await readContextEvidenceStoredPage(f.ledger, args, 16384, async () => ({
      ok: false,
      error: 'context_artifact_budget_exceeded',
    }));
    assert.equal(refused.ok, false);
    assert.equal(f.ledger.inspect().readCount, 3);
    await assert.rejects(
      readContextEvidenceStoredPage(f.ledger, args, 16384, async (source) => ({
        ...buildContextArtifactPage('tampered', 'utf8', source.digest),
        source,
      }))
    );
    assert.equal(f.ledger.inspect().readCount, 3);
  } finally {
    f.ledger.close();
  }
});

test('async stored pages cannot revive closed or expired ledger sources after payload I/O', async () => {
  for (const action of ['close', 'expire']) {
    const f = fixture();
    try {
      const pending = readContextEvidenceStoredPage(
        f.ledger,
        { sourceId: f.receipt.sourceId, digest: f.receipt.digest },
        16384,
        async (source) => {
          const page = {
            ...buildContextArtifactPage('a🙂é\r\n原文', 'utf8', source.digest),
            source,
          };
          if (action === 'close') f.ledger.close();
          else f.setTime(source.expiresAt);
          return page;
        }
      );
      if (action === 'close') await assert.rejects(pending, { code: 'evidence_ledger_closed' });
      else {
        assert.equal((await pending).error, 'context_evidence_unavailable');
        assert.equal(f.ledger.inspect().readCount, 0);
      }
    } finally {
      f.ledger.close();
    }
  }
});

test('ledger state roundtrip preserves source receipts, exact Unicode, counters and contiguous progress', () => {
  const f = fixture();
  let restored;
  try {
    const first = f.ledger.read({
      sourceId: f.receipt.sourceId,
      digest: f.receipt.digest,
      limitBytes: 1,
    });
    assert.equal(first.ok, true);
    assert.equal(first.page.endOffsetBytes, 1);
    const snapshot = exportContextEvidenceLedger(f.ledger);
    assert.equal(snapshot.sources[0].coveredThrough, 1);
    assert.equal(Object.hasOwn(snapshot.sources[0], 'locator'), false);
    f.setTime(200);
    restored = restoreContextEvidenceLedger(f.options, clone(snapshot));
    assert.deepEqual(restored.list(), f.ledger.list());
    assert.deepEqual(restored.inspect(), f.ledger.inspect());
    const remaining = restored.read({
      sourceId: f.receipt.sourceId,
      digest: f.receipt.digest,
      offsetBytes: 1,
    });
    assert.equal(remaining.ok, true);
    assert.equal(remaining.page.text, '🙂é\r\n原文');
    assert.equal(restored.inspect().fullyReadSources, 1);
    assert.deepEqual(capture(restored, 'first', 'a🙂é\r\n原文'), f.receipt);
    assert.throws(() => capture(restored, 'first', 'different'), {
      code: 'evidence_source_conflict',
    });
    snapshot.sources[0].output = 'mutated';
    assert.equal(
      restored.read({ sourceId: f.receipt.sourceId, digest: f.receipt.digest }).page.text,
      'a🙂é\r\n原文'
    );
  } finally {
    restored?.close();
    f.ledger.close();
  }
});

test('empty ledger snapshots and fully expired snapshots restore without inventing retained sources', () => {
  let time = 100;
  const options = { owner: 'owner', threadId: 'thread', ttlMs: 1000, now: () => time };
  const ledger = createContextEvidenceLedger(options);
  let restored;
  try {
    const state = exportContextEvidenceLedger(ledger);
    restored = restoreContextEvidenceLedger(options, state);
    assert.deepEqual(restored.list().sources, []);
    assert.equal(restored.inspect().capturedCount, 0);
    assert.throws(() => restoreContextEvidenceLedger(options, { ...state, readCount: 1 }), fail);
    restored.close();
    const receipt = capture(ledger, 'source', 'kept until expiry');
    const captured = exportContextEvidenceLedger(ledger);
    time = 1100;
    restored = restoreContextEvidenceLedger(options, captured);
    assert.equal(restored.read({ sourceId: receipt.sourceId, digest: receipt.digest }).ok, false);
    assert.equal(exportContextEvidenceLedger(restored).sources.length, 0);
    assert.equal(restored.inspect().capturedCount, 1);
  } finally {
    restored?.close();
    ledger.close();
  }
});

test('trusted payload materialization preserves large originals without charging or renewing model reads', () => {
  let time = 100;
  const options = { owner: 'owner', threadId: 'thread', ttlMs: 1000, now: () => time };
  const ledger = createContextEvidenceLedger(options);
  let restored;
  try {
    const output = '原文🙂\r\n'.repeat(4096);
    const receipt = capture(ledger, 'large', output);
    const empty = capture(ledger, 'empty', '');
    for (const at of [100, 200, 600, 1099]) {
      time = at;
      const state = exportContextEvidenceLedger(ledger);
      assert.equal(state.sources[0].output, output);
      assert.equal(state.sources[1].output, '');
      assert.equal(state.readCount, 0);
      assert.equal(state.sources[0].coveredThrough, 0);
      assert.equal(state.sources[0].readComplete, false);
      assert.equal(state.sources[1].readComplete, false);
      assert.equal(state.sources[0].expiresAt, 1100);
      assert.equal(state.sources[1].expiresAt, 1100);
      assert.deepEqual(ledger.list().sources, [receipt, empty]);
      if (at === 600) {
        restored = restoreContextEvidenceLedger(options, state);
        state.sources[0].output = 'caller mutation';
        assert.equal(exportContextEvidenceLedger(restored).sources[0].output, output);
        assert.equal(restored.inspect().readCount, 0);
      }
    }
    time = 1100;
    assert.equal(exportContextEvidenceLedger(ledger).sources.length, 0);
    assert.equal(exportContextEvidenceLedger(restored).sources.length, 0);
    assert.equal(ledger.read({ sourceId: receipt.sourceId, digest: receipt.digest }).ok, false);
  } finally {
    restored?.close();
    ledger.close();
  }
});

test('payload export failures are sanitized and never fall back to a retained raw output copy', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'helpers/evidence-ledger-payload-fault.cjs')],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'payload_faults_rejected_without_raw_fallback\n');
  assert.equal(result.stderr, '');
});

test('restore preserves absolute source expiry, prunes expired entries and rejects clock rollback', () => {
  const f = fixture({ ttlMs: 1000 });
  let restored;
  try {
    f.setTime(400);
    const second = capture(f.ledger, 'second', 'later');
    const snapshot = exportContextEvidenceLedger(f.ledger);
    f.setTime(1100);
    restored = restoreContextEvidenceLedger(f.options, snapshot);
    assert.deepEqual(restored.list().sources, [second]);
    assert.equal(
      restored.read({ sourceId: f.receipt.sourceId, digest: f.receipt.digest }).ok,
      false
    );
    f.setTime(1400);
    assert.equal(restored.list().sources.length, 0);
    assert.equal(restored.inspect().capturedCount, 2);
    restored.close();
    f.setTime(399);
    assert.throws(() => restoreContextEvidenceLedger(f.options, snapshot), fail);
    f.setTime(NaN);
    assert.throws(() => restoreContextEvidenceLedger(f.options, snapshot), fail);
  } finally {
    restored?.close();
    f.ledger.close();
  }
});

test('empty, fully read and seek-only sources retain their exact recovery status', () => {
  const f = fixture();
  let restored;
  try {
    const empty = capture(f.ledger, 'empty', '');
    f.ledger.read({ sourceId: f.receipt.sourceId, digest: f.receipt.digest, offsetBytes: 5 });
    let state = exportContextEvidenceLedger(f.ledger);
    assert.equal(state.sources[0].coveredThrough, 0);
    assert.equal(state.sources[0].readComplete, false);
    assert.equal(state.sources[1].readComplete, false);
    restored = restoreContextEvidenceLedger(f.options, state);
    assert.equal(restored.read({ sourceId: empty.sourceId, digest: empty.digest }).page.text, '');
    state = exportContextEvidenceLedger(restored);
    assert.equal(state.sources[1].readComplete, true);
    restored.close();
    restored = restoreContextEvidenceLedger(f.options, state);
    assert.equal(restored.inspect().fullyReadSources, 1);
  } finally {
    restored?.close();
    f.ledger.close();
  }
});

test('ledger restore enforces current owner, thread and policy without importing snapshot privileges', () => {
  const f = fixture();
  try {
    const state = exportContextEvidenceLedger(f.ledger);
    for (const options of [
      { ...f.options, owner: 'another-owner' },
      { ...f.options, threadId: 'another-thread' },
      { ...f.options, ttlMs: 1000 },
      { ...f.options, maxEntries: 63 },
      { ...f.options, maxBytes: 8 * 1024 * 1024 },
      { ...f.options, maxOutputBytes: 2048 },
    ])
      assert.throws(() => restoreContextEvidenceLedger(options, state), fail);
    assert.throws(() => exportContextEvidenceLedger({}), fail);
    assert.throws(() => restoreContextEvidenceLedger(f.options, undefined), fail);
    f.ledger.close();
    assert.throws(() => exportContextEvidenceLedger(f.ledger), fail);
    const fresh = createContextEvidenceLedger(f.options);
    try {
      assert.equal(
        fresh.read({ sourceId: f.receipt.sourceId, digest: f.receipt.digest }).ok,
        false
      );
    } finally {
      fresh.close();
    }
  } finally {
    f.ledger.close();
  }
});

test('malformed, tampered, duplicate and extreme persisted source data fail atomically', () => {
  const f = fixture();
  try {
    const original = clone(exportContextEvidenceLedger(f.ledger));
    const mutations = [
      (s) => {
        s.version = 2;
      },
      (s) => {
        s.kind = 'foreign';
      },
      (s) => {
        s.extra = true;
      },
      (s) => {
        s.capturedCount = -1;
      },
      (s) => {
        s.capturedCount = 0;
      },
      (s) => {
        s.readCount = 0.1;
      },
      (s) => {
        s.observedAt = Number.MAX_SAFE_INTEGER;
      },
      (s) => {
        s.sources = {};
      },
      (s) => {
        s.sources[0].sourceId = '../foreign';
      },
      (s) => {
        s.sources[0].callId = 'bad id';
      },
      (s) => {
        s.sources[0].toolName = '';
      },
      (s) => {
        s.sources[0].argumentsDigest = 'g'.repeat(64);
      },
      (s) => {
        s.sources[0].digest = '0'.repeat(64);
      },
      (s) => {
        s.sources[0].bytes++;
      },
      (s) => {
        s.sources[0].output += 'tampered';
      },
      (s) => {
        s.sources[0].createdAt++;
      },
      (s) => {
        s.sources[0].expiresAt++;
      },
      (s) => {
        s.sources[0].expiresAt = s.observedAt;
      },
      (s) => {
        s.sources[0].coveredThrough = 2;
      },
      (s) => {
        s.sources[0].coveredThrough = -1;
      },
      (s) => {
        s.sources[0].coveredThrough = s.sources[0].bytes + 1;
      },
      (s) => {
        s.sources[0].coveredThrough = s.sources[0].bytes;
      },
      (s) => {
        s.sources[0].readComplete = true;
      },
      (s) => {
        s.sources[0].locator = 'forged';
      },
      (s) => {
        s.sources[0].coveredThrough = 1;
      },
      (s) => {
        s.sources.push(clone(s.sources[0]));
        s.capturedCount++;
      },
      (s) => {
        s.sources[0].output = '\ud800';
        s.sources[0].bytes = 3;
        s.sources[0].digest = createHash('sha256').update('\ud800').digest('hex');
      },
    ];
    for (const mutate of mutations) {
      const state = clone(original);
      mutate(state);
      assert.throws(() => restoreContextEvidenceLedger(f.options, state), fail);
      assert.equal(
        f.ledger.read({ sourceId: f.receipt.sourceId, digest: f.receipt.digest }).ok,
        true
      );
    }
    for (const state of [
      null,
      [],
      {},
      { ...original, sources: new Array(65).fill(original.sources[0]) },
    ])
      assert.throws(() => restoreContextEvidenceLedger(f.options, state), fail);
  } finally {
    f.ledger.close();
  }
});

test('restored entries retain storage quotas and reject total-byte, ordering and identity conflicts', () => {
  const f = fixture({ maxEntries: 2, maxOutputBytes: 16, maxBytes: 16 });
  let restored;
  try {
    const state = exportContextEvidenceLedger(f.ledger);
    restored = restoreContextEvidenceLedger(f.options, state);
    assert.throws(() => capture(restored, 'too-large-total', 'x'.repeat(16)), {
      code: 'evidence_ledger_quota',
    });
    capture(restored, 'empty', '');
    assert.throws(() => capture(restored, 'third', ''), { code: 'evidence_ledger_quota' });
    const snapshot = clone(exportContextEvidenceLedger(restored));
    snapshot.sources[1].sourceId = 'hce_' + '1'.repeat(32);
    snapshot.sources[1].callId = snapshot.sources[0].callId;
    assert.throws(() => restoreContextEvidenceLedger(f.options, snapshot), fail);
    snapshot.sources[1] = {
      ...clone(snapshot.sources[0]),
      sourceId: 'hce_' + '2'.repeat(32),
      callId: 'other',
    };
    assert.throws(() => restoreContextEvidenceLedger(f.options, snapshot), fail);
    const g = fixture({ ttlMs: 1000 });
    try {
      g.setTime(200);
      capture(g.ledger, 'second', 'b');
      const unordered = clone(exportContextEvidenceLedger(g.ledger));
      unordered.sources.reverse();
      assert.throws(() => restoreContextEvidenceLedger(g.options, unordered), fail);
    } finally {
      g.ledger.close();
    }
  } finally {
    restored?.close();
    f.ledger.close();
  }
});

test('restore rejects getters, toJSON, prototypes, cycles and executable options without running them', () => {
  const f = fixture();
  let invoked = 0;
  try {
    const state = clone(exportContextEvidenceLedger(f.ledger));
    const accessor = Object.defineProperty(clone(state), 'sources', {
      enumerable: true,
      get() {
        invoked++;
        return [];
      },
    });
    const sourceAccessor = clone(state);
    Object.defineProperty(sourceAccessor.sources[0], 'output', {
      enumerable: true,
      get() {
        invoked++;
        return '';
      },
    });
    const cycle = clone(state);
    cycle.sources.push(cycle);
    for (const input of [
      accessor,
      sourceAccessor,
      cycle,
      Object.assign(Object.create({}), state),
      {
        ...state,
        toJSON() {
          invoked++;
          return state;
        },
      },
    ])
      assert.throws(() => restoreContextEvidenceLedger(f.options, input), fail);
    assert.throws(
      () =>
        restoreContextEvidenceLedger(
          {
            ...f.options,
            get owner() {
              invoked++;
              return 'synthetic-owner';
            },
          },
          state
        ),
      fail
    );
    assert.equal(invoked, 0);
  } finally {
    f.ledger.close();
  }
});

test(
  'actual Windows encrypted worker reopen restores a new ledger with original receipts and exact content',
  { timeout: 120000 },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-ledger-state-test-'));
    const options = { owner: 'synthetic-owner', threadId: 'synthetic-thread' };
    const ledger = createContextEvidenceLedger(options);
    const receipt = capture(ledger, 'source', '实际重开🙂\r\n');
    const scope = 'c'.repeat(64);
    let storage, restored;
    try {
      if (process.platform !== 'win32') {
        await assert.rejects(
          openContextRecoveryStorage({ directory: path.join(directory, 'context') }),
          { code: 'context_recovery_storage_unavailable' }
        );
        return;
      }
      storage = await openContextRecoveryStorage({ directory: path.join(directory, 'context') });
      await storage.execute({
        operation: 'save',
        scope,
        expectedRevision: 0,
        expiresAt: Date.now() + 120000,
        state: { ledger: exportContextEvidenceLedger(ledger) },
      });
      ledger.close();
      await storage.close();
      storage = undefined;
      storage = await openContextRecoveryStorage({ directory: path.join(directory, 'context') });
      const saved = await storage.execute({ operation: 'load', scope });
      restored = restoreContextEvidenceLedger(options, saved.state.ledger);
      assert.deepEqual(restored.list().sources, [receipt]);
      const read = restored.read({ sourceId: receipt.sourceId, digest: receipt.digest });
      assert.equal(read.ok, true);
      assert.equal(read.page.text, '实际重开🙂\r\n');
      assert.equal(exportContextEvidenceLedger(restored).sources[0].readComplete, true);
    } finally {
      ledger.close();
      restored?.close();
      try {
        await storage?.close();
      } finally {
        const resolved = path.resolve(directory);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('hpm-ledger-state-test-'));
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    }
  }
);
