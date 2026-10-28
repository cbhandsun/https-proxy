'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createContextRecoverySessions,
  exportContextRecoveryRoot,
  restoreContextRecoverySessions,
} = require('../lib/proxy/context-recovery-sessions');
const {
  createContextEvidenceLedger,
  captureObservedContextEvidence,
  exportContextEvidenceLedger,
  exportContextEvidenceMetadata,
  contextEvidenceResidency,
} = require('../lib/proxy/context-evidence-ledger');
const {
  restoreRecoveryRootStates,
  restoreRecoveryRootMetadataStates,
  exportRecoveryRootMetadata,
  exportRecoveryRootState,
} = require('../lib/proxy/context-recovery-root-state');
const { createRootCheckpoint } = require('../lib/proxy/context-recovery-root-checkpoint');
const {
  referenceStateFromCheckpoint,
  hydrateReferenceState,
} = require('../lib/proxy/context-recovery-reference-state');
const {
  createReferenceWrite,
  materializeReferenceWrite,
} = require('../lib/proxy/context-recovery-reference-write');
const {
  projectPublishedRecoveryReference,
} = require('../lib/proxy/context-recovery-restore-projection');
const { openContextRecoveryStorage } = require('../lib/proxy/context-recovery-storage');
const {
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../lib/proxy/context-evidence-tools');

const copy = (value) => JSON.parse(JSON.stringify(value));
const {
  normalizeRecoveryStateData,
  normalizeRecoveryCheckpointData,
} = require('../lib/proxy/context-recovery-state-data');
const { legacyRecoveryRoot } = require('./helpers/recovery-retention-fixture.cjs');
const {
  createRecoverySourcePolicyValidator,
} = require('../lib/proxy/context-recovery-source-policy');
const { parseCompletedEvidenceSource } = require('../lib/proxy/context-evidence-source');
const fail = { code: 'invalid_context_recovery_root_state' };
const {
  parseRecoveryPendingResults,
  pendingResultsBytes,
  MAX_PENDING_RESULTS_BYTES,
  assertRebuiltPendingResults,
} = require('../lib/proxy/context-recovery-pending-results');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const user = (content) => ({ role: 'user', content });
const answer = (content) => ({ role: 'assistant', content });
const args = { query: 'private_original_arguments_marker' };
const tool = {
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id: 'external',
      type: 'function',
      function: { name: 'lookup', arguments: JSON.stringify(args) },
    },
  ],
};
const observed = {
  callId: 'external',
  toolName: 'lookup',
  arguments: args,
  output: '',
  completed: true,
};

test('restore source policy reuses only successful matching scalar checks within one operation', (t) => {
  // Observe the genuine descriptor parser, independent of JSON allocation.
  const descriptor = Object.getOwnPropertyDescriptor;
  let checks = 0;
  t.mock.method(Object, 'getOwnPropertyDescriptor', (value, key) => {
    if (key === 'output' && descriptor(value, 'completed')?.value === true) checks++;
    return descriptor(value, key);
  });
  const validate = createRecoverySourcePolicyValidator();
  const output = 'synthetic repeated original';
  assert.equal(validate('a', 'lookup', output), true);
  assert.equal(validate('b', 'lookup', output), true);
  assert.equal(checks, 1);
  assert.equal(validate('bb', 'lookup', output), true);
  assert.equal(validate('a', 'other', output), true);
  assert.equal(createRecoverySourcePolicyValidator()('a', 'lookup', output), true);
  assert.equal(checks, 4);
  for (let index = 0; index < 2; index++)
    assert.equal(validate('a', 'lookup', 'Bearer syntheticCredential12345'), false);
  assert.equal(checks, 6);
});

test('restore source policy retains whole-source encoding limits when call ID length changes', () => {
  const maximum = 1024 * 1024 + 16384;
  const source = { callId: 'a', toolName: 'lookup', arguments: {}, completed: true, output: '' };
  const remaining = maximum - Buffer.byteLength(JSON.stringify(source));
  const output = '\u0000'.repeat(Math.floor(remaining / 6)) + 'x'.repeat(remaining % 6);
  assert.equal(Buffer.byteLength(JSON.stringify({ ...source, output })), maximum);
  const validate = createRecoverySourcePolicyValidator();
  assert.equal(validate('a', 'lookup', output), true);
  assert.equal(validate('b', 'lookup', output), true);
  assert.equal(validate('aa', 'lookup', output), false);
  assert.equal(validate('a', 'lookup', output + 'x'), false);
  const escapedId = createRecoverySourcePolicyValidator();
  assert.equal(escapedId('aa', 'lookup', output.slice(0, -1)), true);
  assert.equal(escapedId('a\n', 'lookup', output.slice(0, -1)), false);
});

test('restore source policy rejects unsafe scalars and agrees with the full source parser', () => {
  const validate = createRecoverySourcePolicyValidator();
  let invoked = 0;
  const hook = {
    toString() {
      invoked++;
      return 'a';
    },
    toJSON() {
      invoked++;
      return '';
    },
  };
  for (const args of [
    [hook, 'lookup', ''],
    ['a', hook, ''],
    ['a', 'lookup', hook],
  ])
    assert.equal(validate(...args), false);
  assert.equal(invoked, 0);
  for (const [callId, toolName, output] of [
    ['a', 'lookup', ''],
    ['a'.repeat(256), 't'.repeat(128), 'é🙂\n'],
    ['', 'lookup', ''],
    ['a'.repeat(257), 'lookup', ''],
    ['a', 't'.repeat(129), ''],
    ['a\n', 'lookup', ''],
    ['a', 'hpm_read_retained_evidence', ''],
    ['a', 'lookup', '\ud800'],
    ['a', 'lookup', 'x'.repeat(1024 * 1024 + 1)],
    ['a', 'lookup', 'Script running with cell ID synthetic'],
    ['a', 'lookup', 'api_key: syntheticCredential'],
  ])
    assert.equal(
      validate(callId, toolName, output),
      parseCompletedEvidenceSource({ callId, toolName, arguments: {}, completed: true, output }).ok
    );
});

test('restore source policy bounds cached successes by entry count and retained bytes', (t) => {
  // A cache miss still validates the actual source's own output descriptor.
  const descriptor = Object.getOwnPropertyDescriptor;
  const checks = new Map();
  t.mock.method(Object, 'getOwnPropertyDescriptor', (value, key) => {
    if (key === 'output' && descriptor(value, 'completed')?.value === true) {
      const output = descriptor(value, key).value;
      checks.set(output, (checks.get(output) ?? 0) + 1);
    }
    return descriptor(value, key);
  });
  const countBounded = createRecoverySourcePolicyValidator();
  for (let index = 0; index < 129; index++)
    assert.equal(countBounded('a', 'lookup', 'item-' + index), true);
  assert.equal(countBounded('b', 'lookup', 'item-0'), true);
  assert.equal(countBounded('b', 'lookup', 'item-128'), true);
  assert.equal(checks.get('item-0'), 1);
  assert.equal(checks.get('item-128'), 2);
  const byteBounded = createRecoverySourcePolicyValidator();
  const outputs = Array.from({ length: 4 }, (_, index) => String(index).repeat(1024 * 1024));
  for (const output of outputs) assert.equal(byteBounded('a', 'lookup', output), true);
  assert.equal(byteBounded('b', 'lookup', outputs[0]), true);
  assert.equal(byteBounded('b', 'lookup', outputs[3]), true);
  assert.equal(checks.get(outputs[0]), 1);
  assert.equal(checks.get(outputs[3]), 2);
});

test('recovery state size memo reserves work for repeated large originals after short metadata', () => {
  const output = 'synthetic state text 中文🙂\r\n'.repeat(256);
  const input = {
    metadata: Array.from({ length: 256 }, (_, index) =>
      createHash('sha256').update(String(index)).digest('hex')
    ),
    sources: Array.from({ length: 256 }, () => ({ output })),
  };
  const encoded = JSON.stringify(input);
  const bytes = Buffer.byteLength(encoded);
  const byteLength = Buffer.byteLength;
  let scans = 0;
  try {
    Buffer.byteLength = function (value, ...args) {
      if (value === output) scans++;
      return Reflect.apply(byteLength, this, [value, ...args]);
    };
    assert.equal(JSON.stringify(normalizeRecoveryStateData(input, bytes)), encoded);
    assert.ok(scans > 0 && scans < 8, 'short metadata must not starve large value reuse');
    const prior = scans;
    assert.throws(() => normalizeRecoveryStateData(input, bytes - 1));
    assert.ok(scans > prior && scans - prior < 8, 'reuse must remain local to one parse');
  } finally {
    Buffer.byteLength = byteLength;
  }
});

test('recovery state size memo still bounds retained large values by bytes', () => {
  const outputs = Array.from({ length: 40 }, (_, index) =>
    String(index).padStart(6, '0').repeat(21846)
  );
  const late = outputs.at(-1);
  const input = {
    metadata: Array.from({ length: 256 }, (_, index) => 'metadata-' + index),
    outputs: [...outputs, late, late, late, late],
  };
  const encoded = JSON.stringify(input);
  const bytes = Buffer.byteLength(encoded);
  const byteLength = Buffer.byteLength;
  let scans = 0;
  try {
    Buffer.byteLength = function (value, ...args) {
      if (value === late) scans++;
      return Reflect.apply(byteLength, this, [value, ...args]);
    };
    assert.equal(JSON.stringify(normalizeRecoveryStateData(input, bytes)), encoded);
    assert.ok(scans >= 4, 'large values beyond the byte allowance must not accumulate');
  } finally {
    Buffer.byteLength = byteLength;
  }
});

test('recovery state arrays never invoke inherited numeric setters during cloning', () => {
  const input = Array.from({ length: 1025 }, (_, index) => ({ value: index }));
  assert.equal(Object.hasOwn(Array.prototype, '1024'), false);
  let invoked = 0;
  let result;
  try {
    Object.defineProperty(Array.prototype, '1024', {
      configurable: true,
      set() {
        invoked++;
      },
    });
    result = normalizeRecoveryStateData(input);
  } finally {
    delete Array.prototype[1024];
  }
  assert.equal(invoked, 0);
  assert.equal(result.length, 1025);
  assert.equal(result[1024].value, 1024);
  assert.equal(Object.getPrototypeOf(result[1024]), null);
  assert.deepEqual(Object.getOwnPropertyDescriptor(result, '1024'), {
    value: result[1024],
    enumerable: true,
    configurable: true,
    writable: true,
  });
  result[1024].value = 'changed';
  assert.equal(input[1024].value, 1024);
});

test('recovery state array cloning never selects inherited iterators and keeps own slots and byte limits', () => {
  const input = [[], [null, false, 0, 'é🙂\ud800'], { __proto__: null, value: 'original' }];
  const bytes = Buffer.byteLength(JSON.stringify(input));
  assert.equal(Object.hasOwn(Object.prototype, Symbol.iterator), false);
  let invoked = 0;
  let result;
  try {
    Object.defineProperty(Object.prototype, Symbol.iterator, {
      configurable: true,
      get() {
        invoked++;
        throw new Error('unexpected inherited iterator');
      },
    });
    result = normalizeRecoveryStateData(input, bytes);
  } finally {
    delete Object.prototype[Symbol.iterator];
  }
  assert.equal(invoked, 0);
  assert.deepEqual(copy(result), copy(input));
  assert.equal(Object.getPrototypeOf(result[2]), null);
  assert.throws(() => normalizeRecoveryStateData(input, bytes - 1));
  result[2].value = 'changed';
  assert.equal(input[2].value, 'original');
});

test('recovery state array cloning rejects disguised holes and own iterator hooks without invoking them', () => {
  let invoked = 0;
  const get = () => {
    invoked++;
    throw new Error('unexpected input hook');
  };
  const holeWithExtraKey = Object.assign(Array(1), { extra: null });
  const hiddenSlot = Object.defineProperty([], '0', { value: null, enumerable: false });
  const iterator = Object.defineProperty([], Symbol.iterator, { get });
  const accessor = Object.defineProperty([], '0', { enumerable: true, get });
  for (const value of [holeWithExtraKey, hiddenSlot, iterator, accessor])
    assert.throws(() => normalizeRecoveryStateData(value));
  assert.equal(invoked, 0);
  assert.deepEqual(normalizeRecoveryStateData([], 2), []);
  assert.throws(() => normalizeRecoveryStateData([], 1));
});

test('large recovery state normalization preserves JSON byte bounds, values and isolated clones', () => {
  const texts = [
    '',
    '"\\\b\t\n\f\r\u0000\u001f',
    'é🙂\u2028\u2029',
    '\u007f\u0085\u009f',
    '\ud800',
    '\udfff',
    '\ud800x\udfff',
  ];
  for (const text of texts) {
    const input = {
      10: text,
      2: text,
      nested: [null, true, false, -0, 1e30, { __proto__: null, x: text }],
    };
    const size = Buffer.byteLength(JSON.stringify(input));
    assert.deepEqual(copy(normalizeRecoveryStateData(input, size)), copy(input));
    assert.throws(() => normalizeRecoveryStateData(input, size - 1));
  }
  const input = { entries: Array(10).fill({ text: 'x'.repeat(2 * 1024 * 1024) }) };
  const result = normalizeRecoveryStateData(input);
  result.entries[0].text = 'independent';
  assert.equal(input.entries[0].text.length, 2 * 1024 * 1024);
  assert.equal(result.entries[1].text.length, 2 * 1024 * 1024);
  assert.equal(normalizeRecoveryStateData(null, 4), null);
});

test('state byte accounting skips scalar traversal for C1 text and sparse JSON escapes', (t) => {
  const charCodeAt = String.prototype.charCodeAt;
  let scalarReads = 0;
  t.mock.method(String.prototype, 'charCodeAt', function (index) {
    scalarReads++;
    return Reflect.apply(charCodeAt, this, [index]);
  });
  for (const text of [
    '\u0080\u009f'.repeat(100000),
    '精确原文🙂' + 'x'.repeat(600000),
    'x'.repeat(600000) + '\n"\\\ud800',
  ]) {
    const input = { nested: [text, text] };
    const encoded = JSON.stringify(input);
    const bytes = Buffer.byteLength(encoded);
    scalarReads = 0;
    assert.equal(JSON.stringify(normalizeRecoveryStateData(input, bytes)), encoded);
    assert.ok(scalarReads < 128, 'sparse text must not require a scalar pass over every code unit');
    assert.throws(() => normalizeRecoveryStateData(input, bytes - 1));
  }
});

test('state byte accounting keeps sparse groups and dense fallback boundaries exact', () => {
  const sparse = ('x'.repeat(2048) + '"').repeat(65);
  for (const text of [
    '"'.repeat(31) + '🙂\ud800\udfff\ud800x\udfff',
    sparse,
    sparse + '\n"\\'.repeat(100) + '🙂\ud800x\udfff',
    '\u0000'.repeat(33) + '\b\t\n\f\r\u001f🙂\ud800',
  ]) {
    const input = { [text]: [text, text] };
    const encoded = JSON.stringify(input);
    const bytes = Buffer.byteLength(encoded);
    assert.equal(JSON.stringify(normalizeRecoveryStateData(input, bytes)), encoded);
    assert.throws(() => normalizeRecoveryStateData(input, bytes - 1));
  }
});

