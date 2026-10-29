'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createContextCompactionEnvelopeStore,
  normalizeCompactionData,
  LOCAL_COMPACTION_PREFIX,
} = require('../lib/proxy/context-compaction-envelope');

const binding = {
  owner: 'owner',
  provider: 'workbuddy-wbipc',
  model: 'hy4-preview-f',
  endpoint: 'host:443/v2',
};
const window = [
  { type: 'message', role: 'user', content: '保留原文🙂', unknown: { exact: ['原值', 42] } },
];
const invalid = (fn, code = 'invalid_local_compaction') => assert.throws(fn, { code });

test('normalization never serializes primitive originals or a complete data tree', () => {
  const input = { output: '\u0000\b\t\n\f\r"\\🙂\ud800', values: [null, false, -0, 1e100] };
  const stringify = JSON.stringify;
  const expected = stringify(input);
  let result;
  try {
    JSON.stringify = () => assert.fail('normalization must count without serialization');
    result = normalizeCompactionData(input, 1024);
  } finally {
    JSON.stringify = stringify;
  }
  assert.equal(stringify(result), expected);
});

test('short metadata cannot evict repeated large text from request-local byte accounting', (t) => {
  const body = 'large-body-'.repeat(2048);
  const input = {
    metadata: Array.from({ length: 128 }, (_, index) => `entry-${index}`),
    body: Array(8).fill(body),
  };
  const expected = JSON.stringify(input);
  const size = Buffer.byteLength(expected);
  const original = RegExp.prototype.test;
  let scans = 0;
  t.mock.method(RegExp.prototype, 'test', function (value) {
    if (value === body) scans++;
    return Reflect.apply(original, this, [value]);
  });
  assert.equal(JSON.stringify(normalizeCompactionData(input, size)), expected);
  assert.equal(scans, 1, 'large text is scanned once despite preceding short identifiers');
  assert.equal(JSON.stringify(normalizeCompactionData(input, size)), expected);
  assert.equal(scans, 2, 'a separate parse must validate again');
  invalid(() => normalizeCompactionData(input, size - 1));
});

test('repeated large escaped text is charged for every occurrence after short metadata', () => {
  for (const body of ['"\\\n\u0000'.repeat(1024), '原文🙂\ud800\udc00\ud800'.repeat(1024)]) {
    const input = {
      metadata: Array.from({ length: 128 }, (_, index) => `entry-${index}`),
      body: Array(8).fill(body),
    };
    const expected = JSON.stringify(input);
    const size = Buffer.byteLength(expected);
    assert.equal(JSON.stringify(normalizeCompactionData(input, size)), expected);
    invalid(() => normalizeCompactionData(input, size - 1));
  }
});

test('large text memo retains bounded entries and a shared raw-byte cap', (t) => {
  const original = RegExp.prototype.test;
  let watched;
  let scans = 0;
  t.mock.method(RegExp.prototype, 'test', function (value) {
    if (value === watched) scans++;
    return Reflect.apply(original, this, [value]);
  });
  for (const values of [
    Array.from({ length: 65 }, (_, index) => `${index}${'x'.repeat(1024)}`),
    Array.from({ length: 4 }, (_, index) => `${index}${'x'.repeat(1024 * 1024)}`),
  ]) {
    watched = values.at(-1);
    scans = 0;
    const input = [...values, watched];
    const expected = JSON.stringify(input);
    const size = Buffer.byteLength(expected);
    assert.equal(JSON.stringify(normalizeCompactionData(input, size)), expected);
    assert.equal(scans, 2, 'text beyond an entry or byte cap must be scanned again');
    invalid(() => normalizeCompactionData(input, size - 1));
  }
});

test('normalization counts actual array bytes without invoking inherited JSON hooks', () => {
  const previous = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  let hooks = 0;
  let result;
  Object.defineProperty(Array.prototype, 'toJSON', {
    configurable: true,
    get() {
      hooks++;
      return () => null;
    },
  });
  try {
    result = normalizeCompactionData(['exact'], 9);
    invalid(() => normalizeCompactionData(['exact'], 8));
  } finally {
    if (previous) Object.defineProperty(Array.prototype, 'toJSON', previous);
    else delete Array.prototype.toJSON;
  }
  assert.equal(hooks, 0);
  assert.deepEqual(result, ['exact']);
});