test('state byte admission matches JSON for every UTF-16 unit and supplementary code point', () => {
  function verify(text) {
    const input = { [text]: [text, text] };
    const encoded = JSON.stringify(input);
    const bytes = Buffer.byteLength(encoded);
    assert.equal(JSON.stringify(normalizeRecoveryStateData(input, bytes)), encoded);
    assert.throws(() => normalizeRecoveryStateData(input, bytes - 1));
  }
  for (let start = 0; start < 0x10000; start += 256)
    verify(
      Array.from({ length: 256 }, (_, offset) => String.fromCharCode(start + offset)).join('|')
    );
  for (let start = 0x10000; start <= 0x10ffff; start += 2048)
    verify(
      Array.from({ length: 2048 }, (_, offset) => String.fromCodePoint(start + offset)).join('')
    );
});

test('state and history byte scans keep the older runtime UTF-8 fallback exact', (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(String.prototype, 'isWellFormed');
  if (descriptor) {
    Object.defineProperty(String.prototype, 'isWellFormed', { ...descriptor, value: undefined });
    t.after(() => Object.defineProperty(String.prototype, 'isWellFormed', descriptor));
  }
  const {
    normalizeRecoveryHistoryRequest,
    recoveryHistoryRequestBytes,
  } = require('../lib/proxy/context-recovery-history-request');
  for (const text of ['🙂\u0080\u009f', '\ud800', '\udfff', 'é\n"\\', '']) {
    const input = { [text]: text };
    const encoded = JSON.stringify(input);
    const bytes = Buffer.byteLength(encoded);
    assert.equal(JSON.stringify(normalizeRecoveryStateData(input, bytes)), encoded);
    assert.throws(() => normalizeRecoveryStateData(input, bytes - 1));
    const request = { history: [{ role: 'user', content: text }] };
    const normalized = normalizeRecoveryHistoryRequest(request, 3);
    assert.equal(
      recoveryHistoryRequestBytes(normalized),
      Buffer.byteLength(JSON.stringify(request))
    );
  }
});

test('checkpoint bytes select only an own version 9 root and reject hooks without calling them', () => {
  const output = 'x'.repeat(13 * 1024 * 1024);
  const large = { root: { version: 9, output }, stagedSources: [] };
  assert.equal(normalizeRecoveryCheckpointData(large).root.output, output);
  assert.equal(
    normalizeRecoveryCheckpointData({ ...large, root: { version: 10, output } }).root.output,
    output
  );
  for (const version of [1, 7, 8, 11, '9', null])
    assert.throws(() => normalizeRecoveryCheckpointData({ ...large, root: { version, output } }));
  let invoked = 0;
  const get = () => {
    invoked++;
    return 9;
  };
  for (const input of [
    Object.defineProperty({}, 'root', { enumerable: true, get }),
    { root: Object.defineProperty({}, 'version', { enumerable: true, get }) },
    { root: { version: 9, output, toJSON: get } },
    { root: Object.create({ version: 9 }) },
    { root: { version: 9 }, stagedSources: Array(2) },
  ])
    assert.throws(() => normalizeRecoveryCheckpointData(input));
  assert.equal(invoked, 0);
  assert.equal(normalizeRecoveryCheckpointData(null), null);
  assert.deepEqual(copy(normalizeRecoveryCheckpointData({})), {});
});

test('large recovery state normalization rejects hooks, invalid JSON, cycles and global resource overflow', () => {
  let invoked = 0;
  const get = () => {
    invoked++;
    throw Error('synthetic-private-value');
  };
  const cycle = {};
  cycle.cycle = cycle;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get });
  const arrayGetter = Object.defineProperty([], '0', { enumerable: true, get });
  let deep = null;
  for (let index = 0; index < 64; index++) deep = [deep];
  assert.ok(normalizeRecoveryStateData(deep));
  for (const input of [
    undefined,
    NaN,
    Infinity,
    1n,
    get,
    cycle,
    getter,
    arrayGetter,
    Array(1),
    new Date(),
    Object.create({}),
    Object.assign([], { extra: 1 }),
    { toJSON: get },
    Object.defineProperty({}, 'x', { value: 1 }),
    { [Symbol('x')]: 1 },
    [deep],
    Array.from({ length: 512 }, () => Array(128).fill(0)),
  ])
    assert.throws(() => normalizeRecoveryStateData(input));
  for (const maximum of [0, -1, NaN, Infinity, 1.5, 112 * 1024 * 1024 + 4097])
    assert.throws(() => normalizeRecoveryStateData({}, maximum));
  assert.equal(invoked, 0);
});

const input = (history = [user('public_history_marker')], extra = {}) => ({
  principal: 'owner',
  protocol: 'chat',
  target: 'target',
  history,
  ...extra,
});
const continuation = (text) =>
  input([...input().history, tool, { role: 'tool', tool_call_id: 'external', content: text }]);
const list = (session) => JSON.parse(session.reply(LIST, {}).text);
const completion = (calls = [], content = 'done') => ({
  choices: [
    {
      finish_reason: calls.length ? 'tool_calls' : 'stop',
      message: {
        role: 'assistant',
        content,
        ...(calls.length
          ? {
              tool_calls: calls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              })),
            }
          : {}),
      },
    },
  ],
});
function fixture({ privateHistory = false, now } = {}) {
  let time = 100;
  const clock = now ?? (() => time);
  const sessions = createContextRecoverySessions({ now: clock });
  sessions.configure(true);
  const first = sessions.begin(input());
  assert.equal(first.complete([tool], [observed], 'root-response').ok, true);
  const text = '原文🙂é\r\nexact',
    request = continuation(text);
  const child = sessions.begin(request, [{ callId: 'external', output: text }]);
  const receipt = list(child).sources[0];
  let output = [answer('done')];
  if (privateHistory) {
    const run = child.recovery({ model: 'synthetic', messages: request.history });
    assert.equal(run.ok, true);
    assert.equal(
      run.accept(
        completion([
          {
            id: 'hidden-read',
            name: READ,
            args: { sourceId: receipt.sourceId, digest: receipt.digest },
          },
        ])
      ).mode,
      'continue'
    );
    const released = run.accept(completion());
    assert.equal(released.mode, 'release');
    output = released.output;
  }
  assert.equal(child.complete(output, [], 'child-response').ok, true);
  return {
    sessions,
    first,
    child,
    receipt,
    text,
    request,
    output,
    clock,
    state: () => exportContextRecoveryRoot(sessions, first.snapshotId),
    setTime(value) {
      time = value;
    },
  };
}

test('checkpoint creation hashes its owned normalized payload without a second admission', () => {
  const fingerprints = require('../lib/proxy/context-recovery-fingerprint');
  const original = fingerprints.fingerprintRecoveryCheckpoint;
  const file = require.resolve('../lib/proxy/context-recovery-root-checkpoint');
  const cached = require.cache[file];
  const f = fixture();
  let admissions = 0;
  try {
    fingerprints.fingerprintRecoveryCheckpoint = (...args) => {
      admissions++;
      return Reflect.apply(original, fingerprints, args);
    };
    delete require.cache[file];
    const codec = require('../lib/proxy/context-recovery-root-checkpoint');
    const root = f.state();
    const checkpoint = codec.createRootCheckpoint(root, []);
    assert.equal(admissions, 0, 'only unknown fingerprint inputs need their own admission');
    assert.equal(checkpoint.digest, original({ root, stagedSources: [], publications: [] }));
    assert.deepEqual(codec.parseRootCheckpoint(checkpoint, root), checkpoint);
    assert.equal(admissions, 0, 'the parser hashes its independently normalized local copy');
    assert.throws(() => codec.parseRootCheckpoint({ ...checkpoint, digest: '0'.repeat(64) }, root));
    for (const version of [1, 8, 9, 10]) {
      const value = {
        root: { version, text: 'exact🙂\r\n\t"\\', 2: -0, 10: ['中', null, true] },
        stagedSources: [],
        publications: [],
      };
      const created = codec.createRootCheckpoint(value.root, value.stagedSources);
      assert.equal(created.digest, original(value));
      assert.notEqual(created.root, value.root);
      assert.notEqual(created.root['10'], value.root['10']);
    }
  } finally {
    fingerprints.fingerprintRecoveryCheckpoint = original;
    if (cached) require.cache[file] = cached;
    else delete require.cache[file];
    f.sessions.close();
  }
});

test('checkpoint parser admits unknown input once and hashes only its owned projection', () => {
  const f = fixture({ privateHistory: true });
  const root = f.state();
  const checkpoint = createRootCheckpoint(root, []);
  const stateData = require('../lib/proxy/context-recovery-state-data');
  const fingerprints = require('../lib/proxy/context-recovery-fingerprint');
  const normalize = stateData.normalizeRecoveryCheckpointData;
  const fingerprint = fingerprints.fingerprintRecoveryCheckpoint;
  const file = require.resolve('../lib/proxy/context-recovery-root-checkpoint');
  const cached = require.cache[file];
  let admissions = 0,
    repeatedAdmissions = 0;
  try {
    stateData.normalizeRecoveryCheckpointData = (...args) => {
      admissions++;
      return Reflect.apply(normalize, stateData, args);
    };
    fingerprints.fingerprintRecoveryCheckpoint = (...args) => {
      repeatedAdmissions++;
      return Reflect.apply(fingerprint, fingerprints, args);
    };
    delete require.cache[file];
    const codec = require('../lib/proxy/context-recovery-root-checkpoint');
    const parsed = codec.parseRootCheckpoint(checkpoint, root);
    assert.equal(admissions, 1, 'unknown input always crosses complete normalization');
    assert.equal(repeatedAdmissions, 0, 'owned digest projection does not need another clone');
    assert.deepEqual(parsed, checkpoint);
    assert.notEqual(parsed, checkpoint);
    assert.notEqual(parsed.root, checkpoint.root);
    assert.notEqual(parsed.root.history, checkpoint.root.history);
    codec.parseRootCheckpoint(checkpoint, root);
    assert.equal(admissions, 2, 'each invocation independently admits its input');
    const legacy = { ...checkpoint };
    delete legacy.publications;
    legacy.digest = fingerprint({ root: legacy.root, stagedSources: legacy.stagedSources });
    const parsedLegacy = codec.parseRootCheckpoint(legacy, root);
    assert.equal(Object.getPrototypeOf(parsedLegacy), null);
    assert.deepEqual(copy(parsedLegacy), copy(legacy));
    assert.throws(() => codec.parseRootCheckpoint({ ...checkpoint, digest: '0'.repeat(64) }, root));
    const invalidBudget = codec.createRootCheckpoint(
      { ...root, budget: { ...root.budget, calls: -1 } },
      []
    );
    assert.throws(() => codec.parseRootCheckpoint(invalidBudget, root));
    let touched = 0;
    const hook = () => {
      touched++;
      throw new Error('untrusted_checkpoint_hook');
    };
    for (const input of [
      null,
      undefined,
      [],
      {},
      { ...checkpoint, version: 2 },
      { ...checkpoint, stagedSources: Array(2) },
      Object.defineProperty({}, 'root', { enumerable: true, get: hook }),
      new Proxy(checkpoint, { getOwnPropertyDescriptor: hook }),
      { ...checkpoint, root: new Proxy(root, { getOwnPropertyDescriptor: hook }) },
    ])
      assert.throws(() => codec.parseRootCheckpoint(input, root));
    assert.equal(touched, 0);
    assert.equal(repeatedAdmissions, 0);
  } finally {
    stateData.normalizeRecoveryCheckpointData = normalize;
    fingerprints.fingerprintRecoveryCheckpoint = fingerprint;
    if (cached) require.cache[file] = cached;
    else delete require.cache[file];
    f.sessions.close();
  }
});

test('metadata association validates its fresh normalized root without cloning private history again', (t) => {
  const f = fixture({ privateHistory: true });
  const stateData = require('../lib/proxy/context-recovery-state-data');
  const file = require.resolve('../lib/proxy/context-recovery-root-state');
  const cached = require.cache[file];
  const stateNormalizer = stateData.normalizeRecoveryStateData;
  const referenceNormalizer = stateData.normalizeRecoveryReferenceData;
  let rootClones = 0,
    envelopeClones = 0;
  try {
    const reference = referenceStateFromCheckpoint(createRootCheckpoint(f.state(), []));
    const input = { metadata: reference.metadata, stagedSources: reference.stagedSources };
    const policy = require('../lib/proxy/context-recovery-root-policy');
    const validatePolicy = policy.validateRecoveryRootPolicy;
    t.mock.method(policy, 'validateRecoveryRootPolicy', (state) => {
      assert.equal(
        Object.getPrototypeOf(state),
        null,
        'local roots retain descriptor-clone isolation'
      );
      return validatePolicy(state);
    });
    stateData.normalizeRecoveryStateData = (...args) => {
      rootClones++;
      return Reflect.apply(stateNormalizer, stateData, args);
    };
    stateData.normalizeRecoveryReferenceData = (...args) => {
      envelopeClones++;
      return Reflect.apply(referenceNormalizer, stateData, args);
    };
    delete require.cache[file];
    const codec = require('../lib/proxy/context-recovery-root-state');
    const parsed = codec.validateRecoveryRootMetadata(input);
    assert.equal(
      envelopeClones,
      1,
      'unknown metadata still crosses its full normalization boundary'
    );
    assert.equal(rootClones, 0, "semantic checks reuse only this call's bounded local clone");
    assert.deepEqual(copy(parsed), copy(input));
    assert.notEqual(parsed, input);
    assert.notEqual(parsed.metadata, input.metadata);
    assert.notEqual(parsed.metadata.history, input.metadata.history);
    assert.equal(Object.hasOwn(codec, 'validateParsedRoot'), false);
    codec.validateRecoveryRootMetadata(input);
    assert.equal(envelopeClones, 2, 'later invocations must normalize again');
    input.metadata.expiresAt++;
    assert.throws(() => codec.validateRecoveryRootMetadata(input), fail);
    assert.equal(parsed.metadata.expiresAt, reference.metadata.expiresAt - 1);
    let touched = 0;
    const hostile = Object.defineProperty({}, 'metadata', {
      enumerable: true,
      get() {
        touched++;
        throw Error('must not execute');
      },
    });
    for (const invalid of [null, [], {}, hostile])
      assert.throws(() => codec.validateRecoveryRootMetadata(invalid), fail);
    assert.equal(touched, 0);
    assert.equal(rootClones, 0);
  } finally {
    stateData.normalizeRecoveryStateData = stateNormalizer;
    stateData.normalizeRecoveryReferenceData = referenceNormalizer;
    if (cached) require.cache[file] = cached;
    else delete require.cache[file];
    f.sessions.close();
  }
});

function largePrivateFixture(rounds = 3, now) {
  const f = fixture({ now });
  try {
    let previousResponseId = 'child-response';
    let history = [...f.request.history, ...f.output];
    for (let round = 0; round < rounds; round++) {
      history = [...history, user('continue-' + round)];
      const request = input(history);
      const child = f.sessions.begin(request);
      assert.equal(child.ok, true);
      const run = child.recovery({ model: 'synthetic', messages: request.history });
      assert.equal(run.ok, true);
      const response = completion([{ id: 'large-private-' + round, name: LIST, args: {} }]);
      response.choices[0].message.content = String(round).repeat(1024 * 1024);
      assert.equal(run.accept(response).mode, 'continue');
      const released = run.accept(completion());
      assert.equal(released.mode, 'release');
      previousResponseId = 'private-response-' + round;
      assert.equal(child.complete(released.output, [], previousResponseId).ok, true);
      history = [...history, ...released.output];
    }
    return { ...f, privateHistory: history };
  } catch (error) {
    f.sessions.close();
    throw error;
  }
}

function fullPrivateSessionFixture({
  count = 512,
  padding = [0, 0],
  now = Date.now,
  target = 'target',
  signal,
} = {}) {
  signal?.throwIfAborted();
  let lastTime, clockRollbackMs;
  const sessions = createContextRecoverySessions({
    now() {
      const time = now();
      if (Number.isSafeInteger(time) && Number.isSafeInteger(lastTime) && time < lastTime)
        clockRollbackMs ??= lastTime - time;
      lastTime = time;
      return time;
    },
  });
  sessions.configure(true);
  let root, rootHistory;
  const requests = [];
  try {
    for (let index = 0; index < count; index++) {
      signal?.throwIfAborted();
      const id = String(index).padStart(4, '0');
      const history =
        index === 0
          ? [user('capacity-root')]
          : [
              ...rootHistory,
              { role: 'tool', tool_call_id: 'external', content: 'original-' + id },
              user('branch-' + id),
            ];
      const request = input(history, { target });
      requests.push(request);
      const session = sessions.begin(
        request,
        index === 0 ? [] : [{ callId: 'external', output: 'original-' + id }]
      );
      assert.equal(
        session.ok,
        true,
        JSON.stringify({ index, code: session.code, clockRollbackMs })
      );
      root ??= session;
      const run = session.recovery({
        model: 'synthetic',
        messages: history,
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
      });
      assert.equal(run.ok, true, JSON.stringify({ index, code: run.code, clockRollbackMs }));
      for (const suffix of ['a', 'b']) {
        const calls = [
          {
            id: 'capacity-' + id + '-' + suffix,
            name: LIST,
            args: { limit: suffix === 'a' ? 1 : 2 },
          },
        ];
        if (index === 0 && suffix === 'a') calls.push({ id: 'external', name: 'lookup', args });
        const accepted = run.accept(
          completion(calls, suffix === 'a' ? 'x'.repeat(padding[index === 0 ? 0 : 1]) : '')
        );
        // Keep diagnostics bounded to fixture position and the safe error code.
        // Never print a private exchange merely to explain a failed assertion.
        assert.equal(
          accepted.mode,
          'continue',
          JSON.stringify({ index, suffix, code: accepted.code, clockRollbackMs })
        );
      }
      const released = run.accept(completion([], 'public-' + id));
      assert.equal(
        released.mode,
        'release',
        JSON.stringify({ index, code: released.code, clockRollbackMs })
      );
      assert.equal(
        session.complete(released.output, index === 0 ? [observed] : [], 'capacity-response-' + id)
          .ok,
        true
      );
      if (index === 0) rootHistory = [...history, ...released.output];
    }
    return { sessions, requests, state: exportContextRecoveryRoot(sessions, root.snapshotId) };
  } catch (error) {
    sessions.close();
    throw error;
  }
}

test('cancelled full private fixture stops before creating sessions or reading its clock', () => {
  const controller = new globalThis.AbortController();
  controller.abort();
  let clocks = 0;
  assert.throws(
    () =>
      fullPrivateSessionFixture({
        signal: controller.signal,
        now: () => {
          clocks++;
          return 100;
        },
      }),
    { name: 'AbortError' }
  );
  assert.equal(clocks, 0);
});

test('full private fixture records a clock rollback without smoothing or accepting it', () => {
  let clocks = 0;
  assert.throws(
    () => fullPrivateSessionFixture({ count: 2, now: () => (++clocks === 1 ? 1000 : 999) }),
    (error) =>
      error.code === 'ERR_ASSERTION' &&
      error.message.includes('"clockRollbackMs":1') &&
      error.message.includes('"code":"context_recovery_stale"')
  );
  assert.ok(clocks >= 2);
});

test('full private fixture keeps the supplied clock and complete ordinary recovery rounds', () => {
  let clocks = 0;
  const fixture = fullPrivateSessionFixture({
    count: 2,
    now: () => {
      clocks++;
      return 1000;
    },
  });
  try {
    assert.equal(fixture.state.history.entries.length, 2);
    assert.equal(fixture.state.createdAt, 1000);
    assert.equal(fixture.state.expiresAt, 1000 + 24 * 60 * 60 * 1000);
    assert.ok(clocks > 2);
  } finally {
    fixture.sessions.close();
  }
});

test(
  'full session private capacity reaches 512 snapshots and eight MiB through real recovery rounds',
  { timeout: 120000 },
  () => {
    const pilot = fullPrivateSessionFixture({ count: 2 });
    const padding = pilot.state.history.entries.map((entry) => 16384 - entry.bytes);
    pilot.sessions.close();
    assert.equal(padding.length, 2);
    const full = fullPrivateSessionFixture({ padding });
    try {
      assert.equal(full.state.history.entries.length, 512);
      assert.equal(
        full.state.history.entries.reduce((bytes, entry) => bytes + entry.bytes, 0),
        8 * 1024 * 1024
      );
      assert.equal(full.state.ledger.sources.length, 511);
      const checkpoint = createRootCheckpoint(full.state, []);
      const reference = referenceStateFromCheckpoint(checkpoint);
      const payloads = full.state.ledger.sources.map(({ sourceId, output }) => ({
        sourceId,
        output,
      }));
      assert.equal(hydrateReferenceState(reference, payloads).digest, checkpoint.digest);
    } finally {
      full.sessions.close();
    }
  }
);

test(
  'encrypted worker reopens four full session roots with 32 MiB of exact private history',
  { timeout: 180000 },
  async (t) => {
    if (process.platform !== 'win32') return;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-full-private-worker-'));
    const fixtures = [];
    let storage, restored;
    const pilot = fullPrivateSessionFixture({ count: 2 });
    const padding = pilot.state.history.entries.map((entry) => 16384 - entry.bytes);
    pilot.sessions.close();
    try {
      const options = { directory: path.join(directory, 'context') };
      storage = await openContextRecoveryStorage(options);
      t.signal.throwIfAborted();
      for (let index = 0; index < 4; index++) {
        const fixture = fullPrivateSessionFixture({
          padding,
          target: 'capacity-target-' + index,
          signal: t.signal,
        });
        fixtures.push(fixture);
        const state = fixture.state;
        assert.equal(state.history.entries.length, 512);
        assert.equal(
          state.history.entries.reduce((bytes, entry) => bytes + entry.bytes, 0),
          8 * 1024 * 1024
        );
        const checkpoint = createRootCheckpoint(state, []);
        const reference = referenceStateFromCheckpoint(checkpoint);
        fixture.scope = sha('hpm/recovery-root/v1\0' + state.rootId);
        fixture.digest = checkpoint.digest;
        assert.equal(
          (
            await storage.execute({
              operation: 'save-reference-state',
              scope: fixture.scope,
              expectedRevision: 0,
              expiresAt: state.expiresAt,
              reference,
              payloads: state.ledger.sources.map(({ sourceId, output }) => ({ sourceId, output })),
            })
          ).revision,
          1
        );
        t.signal.throwIfAborted();
        fixture.sessions.close();
      }
      await storage.close();
      storage = undefined;
      t.signal.throwIfAborted();
      storage = await openContextRecoveryStorage(options);
      t.signal.throwIfAborted();
      const roots = [];
      for (const fixture of fixtures) {
        const loaded = await storage.execute({ operation: 'load', scope: fixture.scope });
        t.signal.throwIfAborted();
        assert.equal(loaded.state.digest, fixture.digest);
        assert.equal(loaded.expiresAt, fixture.state.expiresAt);
        assert.equal(
          sha(JSON.stringify(loaded.state.root.history)),
          sha(JSON.stringify(fixture.state.history))
        );
        assert.deepEqual(
          copy(loaded.state.root.ledger.sources),
          copy(fixture.state.ledger.sources)
        );
        roots.push({ binding: fixture.requests[0], state: loaded.state.root });
      }
      restored = restoreContextRecoverySessions({ now: Date.now }, roots);
      for (const fixture of fixtures) {
        const state = exportContextRecoveryRoot(restored, fixture.state.rootId);
        assert.equal(state.expiresAt, fixture.state.expiresAt);
        assert.ok(state.history.observedAt >= fixture.state.history.observedAt);
        assert.deepEqual(
          { ...copy(state.history), observedAt: fixture.state.history.observedAt },
          copy(fixture.state.history)
        );
      }
    } finally {
      for (const fixture of fixtures) fixture.sessions.close();
      restored?.close();
      try {
        await storage?.close();
      } finally {
        const resolved = path.resolve(directory);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('hpm-full-private-worker-'));
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    }
  }
);

test('v10 private history larger than two MiB survives reference write and hydration', () => {
  const f = largePrivateFixture();
  try {
    const state = f.state();
    assert.ok(Buffer.byteLength(JSON.stringify(state.history)) > 3 * 1024 * 1024);
    const checkpoint = createRootCheckpoint(state, []);
    const reference = referenceStateFromCheckpoint(checkpoint);
    assert.ok(Buffer.byteLength(JSON.stringify(reference)) > 3 * 1024 * 1024);
    const payloads = state.ledger.sources.map(({ sourceId, output }) => ({ sourceId, output }));
    assert.equal(hydrateReferenceState(reference, payloads).digest, checkpoint.digest);
    const write = createReferenceWrite(checkpoint, null);
    assert.equal(
      materializeReferenceWrite(write.reference, write.payloads, null).digest,
      checkpoint.digest
    );
    const changed = copy(reference);
    changed.metadata.history.entries[0].tail[0].content = 'tampered';
    assert.throws(() => hydrateReferenceState(changed, payloads));
    assert.equal(reference.metadata.expiresAt, state.expiresAt);
    const database = new DatabaseSync(':memory:');
    const storage = createRecoverySqliteStore({
      database,
      dataKey: randomBytes(32).toString('base64'),
      now: f.clock,
    });
    try {
      const scope = sha('hpm/recovery-root/v1\0' + state.rootId);
      assert.equal(
        storage.execute({
          operation: 'save-reference-state',
          scope,
          expectedRevision: 0,
          expiresAt: state.expiresAt,
          reference,
          payloads,
        }).revision,
        1
      );
      const loaded = storage.execute({ operation: 'load-reference', scope });
      assert.equal(loaded.reference.digest, reference.digest);
      assert.equal(hydrateReferenceState(loaded.reference, payloads).digest, checkpoint.digest);
      const scanned = storage.execute({ operation: 'scan-reference', after: null });
      assert.equal(scanned.record.reference.digest, reference.digest);
      assert.equal(storage.execute({ operation: 'load', scope }).state.digest, checkpoint.digest);
      f.setTime(state.expiresAt);
      assert.equal(storage.execute({ operation: 'load-reference', scope }), null);
    } finally {
      storage.close();
      database.close();
    }
  } finally {
    f.sessions.close();
  }
});

test(
  'encrypted worker reopens seven MiB of v10 private history with exact original bytes',
  { timeout: 120000 },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-large-private-worker-'));
    const f = largePrivateFixture(7, Date.now);
    let storage, restored;
    try {
      const options = { directory: path.join(directory, 'context') };
      if (process.platform !== 'win32') {
        await assert.rejects(openContextRecoveryStorage(options), {
          code: 'context_recovery_storage_unavailable',
        });
        return;
      }
      const state = f.state();
      const checkpoint = createRootCheckpoint(state, []);
      const reference = referenceStateFromCheckpoint(checkpoint);
      const scope = sha('hpm/recovery-root/v1\0' + state.rootId);
      const payloads = state.ledger.sources.map(({ sourceId, output }) => ({ sourceId, output }));
      assert.ok(Buffer.byteLength(JSON.stringify(reference)) > 7 * 1024 * 1024);
      storage = await openContextRecoveryStorage(options);
      assert.equal(
        (
          await storage.execute({
            operation: 'save-reference-state',
            scope,
            expectedRevision: 0,
            expiresAt: state.expiresAt,
            reference,
            payloads,
          })
        ).revision,
        1
      );
      f.sessions.close();
      await storage.close();
      storage = undefined;
      storage = await openContextRecoveryStorage(options);
      const loaded = await storage.execute({ operation: 'load-reference', scope });
      assert.equal(loaded.reference.digest, reference.digest);
      assert.equal(loaded.expiresAt, state.expiresAt);
      const scan = await storage.execute({ operation: 'scan-reference', after: null });
      assert.equal(scan.record.reference.digest, reference.digest);
      const full = await storage.execute({ operation: 'load', scope });
      assert.equal(full.state.digest, checkpoint.digest);
      assert.deepEqual(copy(full.state.root.history), copy(state.history));
      assert.equal(full.state.root.ledger.sources[0].output, f.text);
      restored = restoreContextRecoverySessions({ now: Date.now }, [
        { binding: f.request, state: full.state.root },
      ]);
      const next = restored.begin(input([...f.privateHistory, user('after-cold-reopen')]));
      assert.equal(next.ok, true);
      const run = next.recovery({
        model: 'synthetic',
        messages: [...f.privateHistory, user('after-cold-reopen')],
      });
      assert.equal(run.ok, true);
      for (let round = 0; round < 7; round++) {
        const hidden = run.initialRequest.messages.find(
          (item) =>
            item.role === 'assistant' && item.tool_calls?.[0]?.id === 'large-private-' + round
        );
        assert.equal(hidden.content, String(round).repeat(1024 * 1024));
      }
      next.abort();
    } finally {
      f.sessions.close();
      restored?.close();
      try {
        await storage?.close();
      } finally {
        const resolved = path.resolve(directory);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('hpm-large-private-worker-'));
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    }
  }
);

test('version 8 roots preserve byte and snapshot capacity alongside new version 9 roots', () => {
  const f = fixture();
  let restored;
  try {
    const state = copy(f.state());
    assert.equal(state.version, 10);
    assert.equal(state.ledger.policy.maxBytes, 16 * 1024 * 1024);
    state.version = 8;
    state.ledger.policy.maxBytes = 4 * 1024 * 1024;
    restored = restore(f, state);
    const saved = exportContextRecoveryRoot(restored, state.rootId);
    assert.equal(saved.version, 8);
    assert.equal(saved.ledger.policy.maxEntries, 512);
    assert.equal(saved.ledger.policy.maxBytes, 4 * 1024 * 1024);
    assert.equal(saved.expiresAt, state.expiresAt);
    const fresh = restored.begin(input([user('new root')], { target: 'different-target' }));
    assert.equal(fresh.complete([answer('done')], [], 'new-version-root').ok, true);
    const newState = exportContextRecoveryRoot(restored, fresh.snapshotId);
    assert.equal(newState.version, 10);
    assert.equal(newState.ledger.policy.maxBytes, 16 * 1024 * 1024);
    assert.throws(
      () =>
        restore(f, {
          ...state,
          ledger: {
            ...state.ledger,
            policy: { ...state.ledger.policy, maxBytes: 16 * 1024 * 1024 },
          },
        }),
      fail
    );
  } finally {
    f.sessions.close();
    restored?.close();
  }
});