test('normalization rejects a sparse array disguised by an out-of-range numeric key', () => {
  for (const key of ['4294967295', '9007199254740991']) {
    const input = [];
    input.length = 1;
    Object.defineProperty(input, key, { value: 'hidden', enumerable: true });
    invalid(() => normalizeCompactionData(input, 1024));
  }
});

test('normalization retains exact JSON byte admission across primitive and nested boundaries', () => {
  for (const input of [
    null,
    true,
    false,
    0,
    -0,
    1e100,
    '',
    'ascii',
    '原文🙂',
    '\ud800',
    '\udc00',
    '\u0000\n\r\t"\\',
    '\u0080\u2028\u2029',
    [],
    {},
    [null, false, -0],
    { 'escaped"key': ['原文🙂', { nested: '\ud800' }] },
    { one: 'x'.repeat(600000), two: 'x'.repeat(600000) },
    Array.from({ length: 129 }, (_, index) => `distinct-${index}`),
    Array.from({ length: 5 }, (_, index) => `${index}${'x'.repeat(1024 * 1024)}`),
    Array.from({ length: 65536 }, (_, index) => String.fromCharCode(index)).join(''),
  ]) {
    const size = Buffer.byteLength(JSON.stringify(input));
    assert.equal(JSON.stringify(normalizeCompactionData(input, size)), JSON.stringify(input));
    if (size > 1) invalid(() => normalizeCompactionData(input, size - 1));
  }
});