test('version 9 retains and reconstructs sixteen MiB of original bytes without extending expiry', () => {
  let runtime = createContextRecoverySessions({ now: () => 100 });
  runtime.configure(true);
  try {
    const first = runtime.begin(input());
    const calls = Array.from({ length: 17 }, (_, index) => ({
      callId: 'large-' + index,
      toolName: 'lookup',
      arguments: {},
      output: '',
      completed: true,
    }));
    const output = {
      role: 'assistant',
      content: null,
      tool_calls: calls.map((call) => ({
        id: call.callId,
        type: 'function',
        function: { name: call.toolName, arguments: '{}' },
      })),
    };
    assert.equal(first.complete([output], calls, 'large-byte-parent').ok, true);
    for (let index = 0; index < 16; index++) {
      const child = runtime.begin(
        input([user('capture-' + index)], { previousResponseId: 'large-byte-parent' }),
        [{ callId: calls[index].callId, output: String(index % 10).repeat(1024 * 1024) }]
      );
      assert.equal(child.complete([answer('saved')], [], 'large-byte-' + index).ok, true);
    }
    const state = exportContextRecoveryRoot(runtime, first.snapshotId);
    assert.equal(state.ledger.sources.length, 16);
    assert.equal(
      state.ledger.sources.reduce((sum, source) => sum + source.bytes, 0),
      16 * 1024 * 1024
    );
    assert.ok(Buffer.byteLength(JSON.stringify(state)) > 16 * 1024 * 1024);
    const checkpoint = createRootCheckpoint(state, []);
    const reference = referenceStateFromCheckpoint(checkpoint);
    const payloads = state.ledger.sources.map(({ sourceId, output }) => ({ sourceId, output }));
    const hydrated = hydrateReferenceState(reference, payloads);
    assert.equal(hydrated.digest, checkpoint.digest);
    assert.equal(hydrated.root.expiresAt, state.expiresAt);
    assert.deepEqual(copy(hydrated.root.ledger.sources), copy(state.ledger.sources));
    const write = createReferenceWrite(checkpoint, null);
    assert.equal(write.payloads.length, 16);
    assert.equal(
      materializeReferenceWrite(write.reference, write.payloads, null).digest,
      checkpoint.digest
    );
    const unchanged = createReferenceWrite(checkpoint, checkpoint);
    assert.deepEqual(unchanged.payloads, []);
    assert.equal(
      materializeReferenceWrite(unchanged.reference, [], checkpoint).digest,
      checkpoint.digest
    );
    const badPayloads = payloads.map((source, index) =>
      index ? source : { ...source, output: 'changed' }
    );
    assert.throws(() => hydrateReferenceState(reference, badPayloads));
    assert.throws(() => createRootCheckpoint({ ...state, version: 8 }, []));
    runtime.close();
    runtime = restoreContextRecoverySessions({ now: () => 101 }, [
      { binding: input(), state: copy(state) },
    ]);
    const saved = exportContextRecoveryRoot(runtime, first.snapshotId);
    assert.equal(saved.expiresAt, state.expiresAt);
    assert.deepEqual(copy(saved.ledger.sources), copy(state.ledger.sources));
    const denied = runtime.begin(
      input([user('quota')], { previousResponseId: 'large-byte-parent' }),
      [{ callId: calls[16].callId, output: 'x' }]
    );
    assert.equal(denied.ok, true);
    denied.abort();
    assert.equal(exportContextRecoveryRoot(runtime, first.snapshotId).ledger.sources.length, 16);
  } finally {
    runtime.close();
  }
});
test('distinct metadata root restore rebuilds associations and accounting without resident payloads', () => {
  for (const privateHistory of [false, true]) {
    const f = fixture({ privateHistory });
    let restored;
    try {
      const full = f.state();
      const reference = referenceStateFromCheckpoint(createRootCheckpoint(full, []));
      assert.throws(
        () =>
          restoreRecoveryRootStates({ now: f.clock }, [
            { binding: input(), state: reference.metadata },
          ]),
        fail
      );
      restored = restoreRecoveryRootMetadataStates({ now: f.clock }, [
        { binding: input(), state: reference.metadata },
      ]);
      const root = restored.roots.get(full.rootId);
      assert.ok(root);
      assert.deepEqual(contextEvidenceResidency(root.ledger), {
        residentBytes: 0,
        residentEntries: 0,
        coldEntries: 1,
      });
      assert.deepEqual(exportContextEvidenceMetadata(root.ledger), reference.metadata.ledger);
      assert.equal(root.expiresAt, full.expiresAt);
      const state = exportRecoveryRootMetadata(
        root,
        restored.registry,
        restored.historyMap,
        restored.snapshots,
        100
      );
      assert.deepEqual(copy(state.metadata), copy(reference.metadata));
      assert.deepEqual(state.stagedSources, []);
      assert.throws(() =>
        exportRecoveryRootState(
          root,
          restored.registry,
          restored.historyMap,
          restored.snapshots,
          100
        )
      );
    } finally {
      f.sessions.close();
      restored?.registry.close();
      restored?.historyMap.close();
      for (const root of restored?.roots.values() ?? []) root.ledger.close();
    }
  }
});

test('metadata root restore still requires the current binding and rejects malformed and payload-bearing roots', () => {
  const f = fixture();
  try {
    const full = f.state();
    const reference = referenceStateFromCheckpoint(createRootCheckpoint(full, []));
    for (const binding of [
      input(undefined, { principal: 'other' }),
      input(undefined, { target: 'other' }),
      input(undefined, { policy: { altered: true } }),
    ])
      assert.throws(
        () =>
          restoreRecoveryRootMetadataStates({ now: f.clock }, [
            { binding, state: reference.metadata },
          ]),
        fail
      );
    for (const state of [
      full,
      {},
      null,
      { ...reference.metadata, sourceVersion: 99 },
      {
        ...reference.metadata,
        ledger: {
          ...reference.metadata.ledger,
          sources: [{ ...reference.metadata.ledger.sources[0], output: f.text }],
        },
      },
    ])
      assert.throws(
        () => restoreRecoveryRootMetadataStates({ now: f.clock }, [{ binding: input(), state }]),
        fail
      );
    f.setTime(full.expiresAt);
    const expired = restoreRecoveryRootMetadataStates({ now: f.clock }, [
      { binding: input(), state: reference.metadata },
    ]);
    assert.equal(expired.roots.size, 0);
    expired.registry.close();
    expired.historyMap.close();
  } finally {
    f.sessions.close();
  }
});

test('projected cold metadata retains staged identities and quota without granting descriptors or visibility', () => {
  const f = fixture();
  let restored;
  try {
    const full = f.state();
    const reference = referenceStateFromCheckpoint(
      createRootCheckpoint(
        full,
        [],
        [
          { snapshotId: full.rootId, state: 'transport-finished' },
          { snapshotId: f.child.snapshotId, state: 'uncertain' },
        ]
      )
    );
    const projected = projectPublishedRecoveryReference(reference, input(), 100);
    assert.deepEqual(projected.metadata.ledger.sources, []);
    assert.deepEqual(projected.stagedSources, reference.metadata.ledger.sources);
    restored = restoreRecoveryRootMetadataStates({ now: f.clock }, [
      { binding: input(), state: projected },
    ]);
    const root = restored.roots.get(full.rootId);
    assert.equal(root.descriptors.size, 0);
    assert.ok([...restored.snapshots.values()].every((snapshot) => snapshot.visible.size === 0));
    assert.deepEqual(contextEvidenceResidency(root.ledger), {
      residentBytes: 0,
      residentEntries: 0,
      coldEntries: 1,
    });
    assert.deepEqual(exportContextEvidenceMetadata(root.ledger), reference.metadata.ledger);
    assert.deepEqual(
      copy(
        exportRecoveryRootMetadata(
          root,
          restored.registry,
          restored.historyMap,
          restored.snapshots,
          100
        )
      ),
      copy(projected)
    );
    const stagedOnly = referenceStateFromCheckpoint(
      createRootCheckpoint(
        {
          ...full,
          binding: projected.metadata.binding,
          snapshots: projected.metadata.snapshots,
          history: projected.metadata.history,
          ledger: { ...full.ledger, sources: [] },
        },
        full.ledger.sources,
        [{ snapshotId: full.rootId, state: 'transport-finished' }]
      )
    );
    assert.deepEqual(projectPublishedRecoveryReference(stagedOnly, input(), 100), projected);
    for (const mutate of [
      (value) => value.stagedSources.push(value.stagedSources[0]),
      (value) => {
        value.stagedSources[0].output = f.text;
      },
      (value) => {
        value.stagedSources[0].bytes = full.ledger.policy.maxOutputBytes + 1;
      },
      (value) => {
        value.stagedSources[0].expiresAt++;
      },
      (value) => {
        value.metadata.snapshots[0].visible = [value.stagedSources[0].sourceId];
      },
      (value) => {
        value.stagedSources = Array(65).fill(value.stagedSources[0]);
      },
      (value) => {
        value.extra = true;
      },
    ]) {
      const corrupt = copy(projected);
      mutate(corrupt);
      assert.throws(
        () =>
          restoreRecoveryRootMetadataStates({ now: f.clock }, [
            { binding: input(), state: corrupt },
          ]),
        fail
      );
    }
    let executed = 0;
    assert.throws(
      () =>
        restoreRecoveryRootMetadataStates({ now: f.clock }, [
          {
            binding: input(),
            state: {
              metadata: projected.metadata,
              get stagedSources() {
                executed++;
                return projected.stagedSources;
              },
            },
          },
        ]),
      fail
    );
    assert.equal(executed, 0);
    assert.throws(
      () => restoreRecoveryRootStates({ now: f.clock }, [{ binding: input(), state: projected }]),
      fail
    );
  } finally {
    f.sessions.close();
    restored?.registry.close();
    restored?.historyMap.close();
    for (const root of restored?.roots.values() ?? []) root.ledger.close();
  }
});

function restore(f, state = f.state()) {
  return restoreContextRecoverySessions({ now: f.clock }, [{ binding: input(), state }]);
}

for (const version of [9, 10])
  test(`full v${version} restore privately reuses ledger admission and preserves live reads and fixed expiry`, (t) => {
    const f = fixture({ privateHistory: version === 10 });
    let restored;
    try {
      const state = f.state();
      if (version === 9) {
        assert.equal(state.history.entries.length, 0);
        state.version = 9;
        state.history.version = 2;
        delete state.history.rootId;
      }
      assert.equal(Object.isFrozen(state), false);
      assert.equal(Object.isFrozen(state.ledger.sources[0]), false);
      const descriptors = Object.getOwnPropertyDescriptors;
      let repeatedLedgerAdmissions = 0;
      const hook = t.mock.method(Object, 'getOwnPropertyDescriptors', (value) => {
        if (Object.getOwnPropertyDescriptor(value, 'kind')?.value === 'evidence-ledger')
          repeatedLedgerAdmissions++;
        return descriptors(value);
      });
      f.sessions.close();
      f.setTime(200);
      restored = restore(f, state);
      hook.mock.restore();
      assert.equal(repeatedLedgerAdmissions, 0, 'only the private bounded root clone grants proof');
      const saved = exportContextRecoveryRoot(restored, state.rootId);
      assert.deepEqual(copy(saved.ledger.sources), copy(state.ledger.sources));
      assert.equal(saved.expiresAt, state.expiresAt);
      assert.equal(saved.ledger.policy.maxOutputBytes, 1024 * 1024);
      assert.equal(Object.isFrozen(saved), false);
      assert.equal(Object.isFrozen(saved.ledger.sources[0]), false);
      saved.ledger.sources[0].output = 'caller mutation';
      state.ledger.sources[0].output = 'caller mutation of original';
      const next = restored.begin(
        input([user('owned-next')], { previousResponseId: 'child-response' })
      );
      assert.equal(next.reason, 'observed_continuation');
      const query = { sourceId: f.receipt.sourceId, digest: f.receipt.digest };
      assert.equal(JSON.parse(next.reply(READ, query).text).page.text, f.text);
      assert.equal(exportContextRecoveryRoot(restored, state.rootId).expiresAt, state.expiresAt);
      f.setTime(state.expiresAt);
      assert.equal(next.reply(READ, query).ok, false);
      next.abort();
    } finally {
      f.sessions.close();
      restored?.close();
    }
  });

function pendingFixture({ now } = {}) {
  let time = 100;
  const clock = now ?? (() => time);
  const sessions = createContextRecoverySessions({ now: clock });
  sessions.configure(true);
  const request = {
    principal: 'owner',
    protocol: 'responses',
    target: 'target',
    history: [user('synthetic')],
  };
  const external = {
    type: 'function_call',
    id: 'fc_external',
    call_id: 'external',
    name: 'lookup',
    arguments: '{}',
    status: 'completed',
  };
  const first = sessions.begin(request);
  assert.equal(
    first.complete([external], [{ ...observed, arguments: {} }], 'pending-first').ok,
    true
  );
  const delta = [{ type: 'function_call_output', call_id: 'external', output: '原文🙂\r\nexact' }];
  const nextRequest = { ...request, history: delta, previousResponseId: 'pending-first' };
  const child = sessions.begin(nextRequest, [{ callId: 'external', output: delta[0].output }]);
  const tools = [
    { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } },
  ];
  const body = { model: 'synthetic', input: delta, previous_response_id: 'pending-first', tools };
  const run = child.recovery(body, { deferMixedResults: true });
  assert.equal(run.ok, true);
  const release = run.accept({
    id: 'pending-mixed',
    status: 'completed',
    output: [
      { ...external, id: 'fc_private', call_id: 'private-list', name: LIST },
      { ...external, id: 'fc_next', call_id: 'next-external' },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  assert.equal(release.mode, 'release');
  assert.equal(release.deferredInput.length, 1);
  assert.equal(
    child.complete(
      release.output,
      [{ ...observed, callId: 'next-external', arguments: {} }],
      'pending-mixed'
    ).ok,
    true
  );
  return {
    sessions,
    child,
    request,
    first,
    pending: release.deferredInput,
    publicHistory: [...request.history, external, ...delta, ...release.output],
    next: {
      ...request,
      history: [
        { type: 'function_call_output', call_id: 'next-external', output: 'external-only' },
      ],
      previousResponseId: 'pending-mixed',
    },
    state: () => exportContextRecoveryRoot(sessions, first.snapshotId),
    clock,
    setTime: (value) => {
      time = value;
    },
  };
}

test('a full Responses window rebuilds exact private delta exchanges after reopening without repeating pending results', async () => {
  const f = pendingFixture();
  let restored;
  try {
    assert.equal((await f.child.finishPublicationAsync()).ok, true);
    const state = f.state();
    f.sessions.close();
    restored = restoreContextRecoverySessions({ now: f.clock }, [{ binding: f.request, state }]);
    const history = [...f.publicHistory, ...f.next.history];
    const next = restored.begin({ ...f.request, history }, [
      { callId: 'next-external', output: 'external-only' },
    ]);
    assert.equal(next.ok, true);
    const run = next.recovery({ model: 'synthetic', input: history });
    assert.equal(run.ok, true);
    assert.equal(run.initialRequest.previous_response_id, undefined);
    const wire = run.initialRequest.input;
    const offset = f.publicHistory.length - 1;
    assert.deepEqual(copy(wire.slice(0, offset)), copy(f.publicHistory.slice(0, offset)));
    assert.equal(wire[offset].type, 'function_call');
    assert.equal(wire[offset].name, LIST);
    assert.equal(wire[offset].call_id, f.pending[0].call_id);
    assert.deepEqual(copy(wire[offset + 1]), copy(f.pending[0]));
    assert.deepEqual(copy(wire.slice(offset + 2)), copy(history.slice(offset)));
    assert.equal(
      wire.filter(
        (item) => item.type === 'function_call_output' && item.call_id === f.pending[0].call_id
      ).length,
      1
    );
    const final = { type: 'message', role: 'assistant', id: 'msg_after_reopen', content: [] };
    const release = run.accept({ id: 'after-reopen', status: 'completed', output: [final] });
    assert.equal(release.mode, 'release');
    assert.equal(next.complete(release.output, [], 'after-reopen').ok, true);
    assert.equal(exportContextRecoveryRoot(restored, state.rootId).expiresAt, state.expiresAt);
    assert.deepEqual(copy(history), copy([...f.publicHistory, ...f.next.history]));
  } finally {
    f.sessions.close();
    restored?.close();
  }
});

test('successive private delta rounds preserve opaque blocks and branch positions after restart', async () => {
  const f = pendingFixture();
  let restored;
  try {
    assert.equal((await f.child.finishPublicationAsync()).ok, true);
    const next = f.sessions.begin(f.next, [{ callId: 'next-external', output: 'external-only' }]);
    const run = next.recovery({ input: f.next.history, previous_response_id: 'pending-mixed' });
    assert.equal(run.ok, true);
    const opaque = {
      type: 'reasoning',
      id: 'rs_private',
      encrypted_content: 'opaque-synthetic-exact',
      summary: [],
    };
    const privateCall = {
      type: 'function_call',
      id: 'fc_second_private',
      call_id: 'second-private',
      name: LIST,
      arguments: '{}',
    };
    const intermediate = run.accept({
      id: 'private-round',
      status: 'completed',
      output: [opaque, privateCall],
    });
    assert.equal(intermediate.mode, 'continue');
    const final = { type: 'message', role: 'assistant', id: 'msg_pure_final', content: [] };
    const release = run.accept({ id: 'pure-final', status: 'completed', output: [final] });
    assert.equal(release.mode, 'release');
    assert.equal(next.complete(release.output, [], 'pure-final').ok, true);
    const state = f.state();
    assert.equal(state.version, 10);
    assert.equal(state.history.format, 2);
    assert.equal(state.history.entries.length, 2);
    assert.equal(state.history.entries[0].offset, 3);
    assert.equal(state.history.entries[1].offset, 5);
    assert.ok(state.history.entries.every((entry) => entry.prefix.length === 0));
    assert.doesNotMatch(
      JSON.stringify(state.history),
      /external-only|原文🙂|"content":"synthetic"/
    );
    f.sessions.close();
    restored = restoreContextRecoverySessions({ now: f.clock }, [{ binding: f.request, state }]);
    const history = [...f.publicHistory, ...f.next.history, final, user('new question')];
    const child = restored.begin({ ...f.request, history });
    const recovery = child.recovery({ input: history, previous_response_id: null });
    assert.equal(recovery.ok, true);
    assert.equal(recovery.initialRequest.previous_response_id, null);
    const wire = recovery.initialRequest.input;
    assert.equal(
      wire.filter((item) => item.type === 'function_call' && item.call_id === 'private-list')
        .length,
      1
    );
    const privateIndex = wire.findIndex((item) => item.call_id === 'second-private');
    assert.deepEqual(copy(wire[privateIndex - 1]), opaque);
    assert.deepEqual(copy(wire[privateIndex]), privateCall);
    assert.equal(wire[privateIndex + 1].type, 'function_call_output');
    assert.equal(wire[privateIndex + 2].id, final.id);
    const edited = [...history];
    edited[0] = user('edited prefix');
    const isolated = restored.begin({ ...f.request, history: edited });
    assert.equal(isolated.inspect().visibleSources, 0);
    const isolatedRun = isolated.recovery({ input: edited });
    assert.equal(isolatedRun.ok, true);
    assert.deepEqual(copy(isolatedRun.initialRequest.input), copy(edited));
    isolated.abort();
    child.abort();
  } finally {
    f.sessions.close();
    restored?.close();
  }
});

test('legacy unknown private ancestry cannot become complete by capturing a later private fragment', async () => {
  const f = pendingFixture();
  let restored, reopened;
  try {
    assert.equal((await f.child.finishPublicationAsync()).ok, true);
    const old = copy(f.state());
    old.version = 5;
    old.binding.format = 2;
    old.ledger.policy.maxEntries = 64;
    old.ledger.policy.maxBytes = 4 * 1024 * 1024;
    delete old.history.format;
    old.history.entries = [];
    old.history.tips = [];
    old.history.version = 2;
    delete old.history.rootId;
    for (const snapshot of old.snapshots) {
      snapshot.mappingId = null;
      delete snapshot.privateHistoryComplete;
    }
    f.sessions.close();
    restored = restoreContextRecoverySessions({ now: f.clock }, [
      { binding: f.request, state: old },
    ]);
    const delta = restored.begin(f.next);
    const run = delta.recovery({ input: f.next.history, previous_response_id: 'pending-mixed' });
    assert.equal(run.ok, true);
    assert.equal(
      run.accept({
        id: 'later-private',
        status: 'completed',
        output: [{ type: 'function_call', call_id: 'later-private', name: LIST, arguments: '{}' }],
      }).mode,
      'continue'
    );
    const final = { type: 'message', role: 'assistant', id: 'msg_later', content: [] };
    const release = run.accept({ id: 'later-final', status: 'completed', output: [final] });
    assert.equal(release.mode, 'release');
    assert.equal(delta.complete(release.output, [], 'later-final').ok, true);
    const state = exportContextRecoveryRoot(restored, old.rootId);
    restored.close();
    reopened = restoreContextRecoverySessions({ now: f.clock }, [{ binding: f.request, state }]);
    const history = [...f.publicHistory, ...f.next.history, final, user('after reconnect')];
    const full = reopened.begin({ ...f.request, history });
    assert.equal(full.ok, true);
    assert.equal(
      full.recovery({ input: history }).code,
      'context_recovery_continuation_unsupported'
    );
    assert.ok(state.snapshots.every((snapshot) => snapshot.privateHistoryComplete === false));
    full.abort();
    const compact = reopened.beginCompaction({ ...f.request, history });
    assert.equal(compact.ok, true);
    const canonical = {
      id: 'private-reset',
      object: 'response.compaction',
      created_at: 1,
      output: [{ type: 'compaction', id: 'opaque-reset', encrypted_content: 'synthetic-reset' }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    assert.equal(compact.completeCompaction(canonical).ok, true);
    const reset = exportContextRecoveryRoot(reopened, old.rootId);
    assert.equal(reset.snapshots.at(-1).privateHistoryComplete, true);
    const resetOwner = restoreContextRecoverySessions({ now: f.clock }, [
      { binding: f.request, state: reset },
    ]);
    try {
      const resetHistory = [...canonical.output, user('after reset')];
      const next = resetOwner.begin({ ...f.request, history: resetHistory });
      const recovery = next.recovery({ input: resetHistory });
      assert.equal(recovery.ok, true);
      assert.deepEqual(copy(recovery.initialRequest.input), resetHistory);
      next.abort();
    } finally {
      resetOwner.close();
    }
  } finally {
    f.sessions.close();
    restored?.close();
    reopened?.close();
  }
});

test('private window checkpoints reject changed positions, hashes, linkage, accounting and format downgrade', async () => {
  const f = pendingFixture();
  try {
    assert.equal((await f.child.finishPublicationAsync()).ok, true);
    const state = f.state();
    for (const mutate of [
      (value) => {
        value.version = 5;
      },
      (value) => {
        value.snapshots[0].privateHistoryComplete = false;
      },
      (value) => {
        value.snapshots.at(-1).privateHistoryComplete = 'true';
      },
      (value) => {
        value.history.format = 1;
      },
      (value) => {
        value.history.entries[0].offset++;
      },
      (value) => {
        value.history.entries[0].window.scope = 'a'.repeat(64);
      },
      (value) => {
        value.history.entries[0].window.frontier = 'b'.repeat(64);
      },
      (value) => {
        value.history.entries[0].window.publishedFrontier = 'c'.repeat(64);
      },
      (value) => {
        value.history.entries[0].window.count++;
      },
      (value) => {
        value.history.entries[0].prefix = ['d'.repeat(64)];
      },
      (value) => {
        value.history.entries[0].bytes++;
      },
      (value) => {
        value.history.entries[0].window.count = 16385;
      },
      (value) => {
        value.history.entries[0].window = null;
      },
      (value) => {
        value.history.entries[0].tail[0].name = 'shell';
      },
      (value) => {
        value.snapshots.at(-1).mappingId = null;
      },
    ]) {
      const altered = copy(state);
      mutate(altered);
      assert.throws(
        () =>
          restoreContextRecoverySessions({ now: f.clock }, [
            { binding: f.request, state: altered },
          ]),
        fail
      );
    }
  } finally {
    f.sessions.close();
  }
});

test('a cumulative Responses window restores the latest authorized evidence view instead of its older ancestor', () => {
  const sessions = createContextRecoverySessions({ now: () => 100 });
  sessions.configure(true);
  const request = {
    principal: 'owner',
    protocol: 'responses',
    target: 'target',
    history: [user('initial')],
  };
  const external = {
    type: 'function_call',
    call_id: 'external',
    id: 'fc_external',
    name: 'lookup',
    arguments: '{}',
  };
  const first = sessions.begin(request);
  assert.equal(first.complete([external], [{ ...observed, arguments: {} }], 'first').ok, true);
  const text = 'cumulative exact original🙂\r\n';
  const delta = { type: 'function_call_output', call_id: 'external', output: text };
  const child = sessions.begin({ ...request, history: [delta], previousResponseId: 'first' }, [
    { callId: 'external', output: text },
  ]);
  const output = {
    type: 'message',
    role: 'assistant',
    id: 'msg_final',
    content: [{ type: 'output_text', text: 'done' }],
  };
  assert.equal(child.complete([output], [], 'second').ok, true);
  const state = exportContextRecoveryRoot(sessions, first.snapshotId);
  assert.equal(state.version, 10);
  assert.equal(state.binding.format, 3);
  assert.equal(state.binding.snapshots[1].window.count, 4);
  sessions.close();
  const restored = restoreContextRecoverySessions({ now: () => 200 }, [
    { binding: request, state },
  ]);
  try {
    const history = [...request.history, external, delta, output, user('after reconnect')];
    const next = restored.begin({ ...request, history });
    assert.equal(next.ok, true);
    assert.equal(next.inspect().visibleSources, 1);
    const source = list(next).sources[0];
    assert.equal(
      JSON.parse(next.reply(READ, { sourceId: source.sourceId, digest: source.digest }).text).page
        .text,
      text
    );
    assert.equal(exportContextRecoveryRoot(restored, state.rootId).expiresAt, state.expiresAt);
    const foreign = restored.begin({ ...request, principal: 'foreign', history });
    assert.equal(foreign.inspect().visibleSources, 0);
    assert.equal(
      foreign.reply(READ, { sourceId: source.sourceId, digest: source.digest }).ok,
      false
    );
    foreign.abort();
    next.abort();
  } finally {
    restored.close();
  }
});

test('pending read-only results validate data, exact keys, IDs, size and executable input without leaking content', () => {
  const value = [{ type: 'function_call_output', call_id: 'private', output: '原文🙂' }];
  const parsed = parseRecoveryPendingResults(value);
  assert.deepEqual(copy(parsed), value);
  parsed[0].output = 'changed';
  assert.equal(value[0].output, '原文🙂');
  assert.equal(pendingResultsBytes([]), 0);
  assert.equal(pendingResultsBytes(value), Buffer.byteLength(JSON.stringify(value)));
  assert.deepEqual(parseRecoveryPendingResults([]), []);
  const privateCall = { type: 'function_call', call_id: 'private', name: READ, arguments: '{}' };
  assert.doesNotThrow(() =>
    assertRebuiltPendingResults(value, [user('public')], [privateCall, ...value])
  );
  for (const [publicHistory, upstreamHistory] of [
    [[], []],
    [[], value],
    [[], [...value, privateCall]],
    [[], [privateCall, ...value, ...value]],
    [value, [privateCall, ...value]],
    [[], [privateCall, { ...value[0], output: 'changed' }]],
    [[null], [privateCall, ...value]],
    [[], [null]],
    [null, []],
    [[], null],
  ])
    assert.throws(() => assertRebuiltPendingResults(value, publicHistory, upstreamHistory));
  let executed = 0;
  const accessor = { type: 'function_call_output', call_id: 'private' };
  Object.defineProperty(accessor, 'output', {
    enumerable: true,
    get() {
      executed++;
      return 'private';
    },
  });
  for (const input of [
    null,
    {},
    [null],
    [accessor],
    [value[0], value[0]],
    [{ ...value[0], role: 'system' }],
    [{ ...value[0], output: null }],
    [{ ...value[0], call_id: '' }],
    [{ ...value[0], output: 'x'.repeat(MAX_PENDING_RESULTS_BYTES) }],
    Array.from({ length: 17 }, (_, i) => ({ ...value[0], call_id: 'call' + i })),
  ]) {
    assert.throws(
      () => parseRecoveryPendingResults(input),
      (error) => {
        assert.equal(error.message, 'Recovery pending results unavailable');
        assert.equal(error.cause, undefined);
        return true;
      }
    );
  }
  assert.equal(executed, 0);
});

test('pending rebuild admits trusted long histories while retaining private result and item boundaries', () => {
  const pending = [{ type: 'function_call_output', call_id: 'private', output: '原文🙂' }];
  const privateCall = { type: 'function_call', call_id: 'private', name: READ, arguments: '{}' };
  const history = Array.from({ length: 3 }, () => user('x'.repeat(900000)));
  const upstream = [...history, privateCall, ...pending];
  assert.doesNotThrow(() => assertRebuiltPendingResults(pending, history, upstream, 3));
  assert.doesNotThrow(() => assertRebuiltPendingResults([], [], [], 3));
  for (const format of [undefined, 2, 1, '3', null])
    assert.throws(() => assertRebuiltPendingResults(pending, history, upstream, format));
  for (const [publicItems, upstreamItems] of [
    [history, [...upstream, ...pending]],
    [[...history, ...pending], upstream],
    [history, [...history, privateCall, { ...pending[0], output: 'tampered' }]],
    [history, [...history, ...pending, privateCall]],
    [[null], upstream],
    [history, [null]],
    [[user('x'.repeat(MAX_PENDING_RESULTS_BYTES))], upstream],
    [Array.from({ length: 38 }, () => history[0]), upstream],
  ])
    assert.throws(() => assertRebuiltPendingResults(pending, publicItems, upstreamItems, 3));
  assert.throws(() =>
    assertRebuiltPendingResults(
      [{ ...pending[0], output: 'x'.repeat(MAX_PENDING_RESULTS_BYTES) }],
      history,
      upstream,
      3
    )
  );
  let executed = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'content', {
    enumerable: true,
    get() {
      executed++;
      return 'secret';
    },
  });
  const executable = {
    toJSON() {
      executed++;
      return user('secret');
    },
  };
  for (const item of [accessor, executable]) {
    assert.throws(() => assertRebuiltPendingResults(pending, [item], upstream, 3));
    assert.throws(() => assertRebuiltPendingResults(pending, history, [item], 3));
  }
  assert.equal(executed, 0);
});

test('pending results require finished publication and survive a new authorized owner without extending expiry', async () => {
  const f = pendingFixture();
  let restored;
  try {
    const early = f.sessions.begin(f.next);
    assert.equal(early.ok, true);
    assert.throws(() => early.readPendingResults(), /Recovery pending results unavailable/);
    early.abort();
    assert.equal((await f.child.finishPublicationAsync()).ok, true);
    const state = f.state();
    assert.equal(state.version, 10);
    assert.equal(state.expiresAt, state.createdAt + 86400000);
    assert.deepEqual(copy(state.snapshots.at(-1).pendingResults), copy(f.pending));
    f.sessions.close();
    restored = restoreContextRecoverySessions({ now: f.clock }, [{ binding: f.request, state }]);
    const child = restored.begin(f.next, [{ callId: 'next-external', output: 'external-only' }]);
    assert.equal(child.ok, true);
    assert.deepEqual(copy(child.readPendingResults()), copy(f.pending));
    const run = child.recovery({
      model: 'synthetic',
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
      previous_response_id: 'pending-mixed',
      input: f.next.history,
    });
    assert.equal(run.ok, true);
    assert.deepEqual(copy(run.initialRequest.input), [...copy(f.pending), ...f.next.history]);
    const other = restored.begin({ ...f.next, principal: 'other-owner' });
    assert.equal(other.ok, false);
    const unsupported = restored.begin(f.next);
    assert.equal(unsupported.ok, true);
    assert.equal(
      unsupported.recovery({
        model: 'synthetic',
        input: f.next.history,
        previous_response_id: 'pending-mixed',
        tool_choice: 'required',
      }).code,
      'context_recovery_continuation_unsupported'
    );
    unsupported.abort();
    assert.equal(exportContextRecoveryRoot(restored, state.rootId).expiresAt, state.expiresAt);
    f.setTime(state.expiresAt);
    assert.throws(() => child.readPendingResults());
  } finally {
    f.sessions.close();
    restored?.close();
  }
});

test('pending result schema refuses malformed, unready and downgraded records', async () => {
  const f = pendingFixture();
  try {
    assert.equal((await f.child.finishPublicationAsync()).ok, true);
    const state = f.state();
    for (const mutate of [
      (value) => {
        value.version = 3;
      },
      (value) => {
        value.snapshots.at(-1).pendingReady = 'true';
      },
      (value) => {
        value.snapshots.at(-1).pendingResults[0].type = 'message';
      },
      (value) => {
        value.snapshots.at(-1).pendingResults[0].call_id = '';
      },
      (value) => {
        value.snapshots.at(-1).pendingResults.push(value.snapshots.at(-1).pendingResults[0]);
      },
      (value) => {
        value.snapshots.at(-1).pendingResults[0].output = 'x'.repeat(MAX_PENDING_RESULTS_BYTES);
      },
      (value) => {
        value.snapshots[0].pendingResults = [
          {
            type: 'function_call_output',
            call_id: 'aggregate-first',
            output: 'x'.repeat(MAX_PENDING_RESULTS_BYTES / 2 + 1),
          },
        ];
        value.snapshots.at(-1).pendingResults[0].output = 'x'.repeat(
          MAX_PENDING_RESULTS_BYTES / 2 + 1
        );
      },
    ]) {
      const altered = copy(state);
      mutate(altered);
      assert.throws(
        () =>
          restoreContextRecoverySessions({ now: f.clock }, [
            { binding: f.request, state: altered },
          ]),
        fail
      );
    }
    const unready = copy(state);
    unready.snapshots.at(-1).pendingReady = false;
    const restored = restoreContextRecoverySessions({ now: f.clock }, [
      { binding: f.request, state: unready },
    ]);
    try {
      assert.throws(() => restored.begin(f.next).readPendingResults());
    } finally {
      restored.close();
    }
    // Old mixed ID continuations retained pending results but no private map.
    // Recreate that emitted shape explicitly; do not relabel a new map as old.
    const oldPending = copy(state);
    delete oldPending.history.format;
    oldPending.history.entries = [];
    oldPending.history.tips = [];
    for (const snapshot of oldPending.snapshots) snapshot.mappingId = null;
    const legacy = legacyRecoveryRoot(oldPending, 4);
    const restoredLegacy = restoreContextRecoverySessions({ now: f.clock }, [
      { binding: f.request, state: legacy },
    ]);
    try {
      assert.deepEqual(copy(restoredLegacy.begin(f.next).readPendingResults()), copy(f.pending));
      assert.equal(
        exportContextRecoveryRoot(restoredLegacy, state.rootId).expiresAt,
        legacy.expiresAt
      );
      assert.equal(legacy.expiresAt - legacy.createdAt, 1800000);
    } finally {
      restoredLegacy.close();
    }
  } finally {
    f.sessions.close();
  }
});

test('format 3 session history above 12 MiB restores exact evidence without upgrading old format 2 roots', () => {
  const history = Array.from({ length: 12 }, () => user('x'.repeat(1024 * 1024)));
  const basis = input(history);
  const sessions = createContextRecoverySessions({ now: () => 100 });
  sessions.configure(true);
  let restored, old;
  try {
    const first = sessions.begin(basis);
    assert.equal(first.ok, true);
    assert.equal(first.complete([tool], [observed], 'long-first').ok, true);
    const text = 'exact long-window evidence🙂';
    const child = sessions.begin(
      {
        ...basis,
        history: [...history, tool, { role: 'tool', tool_call_id: 'external', content: text }],
      },
      [{ callId: 'external', output: text }]
    );
    assert.equal(child.ok, true);
    assert.equal(child.complete([answer('saved')], [], 'long-saved').ok, true);
    const state = exportContextRecoveryRoot(sessions, first.snapshotId);
    assert.equal(state.binding.format, 3);
    assert.ok(state.binding.snapshots[0].bytes > 12 * 1024 * 1024);
    restored = restoreContextRecoverySessions({ now: () => 200 }, [
      { binding: basis, state: copy(state) },
    ]);
    const next = restored.begin({
      ...basis,
      history: [user('read')],
      previousResponseId: 'long-saved',
    });
    const source = list(next).sources[0];
    assert.equal(
      JSON.parse(next.reply(READ, { sourceId: source.sourceId, digest: source.digest }).text).page
        .text,
      text
    );
    assert.equal(exportContextRecoveryRoot(restored, state.rootId).expiresAt, state.expiresAt);
    const small = fixture();
    try {
      const legacy = small.state();
      legacy.binding.format = 2;
      old = restoreContextRecoverySessions({ now: small.clock }, [
        { binding: small.request, state: legacy },
      ]);
      assert.equal(
        old.begin(input(history, { previousResponseId: 'child-response' })).code,
        'invalid_context_binding'
      );
      assert.equal(exportContextRecoveryRoot(old, legacy.rootId).binding.format, 2);
    } finally {
      small.sessions.close();
    }
  } finally {
    sessions.close();
    restored?.close();
    old?.close();
  }
});

test('new recovery roots retain exact originals for 24 hours across reopening without renewal', () => {
  const f = fixture({ privateHistory: true });
  let restored;
  try {
    const state = f.state();
    assert.equal(state.version, 10);
    assert.equal(state.expiresAt, state.createdAt + 86400000);
    assert.equal(state.ledger.policy.ttlMs, 86400000);
    f.sessions.close();
    f.setTime(state.createdAt + 86399999);
    restored = restore(f, copy(state));
    const next = restored.begin(input([user('next')], { previousResponseId: 'child-response' }));
    assert.equal(next.reason, 'observed_continuation');
    const query = { sourceId: f.receipt.sourceId, digest: f.receipt.digest };
    const read = JSON.parse(next.reply(READ, query).text);
    assert.equal(read.page.text, f.text);
    assert.equal(exportContextRecoveryRoot(restored, state.rootId).expiresAt, state.expiresAt);
    f.setTime(state.expiresAt);
    assert.equal(next.reply(READ, query).ok, false);
    assert.throws(() => exportContextRecoveryRoot(restored, state.rootId));
  } finally {
    f.sessions.close();
    restored?.close();
  }
});

for (const version of [3, 4])
  test(`legacy v${version} 24 hour roots retain their deadline and unknown window completeness`, () => {
    const f = fixture({ privateHistory: true });
    let restored;
    try {
      const state = copy(f.state());
      state.version = version;
      state.history.version = 2;
      delete state.history.rootId;
      state.ledger.policy.maxEntries = 64;
      state.ledger.policy.maxBytes = 4 * 1024 * 1024;
      delete state.binding.format;
      for (const snapshot of state.binding.snapshots) delete snapshot.window;
      for (const snapshot of state.snapshots) delete snapshot.privateHistoryComplete;
      if (version === 3)
        for (const snapshot of state.snapshots) {
          delete snapshot.pendingResults;
          delete snapshot.pendingReady;
        }
      assert.equal(state.expiresAt - state.createdAt, 86400000);
      f.sessions.close();
      f.setTime(state.expiresAt - 1);
      restored = restore(f, state);
      const migrated = exportContextRecoveryRoot(restored, state.rootId);
      assert.equal(migrated.version, 6);
      assert.equal(migrated.binding.version, 2);
      assert.equal(migrated.expiresAt, state.expiresAt);
      for (const snapshot of migrated.binding.snapshots)
        assert.deepEqual(JSON.parse(JSON.stringify(snapshot.window)), {
          kind: 'unavailable',
          count: null,
        });
      const next = restored.begin(input([user('next')], { previousResponseId: 'child-response' }));
      const query = { sourceId: f.receipt.sourceId, digest: f.receipt.digest };
      const read = next.reply(READ, query);
      assert.equal(read.ok, true);
      assert.equal(JSON.parse(read.text).page.text, f.text);
      assert.equal(next.complete([answer('done')], [], `migrated-v${version}`).ok, true);
      assert.equal(exportContextRecoveryRoot(restored, state.rootId).expiresAt, state.expiresAt);
      f.setTime(state.expiresAt);
      assert.equal(next.reply(READ, query).ok, false);
      assert.throws(() => exportContextRecoveryRoot(restored, state.rootId));
    } finally {
      f.sessions.close();
      restored?.close();
    }
  });

for (const version of [1, 2])
  test(`legacy v${version} roots retain their original 30 minute deadline after restore and continuation`, () => {
    const f = fixture({ privateHistory: true });
    let restored;
    try {
      const state = legacyRecoveryRoot(f.state(), version);
      const { createRootCheckpoint } = require('../lib/proxy/context-recovery-root-checkpoint');
      const { createReferenceWrite } = require('../lib/proxy/context-recovery-reference-write');
      const reference = createReferenceWrite(createRootCheckpoint(state, []), null).reference;
      assert.equal(reference.metadata.sourceVersion, version);
      assert.equal(reference.metadata.expiresAt, state.expiresAt);
      f.sessions.close();
      f.setTime(state.expiresAt - 1);
      restored = restore(f, state);
      const next = restored.begin(input([user('next')], { previousResponseId: 'child-response' }));
      assert.equal(next.reason, 'observed_continuation');
      const result = next.reply(READ, { sourceId: f.receipt.sourceId, digest: f.receipt.digest });
      assert.equal(result.ok, true);
      assert.equal(JSON.parse(result.text).page.text, f.text);
      assert.equal(next.complete([answer('done')], [], 'legacy-next').ok, true);
      const after = exportContextRecoveryRoot(restored, state.rootId);
      assert.equal(after.version, 6);
      assert.equal(after.binding.version, 1);
      assert.equal(after.binding.format, 2);
      assert.equal(after.binding.snapshots[0].window.kind, 'unavailable');
      assert.equal(after.expiresAt, state.createdAt + 1800000);
      assert.equal(after.ledger.policy.ttlMs, 1800000);
      const fresh = restored.begin(input([user('independent-new-root')]));
      assert.equal(fresh.complete([answer('new')], [], 'new-response').ok, true);
      const newState = exportContextRecoveryRoot(restored, fresh.snapshotId);
      assert.equal(newState.version, 10);
      assert.equal(newState.expiresAt, state.expiresAt - 1 + 86400000);
      f.setTime(state.expiresAt);
      assert.equal(next.reply(LIST, {}).ok, false);
      assert.throws(() => exportContextRecoveryRoot(restored, state.rootId));
      assert.equal(
        exportContextRecoveryRoot(restored, fresh.snapshotId).expiresAt,
        newState.expiresAt
      );
    } finally {
      f.sessions.close();
      restored?.close();
    }
  });

test('retention versions reject relabelled deadlines, ledger mismatches and unsafe numbers atomically', () => {
  const f = fixture();
  try {
    for (const mutate of [
      (state) => {
        state.version = 2;
      },
      (state) => {
        state.expiresAt++;
      },
      (state) => {
        state.createdAt = Number.MAX_SAFE_INTEGER;
      },
      (state) => {
        state.expiresAt = Infinity;
      },
      (state) => {
        state.ledger.policy.ttlMs = 1800000;
      },
      (state) => {
        state.binding.version = 1;
      },
      (state) => {
        state.binding.version = 1;
        for (const snapshot of state.binding.snapshots)
          snapshot.expiresAt = snapshot.createdAt + 1800000;
      },
      (state) => {
        state.binding.snapshots[0].expiresAt = state.createdAt + 1800000;
      },
    ]) {
      const state = copy(f.state());
      mutate(state);
      assert.throws(() => restore(f, state), fail);
      assert.equal(f.child.inspect().active, true);
    }
    const legacy = legacyRecoveryRoot(f.state());
    legacy.version = 3;
    assert.throws(() => restore(f, legacy), fail);
  } finally {
    f.sessions.close();
  }
});

test('ledger retention admits the 24 hour boundary and rejects longer or malformed requests', () => {
  for (const ttlMs of [0, -1, 86400001, Number.MAX_SAFE_INTEGER, NaN, Infinity, '86400000', null])
    assert.throws(() => createContextEvidenceLedger({ owner: 'owner', threadId: 'thread', ttlMs }));
  const ledger = createContextEvidenceLedger({
    owner: 'owner',
    threadId: 'thread',
    ttlMs: 86400000,
  });
  try {
    assert.equal(exportContextEvidenceLedger(ledger).policy.ttlMs, 86400000);
  } finally {
    ledger.close();
  }
});

test('complete root roundtrip restores exact evidence, shared budget, branch identity and fresh capabilities', () => {
  const f = fixture();
  let restored;
  try {
    const page = JSON.parse(
      f.child.reply(READ, { sourceId: f.receipt.sourceId, digest: f.receipt.digest }).text
    );
    assert.equal(page.page.text, f.text);
    const state = f.state();
    assert.doesNotMatch(
      JSON.stringify(state),
      /private_original_arguments_marker|public_history_marker|locator/
    );
    assert.equal(state.snapshots[0].calls[0].argumentsDigest, sha(JSON.stringify(args)));
    assert.equal(state.snapshots[1].calls.length, 0);
    assert.equal(state.snapshots[1].captured.length, 1);
    assert.equal(state.budget.successfulReads, 1);
    f.sessions.close();
    f.setTime(200);
    restored = restore(f, copy(state));
    restored.configure(true); // Idempotence must not erase imported state.
    const next = restored.begin(input([user('next')], { previousResponseId: 'child-response' }));
    assert.equal(next.reason, 'observed_continuation');
    assert.equal(next.inspect().readers.calls, state.budget.calls);
    const result = JSON.parse(
      next.reply(READ, { sourceId: f.receipt.sourceId, digest: f.receipt.digest }).text
    );
    assert.equal(result.page.text, f.text);
    assert.equal(f.child.reply(LIST, {}).ok, false);
    const again = exportContextRecoveryRoot(restored, state.rootId);
    assert.equal(again.expiresAt, state.expiresAt);
    assert.equal(again.budget.calls, state.budget.calls + 1);
    assert.equal(again.ledger.sources[0].coveredThrough, Buffer.byteLength(f.text));
  } finally {
    f.sessions.close();
    restored?.close();
  }
});

test('legacy root restoration preserves lifetime spending instead of adopting task budgets', () => {
  const f = fixture();
  let restored;
  try {
    const state = f.state();
    state.budget = { version: 1, calls: 63, returnedBytes: 100, successfulReads: 0 };
    restored = restore(f, copy(state));
    const first = restored.begin(
      input([user('legacy-a')], { previousResponseId: 'child-response' })
    );
    const next = restored.begin(
      input([user('legacy-b')], { previousResponseId: 'child-response' })
    );
    assert.equal(first.reply(LIST, {}).ok, true);
    assert.equal(next.reply(LIST, {}).code, 'evidence_read_budget_exceeded');
    const saved = exportContextRecoveryRoot(restored, state.rootId);
    assert.equal(saved.budget.version, 1);
    assert.equal(saved.budget.calls, 64);
    assert.equal(saved.expiresAt, state.expiresAt);
  } finally {
    f.sessions.close();
    restored?.close();
  }
});

test('observation made before restore captures a future result using the original argument digest', () => {
  const sessions = createContextRecoverySessions({ now: () => 100 });
  sessions.configure(true);
  const first = sessions.begin(input());
  first.complete([tool], [observed], 'root-response');
  const state = exportContextRecoveryRoot(sessions, first.snapshotId);
  sessions.close();
  const restored = restoreContextRecoverySessions({ now: () => 200 }, [
    { binding: input(), state },
  ]);
  try {
    const child = restored.begin(continuation('future🙂'), [
      { callId: 'external', output: 'future🙂' },
    ]);
    const receipt = list(child).sources[0];
    assert.equal(receipt.argumentsDigest, sha(JSON.stringify(args)));
    assert.equal(
      JSON.parse(child.reply(READ, { sourceId: receipt.sourceId, digest: receipt.digest }).text)
        .page.text,
      'future🙂'
    );
    const rejected = restored.begin(continuation('Bearer abcdefghijklmnop'), [
      { callId: 'external', output: 'Bearer abcdefghijklmnop' },
    ]);
    assert.equal(list(rejected).sources.length, 0);
    child.abort();
    rejected.abort();
  } finally {
    restored.close();
  }
});

test('restored private history is injected only on its committed authorized branch', () => {
  const f = fixture({ privateHistory: true });
  let restored;
  try {
    const state = f.state();
    assert.equal(state.history.entries.length, 1);
    assert.equal(state.snapshots[1].mappingId, state.history.tips[0]);
    f.sessions.close();
    restored = restore(f, state);
    const history = [...f.request.history, ...f.output, user('after')];
    const next = restored.begin(input(history));
    const run = next.recovery({ model: 'synthetic', messages: history });
    assert.equal(run.ok, true);
    assert.ok(
      run.initialRequest.messages.some(
        (message) => message.role === 'tool' && message.content.includes(f.text)
      )
    );
    const sibling = restored.begin(
      input([user('sibling')], { previousResponseId: 'root-response' })
    );
    assert.equal(list(sibling).sources.length, 0);
    assert.equal(
      JSON.parse(
        sibling.reply(READ, { sourceId: f.receipt.sourceId, digest: f.receipt.digest }).text
      ).ok,
      false
    );
    run.cancel();
    sibling.abort();
  } finally {
    f.sessions.close();
    restored?.close();
  }
});

test('pending, aborted and withdrawn captures are excluded while spent budget and call quota survive', () => {
  const f = fixture();
  let restored;
  try {
    const pending = f.sessions.begin(continuation('pending_capture_marker'), [
      { callId: 'external', output: 'pending_capture_marker' },
    ]);
    const aborted = f.sessions.begin(continuation('aborted_capture_marker'), [
      { callId: 'external', output: 'aborted_capture_marker' },
    ]);
    aborted.abort();
    const withdrawn = f.sessions.begin(
      input([user('withdraw')], { previousResponseId: 'root-response' })
    );
    withdrawn.complete(
      [answer('withdraw')],
      [{ ...observed, callId: 'spent' }],
      'withdraw-response'
    );
    withdrawn.withdraw();
    const state = f.state();
    assert.equal(state.callCount, 2);
    assert.equal(state.snapshots.length, 2);
    assert.equal(state.ledger.sources.length, 1);
    assert.doesNotMatch(
      JSON.stringify(state),
      /pending_capture_marker|aborted_capture_marker|withdraw-response/
    );
    assert.ok(state.ledger.capturedCount > state.ledger.sources.length);
    restored = restore(f, state);
    assert.equal(exportContextRecoveryRoot(restored, state.rootId).callCount, 2);
    pending.abort();
  } finally {
    f.sessions.close();
    restored?.close();
  }
});

test('siblings retain distinct captures of the same ancestral call after root restore', () => {
  const f = fixture();
  let restored;
  try {
    const sibling = f.sessions.begin(continuation('sibling'), [
      { callId: 'external', output: 'sibling' },
    ]);
    const receipt = list(sibling).sources[0];
    sibling.complete([answer('other')], [], 'sibling-response');
    restored = restore(f);
    const a = restored.begin(input([user('a')], { previousResponseId: 'child-response' }));
    const b = restored.begin(input([user('b')], { previousResponseId: 'sibling-response' }));
    assert.equal(list(a).sources[0].sourceId, f.receipt.sourceId);
    assert.equal(list(b).sources[0].sourceId, receipt.sourceId);
    assert.equal(
      JSON.parse(a.reply(READ, { sourceId: receipt.sourceId, digest: receipt.digest }).text).ok,
      false
    );
    const conflict = restored.begin(
      input([user('changed')], { previousResponseId: 'child-response' }),
      [{ callId: 'external', output: 'changed' }]
    );
    assert.equal(conflict.code, 'context_recovery_source_conflict');
  } finally {
    f.sessions.close();
    restored?.close();
  }
});

test('invalid root associations fail atomically without changing the original live sessions', () => {
  const f = fixture();
  try {
    const mutations = [
      (s) => {
        s.version = 4;
      },
      (s) => {
        s.kind = 'other';
      },
      (s) => {
        s.principal = 'other';
      },
      (s) => {
        s.target = 'other';
      },
      (s) => {
        s.protocol = 'responses';
      },
      (s) => {
        s.policyFingerprint = 'a'.repeat(64);
      },
      (s) => {
        s.createdAt++;
      },
      (s) => {
        s.observedAt = s.expiresAt;
      },
      (s) => {
        s.observedAt = -1;
      },
      (s) => {
        s.binding.observedAt++;
      },
      (s) => {
        s.callCount = 0;
      },
      (s) => {
        s.callCount = 1025;
      },
      (s) => {
        s.rootId = 'hbs_' + 'a'.repeat(32);
      },
      (s) => {
        s.snapshots.pop();
      },
      (s) => {
        s.snapshots[0].id = s.snapshots[1].id;
      },
      (s) => {
        s.snapshots[1].calls.push(copy(s.snapshots[0].calls[0]));
      },
      (s) => {
        s.snapshots[0].calls[0].argumentsDigest = 'invalid';
      },
      (s) => {
        s.snapshots[0].calls[0].toolName = LIST;
      },
      (s) => {
        s.snapshots[1].captured[0].callId = 'unknown';
      },
      (s) => {
        s.snapshots[1].captured[0].sourceId = 'hce_' + 'a'.repeat(32);
      },
      (s) => {
        s.snapshots[1].visible = [];
      },
      (s) => {
        s.snapshots[0].visible.push(s.snapshots[1].visible[0]);
      },
      (s) => {
        s.ledger.sources[0].argumentsDigest = 'a'.repeat(64);
      },
      (s) => {
        s.ledger.sources[0].callId = 'different';
      },
      (s) => {
        s.ledger.sources[0].toolName = 'different';
      },
      (s) => {
        const source = s.ledger.sources[0];
        source.createdAt = 99;
        source.expiresAt = 99 + 30 * 60 * 1000;
      },
      (s) => {
        const source = s.ledger.sources[0];
        source.output = 'Bearer abcdefghijklmnop';
        source.bytes = Buffer.byteLength(source.output);
        source.digest = sha(source.output);
      },
      (s) => {
        s.snapshots[1].mappingId = 'hph_' + 'a'.repeat(32);
      },
      (s) => {
        s.budget.successfulReads = 1;
        s.budget.returnedBytes = 100;
      },
      (s) => {
        s.ledger.readCount = s.budget.calls + 1;
      },
      (s) => {
        s.extra = true;
      },
    ];
    for (const mutate of mutations) {
      const state = copy(f.state());
      mutate(state);
      assert.throws(() => restore(f, state), fail);
      assert.equal(f.child.inspect().active, true);
    }
    for (const extra of [{ principal: 'other' }, { target: 'other' }, { policy: 'other' }])
      assert.throws(
        () =>
          restoreContextRecoverySessions({ now: f.clock }, [
            { binding: input(undefined, extra), state: f.state() },
          ]),
        fail
      );
  } finally {
    f.sessions.close();
  }
});

test('private-history remapping cannot move a sibling tip or drop a committed association', () => {
  const f = fixture({ privateHistory: true });
  try {
    for (const mutate of [
      (s) => {
        s.snapshots[0].mappingId = s.snapshots[1].mappingId;
      },
      (s) => {
        s.snapshots[1].mappingId = null;
      },
      (s) => {
        s.history.entries[0].offset++;
      },
    ]) {
      const state = copy(f.state());
      mutate(state);
      assert.throws(() => restore(f, state), fail);
    }
  } finally {
    f.sessions.close();
  }
});

test('owner restore rejects accessors, executable values, sparse arrays and unsafe options without invoking them', () => {
  const f = fixture();
  let invoked = 0;
  const getter = () => {
    invoked++;
    return f.state();
  };
  try {
    const array = [];
    Object.defineProperty(array, '0', { get: getter, enumerable: true });
    const wrapper = { binding: input() };
    Object.defineProperty(wrapper, 'state', { get: getter, enumerable: true });
    const state = copy(f.state());
    Object.defineProperty(state, 'rootId', { get: getter, enumerable: true });
    for (const batch of [
      array,
      [wrapper],
      [{ binding: input(), state }],
      new Array(1),
      Object.assign([], { extra: 1 }),
      [null],
      null,
      {},
      [{ binding: input(), state: { toJSON: getter } }],
    ])
      assert.throws(() => restoreContextRecoverySessions({}, batch), fail);
    for (const options of [
      null,
      [],
      { now: 1 },
      { extra: 1 },
      Object.defineProperty({}, 'now', { get: getter, enumerable: true }),
    ])
      assert.throws(() => restoreContextRecoverySessions(options, []), fail);
    assert.equal(invoked, 0);
    assert.throws(() => exportContextRecoveryRoot({}, f.first.snapshotId), fail);
    assert.throws(() => exportContextRecoveryRoot(f.sessions, 'unknown'), fail);
    f.sessions.configure(false);
    assert.throws(() => f.state(), fail);
  } finally {
    f.sessions.close();
  }
});

test('restored clocks remain live, root TTL is absolute and revoked or closed sessions cannot export', () => {
  const f = fixture({ privateHistory: true });
  let restored;
  try {
    const state = f.state();
    f.setTime(99);
    assert.throws(() => restore(f, state), fail);
    f.setTime(200);
    restored = restore(f, state);
    f.setTime(300);
    assert.equal(exportContextRecoveryRoot(restored, state.rootId).observedAt, 300);
    f.setTime(state.expiresAt);
    assert.equal(restored.inspect().roots, 0);
    assert.throws(() => exportContextRecoveryRoot(restored, state.rootId), fail);
    const expired = restore(f, state);
    assert.equal(expired.inspect().roots, 0);
    expired.close();
    f.setTime(200);
    const revoked = restore(f, state);
    revoked.revoke('owner');
    assert.throws(() => exportContextRecoveryRoot(revoked, state.rootId), fail);
    revoked.close();
    assert.throws(() => exportContextRecoveryRoot(revoked, state.rootId), fail);
  } finally {
    f.sessions.close();
    restored?.close();
  }
});

test('batch restore preserves ambiguous aliases, four-root limit, duplicate rejection and empty admission', () => {
  const a = fixture(),
    b = fixture();
  let restored;
  try {
    const entries = [a, b].map((f) => ({ binding: input(), state: f.state() }));
    restored = restoreContextRecoverySessions({ now: () => 200 }, entries);
    const next = restored.begin(input([user('next')], { previousResponseId: 'child-response' }));
    assert.equal(next.reason, 'ambiguous_continuation');
    assert.equal(list(next).sources.length, 0);
    assert.throws(() => restoreContextRecoverySessions({}, [entries[0], entries[0]]), fail);
    assert.throws(() => restoreContextRecoverySessions({}, Array(5).fill(entries[0])), fail);
    const empty = restoreContextRecoverySessions({}, []);
    assert.equal(empty.inspect().roots, 0);
    assert.equal(empty.begin(input()).ok, true);
    empty.close();
  } finally {
    a.sessions.close();
    b.sessions.close();
    restored?.close();
  }
});

for (const protocol of ['responses', 'claude'])
  test(
    protocol +
      ': restored canonical continuation retains prospective evidence and native compaction identity',
    () => {
      const sessions = createContextRecoverySessions({ now: () => 100 });
      sessions.configure(true);
      const basis = input(undefined, { protocol });
      const first = sessions.begin(basis);
      const output =
        protocol === 'responses'
          ? [
              {
                type: 'function_call',
                id: 'fc-external',
                call_id: 'external',
                name: 'lookup',
                arguments: JSON.stringify(args),
              },
            ]
          : [
              {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'external', name: 'lookup', input: args }],
              },
            ];
      first.complete(output, [observed], 'native-root');
      const result =
        protocol === 'responses'
          ? [{ type: 'function_call_output', call_id: 'external', output: 'native🙂' }]
          : [
              {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'external', content: 'native🙂' }],
              },
            ];
      const history = [...basis.history, ...output, ...result];
      const child = sessions.begin({ ...basis, history }, [
        { callId: 'external', output: 'native🙂' },
      ]);
      child.complete(
        protocol === 'responses'
          ? [
              {
                type: 'message',
                id: 'msg-done',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'done' }],
              },
            ]
          : [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
        [],
        'native-child'
      );
      let nextHistory;
      if (protocol === 'responses') {
        const compactionHistory = [
          ...history,
          {
            type: 'message',
            id: 'msg-done',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'done' }],
          },
        ];
        const compact = sessions.beginCompaction({ ...basis, history: compactionHistory });
        nextHistory = [
          user('retained'),
          { type: 'compaction', id: 'compact', encrypted_content: 'opaque-do-not-edit' },
        ];
        assert.equal(
          compact.completeCompaction({
            id: 'compact-response',
            object: 'response.compaction',
            created_at: 1,
            output: nextHistory,
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }).ok,
          true
        );
      }
      const state = exportContextRecoveryRoot(sessions, first.snapshotId);
      sessions.close();
      const restored = restoreContextRecoverySessions({ now: () => 200 }, [
        { binding: basis, state },
      ]);
      try {
        const next = restored.begin({
          ...basis,
          history: nextHistory ?? [user('next')],
          ...(nextHistory ? {} : { previousResponseId: 'native-child' }),
        });
        assert.equal(next.reason, 'observed_continuation');
        const receipt = list(next).sources[0];
        assert.equal(
          JSON.parse(next.reply(READ, { sourceId: receipt.sourceId, digest: receipt.digest }).text)
            .page.text,
          'native🙂'
        );
        if (nextHistory) assert.equal(nextHistory[1].encrypted_content, 'opaque-do-not-edit');
      } finally {
        sessions.close();
        restored.close();
      }
    }
  );