test('normalized records preserve own data descriptors without invoking inherited setters', () => {
  const input = JSON.parse(
    '{"__proto__":{"exact":"原文🙂"},"constructor":null,"prototype":false,"nested":{"value":42}}'
  );
  const array = Array.from({ length: 1025 }, (_, index) => index);
  const name = 'normalizer_inherited_setter_fixture';
  Object.defineProperty(input, name, { value: 'exact', enumerable: true });
  let invoked = 0;
  assert.equal(Object.hasOwn(Object.prototype, name), false);
  assert.equal(Object.hasOwn(Array.prototype, '1024'), false);
  Object.defineProperty(Object.prototype, name, {
    configurable: true,
    set() {
      invoked++;
    },
  });
  Object.defineProperty(Array.prototype, '1024', {
    configurable: true,
    set() {
      invoked++;
    },
  });
  let result, copiedArray;
  try {
    result = normalizeCompactionData(input, 16384);
    copiedArray = normalizeCompactionData(array, 16384);
  } finally {
    delete Object.prototype[name];
    delete Array.prototype[1024];
  }
  assert.equal(invoked, 0);
  assert.equal(JSON.stringify(result), JSON.stringify(input));
  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal(Object.getPrototypeOf(result.__proto__), null);
  assert.equal(Object.getPrototypeOf(result.nested), null);
  for (const key of Object.keys(result))
    assert.deepEqual(Object.getOwnPropertyDescriptor(result, key), {
      value: result[key],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  assert.deepEqual(Object.getOwnPropertyDescriptor(copiedArray, '1024'), {
    value: 1024,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  result.__proto__.exact = 'changed';
  result.nested.value = 0;
  assert.equal(input.__proto__.exact, '原文🙂');
  assert.equal(input.nested.value, 42);
  assert.deepEqual(copiedArray, array);
});

test('server-issued evidence metadata is privately bound, cloned, quota-accounted and never derived from a window marker', () => {
  const store = createContextCompactionEnvelopeStore({ now: () => 1000 });
  const receipt = {
    kind: 'local_compaction_evidence',
    locator: 'hca_' + 'a'.repeat(32),
    scope: 'hcs_' + 'b'.repeat(32),
    digest: 'c'.repeat(64),
    bytes: 100,
  };
  try {
    const plain = store.issue(window, binding);
    const baseBytes = store.stats().retainedBytes;
    assert.equal(store.readState(plain, binding).evidenceReceipts, undefined);
    const token = store.issue(window, binding, [], [receipt]);
    assert.equal(
      store.stats().retainedBytes - baseBytes * 2,
      Buffer.byteLength(JSON.stringify([receipt]))
    );
    receipt.bytes = 0;
    const state = store.readState(token, binding);
    assert.equal(state.evidenceReceipts[0].bytes, 100);
    state.evidenceReceipts[0].digest = 'changed';
    assert.equal(store.readState(token, binding).evidenceReceipts[0].digest, 'c'.repeat(64));
    invalid(() => store.readState(token, { ...binding, model: 'other' }));
    const copied = store.issue(
      [
        {
          role: 'assistant',
          content: JSON.stringify({ evidenceReceipts: state.evidenceReceipts }),
        },
      ],
      binding
    );
    assert.equal(store.readState(copied, binding).evidenceReceipts, undefined);
    const valid = store.readState(token, binding).evidenceReceipts[0];
    let accessed = false;
    const getter = Object.defineProperty({}, 'kind', {
      enumerable: true,
      get() {
        accessed = true;
        return 'local_compaction_evidence';
      },
    });
    for (const input of [
      null,
      {},
      [null],
      [getter],
      Array(257).fill(valid),
      [{ ...valid, kind: 'other' }],
      [{ ...valid, locator: '../' }],
      [{ ...valid, digest: 'bad' }],
      [{ ...valid, scope: 'other' }],
      [{ ...valid, bytes: 0 }],
      [{ ...valid, bytes: 3 * 1024 * 1024 }],
      [{ ...valid, extra: true }],
    ])
      invalid(() => store.issue(window, binding, [], input));
    assert.equal(accessed, false);
    assert.equal(store.stats().entries, 3);
  } finally {
    store.close();
  }
});

test('local state is authenticated encrypted, independently identified, bound and exactly replayable', () => {
  const store = createContextCompactionEnvelopeStore();
  try {
    const token = store.issue(window, binding);
    assert.ok(token.startsWith(LOCAL_COMPACTION_PREFIX));
    assert.ok(!token.includes('原文'));
    const decoded = store.read(token, binding);
    assert.deepEqual(JSON.parse(JSON.stringify(decoded)), window);
    decoded[0].content = 'changed';
    assert.equal(store.read(token, binding)[0].content, window[0].content);
    for (const field of Object.keys(binding))
      invalid(() => store.read(token, { ...binding, [field]: binding[field] + '-other' }));
    invalid(() => store.read(token.slice(0, -4) + 'AAAA', binding));
    invalid(() => store.read('native-encrypted-state', binding));
    assert.equal(store.stats().entries, 1);
    store.discard(token, { ...binding, owner: 'other' });
    assert.equal(store.stats().entries, 1);
    store.discard(token, binding);
    assert.equal(store.stats().entries, 0);
    invalid(() => store.read(token, binding));
  } finally {
    store.close();
  }
});

test('expiry is fixed, clock rollback invalidates state, restart and close fail closed', () => {
  let current = 100;
  const store = createContextCompactionEnvelopeStore({ now: () => current, ttlMs: 100 });
  const token = store.issue(window, binding);
  current = 199;
  assert.equal(store.read(token, binding)[0].content, window[0].content);
  current = 200;
  invalid(() => store.read(token, binding));
  assert.equal(store.stats().retainedBytes, 0);
  const fresh = store.issue(window, binding);
  current = 199;
  invalid(() => store.read(fresh, binding), 'local_compaction_clock_invalid');
  current = 201;
  invalid(() => store.read(fresh, binding));
  const other = createContextCompactionEnvelopeStore({ now: () => current });
  invalid(() => other.read(store.issue(window, binding), binding));
  other.close();
  store.close();
  assert.deepEqual(store.stats(), { entries: 0, retainedBytes: 0, closed: true });
  invalid(() => store.issue(window, binding), 'local_compaction_closed');
  invalid(() => store.read(token, binding), 'local_compaction_closed');
});

test('entry, owner and global quotas reject without evicting committed state', () => {
  for (const options of [{ maxEntries: 1 }, { maxOwnerBytes: 500 }, { maxBytes: 500 }]) {
    const store = createContextCompactionEnvelopeStore(options);
    try {
      const token = store.issue(window, binding);
      const before = store.stats();
      invalid(() => store.issue(window, binding), 'local_compaction_quota');
      assert.deepEqual(store.stats(), before);
      assert.equal(store.read(token, binding)[0].content, window[0].content);
      if (options.maxOwnerBytes) assert.ok(store.issue(window, { ...binding, owner: 'other' }));
    } finally {
      store.close();
    }
  }
});

test('authenticated call lineage is private, independently cloned and charged against owner/global quota', () => {
  const digest = 'a'.repeat(64);
  const sourceIds = [digest];
  const store = createContextCompactionEnvelopeStore();
  try {
    const plain = store.issue(window, binding);
    const plainBytes = store.stats().retainedBytes;
    store.discard(plain, binding);
    const token = store.issue(window, binding, sourceIds);
    assert.equal(store.stats().retainedBytes - plainBytes, 66);
    assert.ok(!Buffer.from(token.split(':')[1], 'base64url').includes(Buffer.from(digest)));
    sourceIds.pop();
    const state = store.readState(token, binding);
    assert.deepEqual(state.callIdDigests, [digest]);
    state.callIdDigests.pop();
    assert.deepEqual(store.readState(token, binding).callIdDigests, [digest]);
    for (const limits of [{ maxOwnerBytes: plainBytes + 65 }, { maxBytes: plainBytes + 65 }]) {
      const limited = createContextCompactionEnvelopeStore(limits);
      try {
        invalid(() => limited.issue(window, binding, [digest]), 'local_compaction_quota');
        assert.equal(limited.stats().entries, 0);
        assert.ok(limited.issue(window, binding));
      } finally {
        limited.close();
      }
    }
    assert.throws(() => store.issue(window, binding, ['invalid']), {
      code: 'invalid_context_call_lineage',
    });
    assert.equal(store.stats().entries, 1);
    invalid(() => store.readState(token, { ...binding, owner: 'other' }));
    store.discard(token, binding);
    assert.equal(store.stats().retainedBytes, 0);
  } finally {
    store.close();
  }
});

test('unknown data boundary rejects empty, invalid, oversized and executable values without hooks', () => {
  const store = createContextCompactionEnvelopeStore({ maxWindowBytes: 1024 });
  let hooks = 0;
  const getter = Object.defineProperty({}, 'content', {
    enumerable: true,
    get() {
      hooks++;
      return 'secret';
    },
  });
  const cyclic = {};
  cyclic.self = cyclic;
  const sparse = [];
  sparse.length = 1000000;
  const deep = {};
  let tail = deep;
  for (let index = 0; index < 66; index++) {
    tail.next = {};
    tail = tail.next;
  }
  try {
    for (const data of [
      undefined,
      NaN,
      Infinity,
      new Date(),
      cyclic,
      sparse,
      getter,
      deep,
      {
        toJSON() {
          hooks++;
          return 'secret';
        },
      },
      { content: '🙂'.repeat(1024) },
    ])
      invalid(() => normalizeCompactionData(data, 1024));
    for (const data of [
      [],
      [null],
      ['text'],
      [{ type: 'compaction', encrypted_content: 'foreign' }],
    ])
      invalid(() => store.issue(data, binding));
    invalid(() => store.issue([getter], binding));
    invalid(() => store.issue(window, { ...binding, owner: 'bad\nowner' }));
    invalid(() => store.issue(window, { ...binding, extra: true }));
    invalid(() => normalizeCompactionData(window, 0));
    invalid(() =>
      createContextCompactionEnvelopeStore({
        get ttlMs() {
          hooks++;
          return 100;
        },
      })
    );
    invalid(() => createContextCompactionEnvelopeStore({ maxEntries: 0 }));
    assert.equal(hooks, 0);
    assert.equal(store.stats().entries, 0);
  } finally {
    store.close();
  }
});

test('compaction and recovery data reject root, array, nested and revoked proxies before any trap', () => {
  const { storageData } = require('../lib/proxy/context-recovery-storage-contract');
  let hooks = 0;
  const handler = {
    getPrototypeOf(target) {
      hooks++;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      hooks++;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      hooks++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    get(target, key, receiver) {
      hooks++;
      return Reflect.get(target, key, receiver);
    },
  };
  const record = new Proxy({ synthetic: true }, handler);
  const array = new Proxy(['synthetic'], handler);
  const revoked = Proxy.revocable({}, handler);
  revoked.revoke();
  for (const input of [
    record,
    array,
    { nested: record },
    [array],
    { nested: revoked.proxy },
    revoked.proxy,
  ]) {
    invalid(() => normalizeCompactionData(input, 1024));
    invalid(() => storageData(input, 1024), 'context_recovery_storage_unavailable');
  }
  assert.equal(hooks, 0);
  const plain = Object.assign(Object.create(null), { synthetic: ['原文🙂', '', null, false, 0] });
  assert.equal(JSON.stringify(normalizeCompactionData(plain, 1024)), JSON.stringify(plain));
  assert.equal(JSON.stringify(storageData(plain, 1024)), JSON.stringify(plain));
});