test('inherited private mappings and new private descendants survive a second full-root roundtrip', () => {
  const f = fixture({ privateHistory: true });
  let restored, second;
  try {
    restored = restore(f);
    const history = [...f.request.history, ...f.output, user('second')];
    const child = restored.begin(input(history));
    const run = child.recovery({ model: 'synthetic', messages: history });
    assert.equal(
      run.accept(completion([{ id: 'hidden-second', name: LIST, args: {} }])).mode,
      'continue'
    );
    const released = run.accept(completion([], 'second-answer'));
    assert.equal(child.complete(released.output, [], 'second-response').ok, true);
    const state = exportContextRecoveryRoot(restored, f.first.snapshotId);
    assert.equal(state.history.entries.length, 2);
    const inheritedHistory = [...history, ...released.output, user('third')];
    const inherited = restored.begin(input(inheritedHistory));
    inherited.complete([answer('third')], [], 'third-response');
    const saved = exportContextRecoveryRoot(restored, state.rootId);
    assert.equal(saved.snapshots[2].mappingId, saved.snapshots[3].mappingId);
    second = restore(f, saved);
    const nextHistory = [...inheritedHistory, answer('third'), user('fourth')];
    const next = second.begin(input(nextHistory));
    const recovery = next.recovery({ model: 'synthetic', messages: nextHistory });
    assert.equal(recovery.ok, true);
    assert.equal(
      recovery.initialRequest.messages.filter((message) => message.role === 'tool').length,
      3
    );
    recovery.cancel();
  } finally {
    f.sessions.close();
    restored?.close();
    second?.close();
  }
});

test(
  'three individually bounded root states above 16 MiB aggregate restore without expanding per-root quotas',
  { timeout: 60000 },
  () => {
    const originals = [],
      entries = [];
    let restored;
    try {
      const text = String.fromCharCode(92).repeat(400 * 1024);
      for (let rootIndex = 0; rootIndex < 3; rootIndex++) {
        const sessions = createContextRecoverySessions({ now: () => 100 });
        sessions.configure(true);
        originals.push(sessions);
        const basis = input([user('large-' + rootIndex)]);
        const first = sessions.begin(basis);
        const calls = Array.from({ length: 7 }, (_, index) => ({
          ...observed,
          callId: 'call-' + index,
          arguments: {},
        }));
        const output = [
          {
            role: 'assistant',
            content: null,
            tool_calls: calls.map((call) => ({
              id: call.callId,
              type: 'function',
              function: { name: call.toolName, arguments: '{}' },
            })),
          },
        ];
        first.complete(output, calls, 'large-root-' + rootIndex);
        for (const call of calls) {
          const child = sessions.begin(
            {
              ...basis,
              history: [user('capture-' + call.callId)],
              previousResponseId: 'large-root-' + rootIndex,
            },
            [{ callId: call.callId, output: text }]
          );
          assert.equal(child.complete([answer('saved')], [], 'saved-' + call.callId).ok, true);
        }
        const state = exportContextRecoveryRoot(sessions, first.snapshotId);
        assert.ok(Buffer.byteLength(JSON.stringify(state)) < 12 * 1024 * 1024);
        entries.push({ binding: basis, state });
      }
      assert.ok(Buffer.byteLength(JSON.stringify(entries)) > 16 * 1024 * 1024);
      restored = restoreContextRecoverySessions({ now: () => 200 }, entries);
      assert.equal(restored.inspect().roots, 3);
      for (const { state } of entries) {
        const saved = exportContextRecoveryRoot(restored, state.rootId);
        assert.equal(saved.ledger.sources.length, 7);
        assert.equal(saved.ledger.sources[0].output, text);
        assert.equal(saved.ledger.policy.maxBytes, 16 * 1024 * 1024);
      }
    } finally {
      originals.forEach((sessions) => sessions.close());
      restored?.close();
    }
  }
);

test('version 8 shared private history supports more than 256 snapshot tips through export and restore', () => {
  const f = fixture({ privateHistory: true });
  let restored;
  try {
    for (let index = 0; index < 270; index++) {
      const child = f.sessions.begin(
        input([user('tip-' + index)], { previousResponseId: 'child-response' })
      );
      assert.equal(child.ok, true);
      assert.equal(child.complete([answer('done')], [], 'tip-' + index).ok, true);
    }
    const state = f.state();
    assert.ok(state.history.tips.length > 256);
    assert.ok(state.history.entries.length < 256);
    restored = restore(f, copy(state));
    assert.deepEqual(copy(exportContextRecoveryRoot(restored, state.rootId)), copy(state));
    const view = restored.begin(input([user('read')], { previousResponseId: 'tip-269' }));
    assert.equal(view.ok, true);
    assert.equal(
      JSON.parse(view.reply(READ, { sourceId: f.receipt.sourceId, digest: f.receipt.digest }).text)
        .page.text,
      f.text
    );
    view.abort();
  } finally {
    restored?.close();
    f.sessions.close();
  }
});

test('root reconstruction preserves the global 256 snapshot limit across individually legal roots', () => {
  const originals = [],
    entries = [];
  try {
    for (let rootIndex = 0; rootIndex < 4; rootIndex++) {
      const sessions = createContextRecoverySessions({ now: () => 100 });
      sessions.configure(true);
      originals.push(sessions);
      const basis = input([user('quota-' + rootIndex)]);
      const first = sessions.begin(basis);
      first.complete([{ ...answer('root'), id: 'anchored-' + rootIndex }], [], 'quota-root');
      for (let index = 0; index < 64; index++) {
        const child = sessions.begin({
          ...basis,
          history: [user('descendant-' + index)],
          previousResponseId: 'quota-root',
        });
        assert.equal(child.complete([answer('done')], [], 'quota-' + index).ok, true);
      }
      entries.push({
        binding: basis,
        state: exportContextRecoveryRoot(sessions, first.snapshotId),
      });
    }
    assert.equal(
      entries.reduce((count, entry) => count + entry.state.snapshots.length, 0),
      260
    );
    const expanded = restoreContextRecoverySessions({ now: () => 200 }, entries);
    assert.equal(expanded.inspect().roots, 4);
    expanded.close();
    for (const entry of entries) {
      entry.state.version = 6;
      entry.state.ledger.policy.maxEntries = 64;
      entry.state.ledger.policy.maxBytes = 4 * 1024 * 1024;
    }
    assert.throws(() => restoreContextRecoverySessions({ now: () => 200 }, entries), fail);
  } finally {
    originals.forEach((sessions) => sessions.close());
  }
});

test('argument policy remains enforced before metadata-only observations can be committed', () => {
  const sessions = createContextRecoverySessions({ now: () => 100 });
  sessions.configure(true);
  try {
    const first = sessions.begin(input());
    assert.throws(() => exportContextRecoveryRoot(sessions, first.snapshotId), fail);
    for (const argumentsValue of [
      { token: 'synthetic-private-value' },
      { path: 'C:/.codex/sessions/old.jsonl' },
      { query: 'transcript_path' },
    ])
      assert.equal(
        first.complete([tool], [{ ...observed, arguments: argumentsValue }]).code,
        'invalid_recovery_calls'
      );
    assert.equal(first.complete([tool], [observed], 'safe-response').ok, true);
    assert.equal(exportContextRecoveryRoot(sessions, first.snapshotId).callCount, 1);
    for (const now of [
      () => NaN,
      () => -1,
      () => Number.MAX_SAFE_INTEGER,
      () => {
        throw Error('private-marker');
      },
    ]) {
      let error;
      try {
        restoreContextRecoverySessions({ now }, []);
      } catch (caught) {
        error = caught;
      }
      assert.equal(error.code, fail.code);
      assert.doesNotMatch(String(error), /private-marker/);
      assert.equal(error.cause, undefined);
    }
  } finally {
    sessions.close();
  }
});

test('owner-only digest capture preserves ledger validation, duplicate conflicts, quotas and closure', () => {
  const ledger = createContextEvidenceLedger({
    owner: 'o',
    threadId: 't',
    now: () => 100,
    maxEntries: 1,
    maxBytes: 1024,
    maxOutputBytes: 1024,
  });
  const source = {
    callId: 'call',
    toolName: 'lookup',
    argumentsDigest: sha('{}'),
    output: '',
    completed: true,
  };
  try {
    const receipt = captureObservedContextEvidence(ledger, source);
    assert.deepEqual(captureObservedContextEvidence(ledger, source), receipt);
    assert.equal(exportContextEvidenceLedger(ledger).sources[0].argumentsDigest, sha('{}'));
    assert.throws(() => captureObservedContextEvidence(ledger, { ...source, output: 'changed' }), {
      code: 'evidence_source_conflict',
    });
    assert.throws(() => captureObservedContextEvidence(ledger, { ...source, callId: 'other' }), {
      code: 'evidence_ledger_quota',
    });
    for (const value of [
      null,
      {},
      { ...source, completed: false },
      { ...source, output: 1 },
      { ...source, argumentsDigest: 'BAD' },
      { ...source, toolName: '' },
      { ...source, output: '\ud800' },
      { ...source, output: 'a'.repeat(1025) },
      { ...source, arguments: {} },
    ])
      assert.throws(() => captureObservedContextEvidence(ledger, value));
    assert.throws(() => captureObservedContextEvidence({}, source));
    ledger.close();
    assert.throws(() => captureObservedContextEvidence(ledger, source), {
      code: 'evidence_ledger_closed',
    });
  } finally {
    ledger.close();
  }
});

test(
  'actual encrypted worker preserves private delta fragments across closing every owner',
  { timeout: 120000 },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-private-window-test-'));
    const f = pendingFixture({ now: Date.now });
    let storage, restored;
    try {
      const storageOptions = { directory: path.join(directory, 'context') };
      if (process.platform !== 'win32') {
        await assert.rejects(openContextRecoveryStorage(storageOptions), {
          code: 'context_recovery_storage_unavailable',
        });
        return;
      }
      assert.equal((await f.child.finishPublicationAsync()).ok, true);
      const state = f.state();
      storage = await openContextRecoveryStorage(storageOptions);
      await storage.execute({
        operation: 'save',
        scope: 'f'.repeat(64),
        expectedRevision: 0,
        expiresAt: state.expiresAt,
        state,
      });
      f.sessions.close();
      await storage.close();
      storage = undefined;
      storage = await openContextRecoveryStorage(storageOptions);
      const saved = await storage.execute({ operation: 'load', scope: 'f'.repeat(64) });
      restored = restoreContextRecoverySessions({ now: Date.now }, [
        { binding: f.request, state: saved.state },
      ]);
      const history = [...f.publicHistory, ...f.next.history];
      const next = restored.begin({ ...f.request, history });
      const run = next.recovery({ input: history });
      assert.equal(run.ok, true);
      const privateResult = run.initialRequest.input.filter(
        (item) => item.type === 'function_call_output' && item.call_id === f.pending[0].call_id
      );
      assert.deepEqual(copy(privateResult), copy(f.pending));
      assert.equal(exportContextRecoveryRoot(restored, state.rootId).expiresAt, state.expiresAt);
      next.abort();
    } finally {
      f.sessions.close();
      restored?.close();
      try {
        await storage?.close();
      } finally {
        const resolved = path.resolve(directory);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('hpm-private-window-test-'));
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    }
  }
);

test(
  'actual encrypted worker reopen reconstructs a fresh complete session with exact evidence and private history',
  { timeout: 120000 },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-root-state-test-'));
    const f = fixture({ privateHistory: true, now: Date.now });
    let storage, restored;
    try {
      if (process.platform !== 'win32') {
        await assert.rejects(
          openContextRecoveryStorage({ directory: path.join(directory, 'context') }),
          { code: 'context_recovery_storage_unavailable' }
        );
        return;
      }
      const state = f.state(),
        storeScope = 'e'.repeat(64);
      storage = await openContextRecoveryStorage({ directory: path.join(directory, 'context') });
      await storage.execute({
        operation: 'save',
        scope: storeScope,
        expectedRevision: 0,
        expiresAt: state.expiresAt,
        state,
      });
      f.sessions.close();
      await storage.close();
      storage = undefined;
      storage = await openContextRecoveryStorage({ directory: path.join(directory, 'context') });
      const saved = await storage.execute({ operation: 'load', scope: storeScope });
      restored = restore(f, saved.state);
      const history = [...f.request.history, ...f.output, user('after')];
      const next = restored.begin(input(history));
      assert.equal(next.inspect().readers.calls, state.budget.calls);
      const page = JSON.parse(
        next.reply(READ, { sourceId: f.receipt.sourceId, digest: f.receipt.digest }).text
      );
      assert.equal(page.page.text, f.text);
      const run = next.recovery({ model: 'synthetic', messages: history });
      assert.equal(run.ok, true);
      assert.ok(
        run.initialRequest.messages.some(
          (message) => message.role === 'tool' && message.content.includes(f.text)
        )
      );
      assert.equal(exportContextRecoveryRoot(restored, state.rootId).expiresAt, state.expiresAt);
      run.cancel();
    } finally {
      f.sessions.close();
      restored?.close();
      try {
        await storage?.close();
      } finally {
        const resolved = path.resolve(directory);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('hpm-root-state-test-'));
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    }
  }
);

test('recovery state clone rejects nested and revoked proxies before structural traps', () => {
  let traps = 0;
  const handler = {
    getPrototypeOf(target) {
      traps++;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      traps++;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      traps++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    get(target, key) {
      traps++;
      return Reflect.get(target, key);
    },
  };
  const object = new Proxy({ data: 'synthetic' }, handler);
  const array = new Proxy(['synthetic'], handler);
  const revoked = Proxy.revocable({}, handler);
  revoked.revoke();
  for (const value of [object, array, revoked.proxy]) {
    for (const input of [
      value,
      { nested: value },
      [value],
      { version: 10, root: { nested: value } },
    ]) {
      assert.throws(() => normalizeRecoveryStateData(input), {
        message: 'invalid_context_recovery_state_data',
      });
    }
  }
  for (const value of [object, array, revoked.proxy]) {
    assert.throws(() => normalizeRecoveryCheckpointData({ root: { version: 10, nested: value } }), {
      message: 'invalid_context_recovery_state_data',
    });
    const { normalizeRecoveryReferenceData } = require('../lib/proxy/context-recovery-state-data');
    assert.throws(
      () =>
        normalizeRecoveryReferenceData({
          metadata: { kind: 'recovery-root-metadata', sourceVersion: 10, nested: value },
        }),
      { message: 'invalid_context_recovery_state_data' }
    );
  }
  assert.equal(traps, 0);
});
