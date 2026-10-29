'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const {
  parseBindingWindow,
  selectBindingWindow,
  publishBindingWindow,
} = require('../lib/proxy/context-binding-window');
const { createContextBindingRegistry } = require('../lib/proxy/context-binding');
const {
  canonicalBindingData,
  createCanonicalBindingEncoder,
  createCanonicalBindingFingerprint,
} = require('../lib/proxy/context-public-window');
const { createBindingFrontierCache } = require('../lib/proxy/context-binding-frontiers');
const crypto = require('node:crypto');
const { createHash, Hash } = crypto;
const {
  normalizeRecoveryHistoryRequest,
  recoveryHistoryRequestBytes,
  recoveryHistoryRequestLimit,
  enableRecoveryHistoryDigestReuse,
  isReusableRecoveryHistory,
} = require('../lib/proxy/context-recovery-history-request');
const {
  exportContextBindingRegistry,
  restoreContextBindingRegistry,
} = require('../lib/proxy/context-binding');

const user = (content) => ({ role: 'user', content });
const assistant = (content) => ({ role: 'assistant', id: 'msg_' + content, content });
const request = (history = [user('question')], extra = {}) => ({
  principal: 'principal-a',
  protocol: 'responses',
  target: 'target-a',
  history,
  ...extra,
});

function countedBindingFrontiers(failAt) {
  const filename = path.resolve(__dirname, '../lib/proxy/context-binding-frontiers.js');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = loaded.require.bind(loaded);
  let calls = 0;
  loaded.require = (name) => {
    const dependency = originalRequire(name);
    if (name !== './context-public-window') return dependency;
    return {
      ...dependency,
      createCanonicalBindingFingerprint() {
        const fingerprint = dependency.createCanonicalBindingFingerprint();
        return (value) => {
          if (++calls === failAt) throw new Error('synthetic_fingerprint_failure');
          return fingerprint(value);
        };
      },
    };
  };
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  return { cache: loaded.exports.createBindingFrontierCache(), calls: () => calls };
}

const frontierBasis = { scope: 'a'.repeat(64), continuityScope: 'b'.repeat(64), protocol: 'chat' };

function reusableHistoryRequest(input) {
  const normalized = normalizeRecoveryHistoryRequest(input, 3);
  enableRecoveryHistoryDigestReuse(normalized);
  return normalized;
}

test('history reuse is opt-in for completed immutable normalizer results and invokes no hooks', () => {
  const history = [{ role: 'user', content: [{ text: 'q' }] }];
  const normalized = normalizeRecoveryHistoryRequest(request(history), 3);
  assert.equal(isReusableRecoveryHistory(normalized.history), false);
  enableRecoveryHistoryDigestReuse(normalized);
  assert.equal(isReusableRecoveryHistory(normalized.history), true);
  assert.equal(Object.isFrozen(normalized.history), true);
  assert.equal(Object.isFrozen(normalized.history[0].content[0]), true);
  for (const value of [
    null,
    undefined,
    '',
    1,
    Symbol('history'),
    normalized,
    history,
    Object.freeze(history.slice()),
    normalized.history[0].content,
  ])
    assert.equal(isReusableRecoveryHistory(value), false);
  let hooks = 0;
  const hostile = Object.defineProperty([], '0', {
    enumerable: true,
    get() {
      hooks++;
      throw Error('unexpected_hook');
    },
  });
  const wrapped = new Proxy(normalized.history, {
    get() {
      hooks++;
      throw Error('unexpected_hook');
    },
  });
  assert.equal(isReusableRecoveryHistory(hostile), false);
  assert.equal(isReusableRecoveryHistory(wrapped), false);
  for (const value of [null, undefined, '', 1, Symbol('request'), {}, request()])
    assert.throws(() => enableRecoveryHistoryDigestReuse(value), /invalid_context_history_request/);
  assert.throws(() => enableRecoveryHistoryDigestReuse(hostile));
  assert.throws(() => enableRecoveryHistoryDigestReuse(wrapped));
  assert.throws(() => normalizeRecoveryHistoryRequest(request(hostile), 3));
  assert.equal(hooks, 0);
});

test('validated immutable history reuses item digests across repeated admission without retaining authority', () => {
  const input = reusableHistoryRequest(request([user('q'), user('continue')]));
  const counted = countedBindingFrontiers();
  const initial = counted.cache.calculate({ ...frontierBasis, history: input.history });
  assert.equal(counted.calls(), 2);
  assert.deepEqual(counted.cache.calculate({ ...frontierBasis, history: input.history }), initial);
  assert.equal(counted.calls(), 2);
  const differentScope = { ...frontierBasis, scope: 'c'.repeat(64) };
  const scoped = counted.cache.calculate({ ...differentScope, history: input.history });
  assert.notEqual(scoped.frontier, initial.frontier);
  assert.deepEqual(
    scoped,
    createBindingFrontierCache().calculate({ ...differentScope, history: input.history })
  );
  assert.equal(counted.calls(), 2);
  counted.cache.clear();
  assert.deepEqual(counted.cache.calculate({ ...frontierBasis, history: input.history }), initial);
  assert.equal(counted.calls(), 4);
});

test('fresh external history, protocol changes and frozen unbranded arrays are fully fingerprinted', () => {
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }] },
    user('continue'),
  ];
  const counted = countedBindingFrontiers();
  const input = reusableHistoryRequest(request(history));
  const initial = counted.cache.calculate({ ...frontierBasis, history: input.history });
  const fresh = normalizeRecoveryHistoryRequest(request(history), 3);
  assert.notEqual(fresh.history, input.history);
  assert.deepEqual(counted.cache.calculate({ ...frontierBasis, history: fresh.history }), initial);
  assert.equal(counted.calls(), 4);
  assert.deepEqual(counted.cache.calculate({ ...frontierBasis, history: fresh.history }), initial);
  assert.equal(counted.calls(), 6);
  const claude = counted.cache.calculate({
    ...frontierBasis,
    protocol: 'claude',
    history: input.history,
  });
  assert.notEqual(claude.frontier, initial.frontier);
  assert.equal(counted.calls(), 8);
  assert.deepEqual(counted.cache.calculate({ ...frontierBasis, history: input.history }), initial);
  assert.equal(counted.calls(), 10);
  const frozen = Object.freeze(history.slice());
  counted.cache.calculate({ ...frontierBasis, history: frozen });
  counted.cache.calculate({ ...frontierBasis, history: frozen });
  assert.equal(counted.calls(), 14);
  history[1].content = 'changed';
  const changed = normalizeRecoveryHistoryRequest(request(history), 3);
  assert.notEqual(
    counted.cache.calculate({ ...frontierBasis, history: changed.history }).frontier,
    initial.frontier
  );
  assert.equal(counted.calls(), 16);
  assert.equal(input.history[1].content, 'continue');
});

test('immutable history digest reuse keeps the 4096-item bound and never stores a partial calculation', () => {
  for (const length of [0, 4096, 4097]) {
    const input = reusableHistoryRequest(request(Array.from({ length }, () => user('q'))));
    const counted = countedBindingFrontiers();
    counted.cache.calculate({ ...frontierBasis, history: input.history });
    counted.cache.calculate({ ...frontierBasis, history: input.history });
    assert.equal(counted.calls(), length <= 4096 ? length : length * 2);
  }
  const input = reusableHistoryRequest(request([user('a'), user('b')]));
  const counted = countedBindingFrontiers(2);
  assert.throws(
    () => counted.cache.calculate({ ...frontierBasis, history: input.history }),
    /synthetic_fingerprint_failure/
  );
  const completed = counted.cache.calculate({ ...frontierBasis, history: input.history });
  assert.equal(counted.calls(), 4);
  assert.deepEqual(
    counted.cache.calculate({ ...frontierBasis, history: input.history }),
    completed
  );
  assert.equal(counted.calls(), 4);
});

test('immutable history keeps at most four retained digest vectors even when old request arrays remain alive', () => {
  const requests = Array.from({ length: 5 }, (_, index) =>
    reusableHistoryRequest(request([user('request-' + index)]))
  );
  const counted = countedBindingFrontiers();
  for (const input of requests)
    counted.cache.calculate({ ...frontierBasis, history: input.history });
  assert.equal(counted.calls(), 5);
  counted.cache.calculate({ ...frontierBasis, history: requests[0].history });
  assert.equal(counted.calls(), 6);
  counted.cache.calculate({ ...frontierBasis, history: requests[4].history });
  counted.cache.calculate({ ...frontierBasis, history: requests[4].history });
  assert.equal(counted.calls(), 6);
});

test('single-element history arrays retain exact bytes, independent frozen slots and shared limits', () => {
  const history = [{ role: 'user', content: [{ text: 'é🙂\ud800\r\n', nested: [false] }] }];
  const input = request(history);
  const result = normalizeRecoveryHistoryRequest(input, 3);
  assert.equal(JSON.stringify(result), JSON.stringify(input));
  assert.equal(recoveryHistoryRequestBytes(result), Buffer.byteLength(JSON.stringify(input)));
  assert.equal(Object.isFrozen(result.history[0].content), true);
  assert.equal(Object.isFrozen(result.history[0].content[0].nested), true);
  assert.equal(Object.getPrototypeOf(result.history[0].content[0]), null);
  assert.deepEqual(Object.getOwnPropertyDescriptor(result.history[0].content, '0'), {
    value: result.history[0].content[0],
    enumerable: true,
    writable: false,
    configurable: false,
  });
  history[0].content[0].nested[0] = true;
  assert.equal(result.history[0].content[0].nested[0], false);
  let deep = null;
  for (let index = 0; index < 61; index++) deep = [deep];
  assert.ok(normalizeRecoveryHistoryRequest(request([{ role: 'user', content: deep }]), 3));
  assert.throws(() =>
    normalizeRecoveryHistoryRequest(request([{ role: 'user', content: [deep] }]), 3)
  );
});

test('single-element history arrays reject hooks, disguised holes, cycles and encoded byte overflow', () => {
  let invoked = 0;
  const get = () => {
    invoked++;
    throw new Error('unexpected input hook');
  };
  const cyclic = [];
  cyclic[0] = cyclic;
  const inputs = [
    Object.defineProperty([], '0', { get, enumerable: true }),
    Object.defineProperty([], '0', { value: null, enumerable: false }),
    Object.assign(Array(1), { extra: null }),
    Object.defineProperty([null], Symbol.iterator, { get }),
    cyclic,
    ['x'.repeat(2 * 1024 * 1024)],
  ];
  for (const content of inputs)
    assert.throws(() => normalizeRecoveryHistoryRequest(request([{ role: 'user', content }]), 3));
  assert.equal(invoked, 0);
});

test('single-element history arrays define own slots without inherited index-zero setters', () => {
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const assert = require('node:assert/strict');
    const { normalizeRecoveryHistoryRequest } = require(${JSON.stringify(require.resolve('../lib/proxy/context-recovery-history-request'))});
    const input = { principal: 'a', protocol: 'chat', target: 'b', history: [{ role: 'user', content: [{ text: 'exact', values: [null] }] }] };
    assert.equal(Object.hasOwn(Array.prototype, '0'), false);
    const toolInput = { ...input, history: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }] };
    let invoked = 0, result, toolResult;
    try {
      Object.defineProperty(Array.prototype, '0', { configurable: true, set() { invoked++; } });
      result = normalizeRecoveryHistoryRequest(input, 3);
      toolResult = normalizeRecoveryHistoryRequest(toolInput, 3);
    } finally {
      delete Array.prototype[0];
    }
    assert.equal(invoked, 0);
    assert.equal(JSON.stringify(result), JSON.stringify(input));
    assert.equal(Object.hasOwn(result.history[0].content, '0'), true);
    assert.equal(Object.hasOwn(result.history[0].content[0].values, '0'), true);
    assert.equal(Object.isFrozen(result.history[0].content[0].values), true);
    assert.equal(JSON.stringify(toolResult), JSON.stringify(toolInput));
    assert.equal(Object.hasOwn(toolResult.history[0].tool_calls, '0'), true);
    assert.equal(Object.isFrozen(toolResult.history[0].tool_calls), true);
  `,
    ],
    { encoding: 'utf8', timeout: 10000, windowsHide: true }
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
});

test('history request arrays cannot invoke inherited numeric setters or lose validated items', () => {
  const histories = [
    Array.from({ length: 1025 }, (_, index) => user('exact-' + index)),
    [{ role: 'user', content: Array.from({ length: 1025 }, (_, index) => 'exact-' + index) }],
  ];
  for (const history of histories) {
    let invoked = 0;
    let normalized;
    assert.equal(Object.hasOwn(Array.prototype, '1024'), false);
    try {
      Object.defineProperty(Array.prototype, '1024', {
        configurable: true,
        set() {
          invoked++;
        },
      });
      normalized = normalizeRecoveryHistoryRequest(request(history), 3);
    } finally {
      delete Array.prototype[1024];
    }
    assert.equal(invoked, 0);
    assert.equal(JSON.stringify(normalized.history), JSON.stringify(history));
    assert.equal(Object.isFrozen(normalized.history), true);
    const array = history.length === 1 ? normalized.history[0].content : normalized.history;
    assert.equal(Object.hasOwn(array, '1024'), true);
    assert.equal(Object.isFrozen(array), true);
  }
});

test('history construction ignores inherited iterators and never admits a partial failed request', () => {
  let touched = 0;
  const input = request([user('first'), user('last')]);
  let normalized;
  assert.equal(Object.hasOwn(Object.prototype, Symbol.iterator), false);
  try {
    Object.defineProperty(Object.prototype, Symbol.iterator, {
      configurable: true,
      get() {
        touched++;
        throw new Error('unexpected_iterator');
      },
    });
    normalized = normalizeRecoveryHistoryRequest(input, 3);
  } finally {
    delete Object.prototype[Symbol.iterator];
  }
  assert.equal(touched, 0);
  assert.equal(JSON.stringify(normalized.history), JSON.stringify(input.history));
  assert.equal(Object.isFrozen(normalized.history), true);
  const empty = normalizeRecoveryHistoryRequest(request([]), 3);
  assert.equal(empty.history.length, 0);
  assert.equal(Object.isFrozen(empty.history), true);
  Object.defineProperty(input.history, '1', {
    configurable: true,
    enumerable: true,
    get() {
      touched++;
      throw new Error('unexpected_history_getter');
    },
  });
  assert.throws(() => normalizeRecoveryHistoryRequest(input, 3), {
    message: 'invalid_context_history_request',
  });
  assert.equal(touched, 0);
  Object.defineProperty(input.history, '1', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: user('repaired'),
  });
  const repaired = normalizeRecoveryHistoryRequest(input, 3);
  assert.equal(repaired.history[1].content, 'repaired');
  assert.equal(normalized.history[1].content, 'last');
  assert.equal(recoveryHistoryRequestBytes(repaired), Buffer.byteLength(JSON.stringify(repaired)));
});

test('expiry housekeeping retains per-call clock checks and immediate rollback/withdraw revocation', () => {
  let time = 100;
  const registry = createContextBindingRegistry({ now: () => time });
  try {
    const first = registry.begin(request());
    const output = assistant('expiry');
    assert.equal(registry.commit(first.token, [output], 'expiry-response').ok, true);
    time++;
    const child = registry.begin(
      request([user('question'), output, user('next')], { previousResponseId: 'expiry-response' })
    );
    assert.equal(child.parentSnapshotId, first.snapshotId);
    assert.equal(registry.rollback(child.token), true);
    assert.equal(registry.commit(child.token, [assistant('late')]).ok, false);
    assert.deepEqual(registry.withdraw(first.token), [first.snapshotId]);
    assert.equal(registry.commit(first.token, [assistant('late')]).ok, false);
    const fresh = registry.begin(request());
    assert.equal(registry.commit(fresh.token, [assistant('new')], 'fresh').ok, true);
    time = 100 + 1800000;
    assert.equal(registry.inspect().snapshots, 1);
    time++;
    assert.equal(registry.inspect().snapshots, 0);
    assert.equal(registry.commit(fresh.token, [assistant('late')]).ok, false);
    const live = registry.begin(request());
    time--;
    assert.equal(registry.commit(live.token, [assistant('backward clock')]).ok, false);
    assert.equal(registry.inspect().closed, true);
  } finally {
    registry.close();
  }
});

test('canonical scalar encoding preserves every UTF-16 code unit and surrogate boundary', () => {
  const encode = createCanonicalBindingEncoder();
  for (let unit = 0; unit <= 0xffff; unit++) {
    const value = String.fromCharCode(unit);
    assert.equal(encode(value), JSON.stringify(value), 'UTF-16 unit ' + unit);
  }
  for (const value of [
    '',
    'plain ASCII',
    '中文\u0085\u2028\u2029',
    '\ud800\udc00',
    '\udbff\udfff',
    '\ud800x\udfff',
    '\ud800\ud800\udc00\udc00',
    'quote" slash\\ newline\n',
    'x'.repeat(4 * 1024 * 1024 + 1),
  ]) {
    assert.equal(encode(value), JSON.stringify(value));
    assert.equal(encode(value), JSON.stringify(value));
  }
});

test('canonical scalar encoding keeps nested binding fingerprints exact after cache saturation', () => {
  const encode = createCanonicalBindingEncoder();
  const fingerprint = createCanonicalBindingFingerprint();
  const values = [
    null,
    false,
    -0,
    [],
    {},
    { 10: 'ten', 2: 'two', nested: ['中文', 'x\u0000\ud800', true] },
    ...Array.from({ length: 130 }, (_, index) => ({
      role: 'tool',
      content: String(index % 10).repeat(32768),
      tool_call_id: 'call-' + index,
    })),
  ];
  for (const value of [...values, ...values]) {
    const expected = canonicalBindingData(value);
    assert.equal(encode(value), expected);
    assert.equal(fingerprint(value), createHash('sha256').update(expected).digest('hex'));
  }
});

test('canonical fingerprint prefix reuse preserves exact binding bytes and cache bounds', () => {
  const fingerprint = createCanonicalBindingFingerprint();
  const values = [
    null,
    false,
    -0,
    1e25,
    'é🙂\ud800',
    [],
    {},
    { 10: 'ten', 2: 'two', nested: [1, false, null, { x: '\u0000"\\' }] },
    { content: 'x'.repeat(2 * 1024 * 1024), role: 'tool', tool_call_id: 'a' },
    { content: 'x'.repeat(2 * 1024 * 1024), role: 'tool', tool_call_id: 'b' },
    { content: 'y'.repeat(4 * 1024 * 1024 + 1) },
    ...Array.from({ length: 130 }, (_, index) => ({ content: 'prefix-' + index, tail: index })),
  ];
  for (const value of [...values, ...values])
    assert.equal(
      fingerprint(value),
      createHash('sha256').update(canonicalBindingData(value)).digest('hex')
    );
});

test('request-local completed fingerprints reuse exact small messages without hiding changes', () => {
  const fingerprint = createCanonicalBindingFingerprint();
  const expected = createHash('sha256')
    .update(canonicalBindingData(user('continue')))
    .digest('hex');
  const digest = Hash.prototype.digest;
  const hash = crypto.hash;
  let calls = 0;
  try {
    if (typeof hash === 'function')
      crypto.hash = function (...args) {
        calls++;
        return hash.apply(this, args);
      };
    Hash.prototype.digest = function (...options) {
      calls++;
      return digest.apply(this, options);
    };
    assert.equal(fingerprint(user('continue')), expected);
    assert.equal(fingerprint({ content: 'continue', role: 'user' }), expected);
    assert.equal(calls, 1);
    assert.notEqual(fingerprint(user('changed')), expected);
    assert.equal(calls, 2);
    assert.equal(createCanonicalBindingFingerprint()(user('continue')), expected);
    assert.equal(calls, 3);
    for (let index = 0; index < 130; index++) fingerprint(user('unique-' + index));
    const count = calls;
    fingerprint(user('unique-129'));
    assert.equal(calls, count + 1);
    fingerprint(user('continue'));
    assert.equal(calls, count + 1);
    const large = user('x'.repeat(4096));
    fingerprint(large);
    fingerprint(large);
    assert.equal(calls, count + 3);
  } finally {
    Hash.prototype.digest = digest;
    crypto.hash = hash;
  }
});

test('small canonical fingerprints use one-shot SHA-256 and retain an identical older-runtime fallback', () => {
  const original = crypto.hash;
  const vectors = [
    user(''),
    user('é🙂\ud800\u0000"\\'),
    {
      content: null,
      role: 'assistant',
      tool_calls: [{ id: 'a', function: { name: 'lookup', arguments: '{}' } }],
    },
    { 2: 'two', 10: 'ten', nested: [false, null, -0, { a: true }] },
    user('x'.repeat(4096)),
  ];
  const expected = vectors.map((value) =>
    createHash('sha256').update(canonicalBindingData(value)).digest('hex')
  );
  let calls = 0;
  try {
    crypto.hash = (algorithm, value, encoding) => {
      calls++;
      return createHash(algorithm).update(value).digest(encoding);
    };
    const fingerprint = createCanonicalBindingFingerprint();
    assert.deepEqual(vectors.map(fingerprint), expected);
    assert.ok(calls > 0, 'small canonical messages must use the single native hash operation');
    const beforeRepeat = calls;
    assert.equal(fingerprint(vectors[0]), expected[0]);
    assert.equal(
      calls,
      beforeRepeat,
      'the existing request-local small-message cache remains bounded and useful'
    );
    crypto.hash = undefined;
    assert.deepEqual(vectors.map(createCanonicalBindingFingerprint()), expected);
  } finally {
    crypto.hash = original;
  }
});

test('frontier memo distinguishes four same-policy conversations and validates edits before reuse', () => {
  const cache = createBindingFrontierCache();
  const basis = { scope: 'a'.repeat(64), continuityScope: 'b'.repeat(64), protocol: 'chat' };
  const histories = Array.from({ length: 4 }, (_, index) => [
    user('conversation-' + index),
    { role: 'tool', content: 'x'.repeat(32768), tool_call_id: 'tool' },
  ]);
  const reference = (history, seeds) => {
    let frontier = seeds?.frontier ?? basis.scope;
    let continuityFrontier = seeds?.continuityFrontier ?? basis.continuityScope;
    const prefixes = [],
      continuityPrefixes = [];
    for (const item of history) {
      const encoded = canonicalBindingData(item);
      frontier = createHash('sha256')
        .update(frontier + '\0' + encoded)
        .digest('hex');
      continuityFrontier = createHash('sha256')
        .update(continuityFrontier + '\0' + encoded)
        .digest('hex');
      prefixes.push(frontier);
      continuityPrefixes.push(continuityFrontier);
    }
    return { frontier, continuityFrontier, prefixes, continuityPrefixes };
  };
  for (const history of histories)
    assert.deepEqual(cache.calculate({ ...basis, history }), reference(history));
  const update = Hash.prototype.update;
  let largeChainUpdates = 0;
  try {
    Hash.prototype.update = function (value, ...options) {
      if (Buffer.isBuffer(value) && value.length > 1024) largeChainUpdates++;
      return update.call(this, value, ...options);
    };
    for (const history of histories)
      assert.deepEqual(cache.calculate({ ...basis, history }), reference(history));
  } finally {
    Hash.prototype.update = update;
  }
  assert.equal(largeChainUpdates, 0);
  const edited = [...histories[0], user('appended')];
  assert.deepEqual(cache.calculate({ ...basis, history: edited }), reference(edited));
  edited[1] = { ...edited[1], content: 'changed' };
  assert.deepEqual(cache.calculate({ ...basis, history: edited }), reference(edited));
  const seeds = { frontier: 'c'.repeat(64), continuityFrontier: 'd'.repeat(64) };
  assert.deepEqual(cache.calculate({ ...basis, history: edited, seeds }), reference(edited, seeds));
  assert.deepEqual(cache.calculate({ ...basis, history: [] }), reference([]));
  const oversized = Array(4097).fill(user('bounded'));
  assert.deepEqual(cache.calculate({ ...basis, history: oversized }), reference(oversized));
  cache.clear();
  assert.deepEqual(cache.calculate({ ...basis, history: edited }), reference(edited));
});

test('history request normalization preserves JSON data, exact byte limits and immutable reuse', () => {
  for (const format of [2, 3]) {
    const maximum = recoveryHistoryRequestLimit(format);
    const source = request(Array.from({ length: 32 }, () => user('')));
    const overhead = Buffer.byteLength(JSON.stringify(source));
    let remaining = maximum - overhead;
    for (const item of source.history) {
      const count = Math.min(1024 * 1024, remaining);
      item.content = 'x'.repeat(count);
      remaining -= count;
    }
    assert.equal(remaining, 0);
    const normalized = normalizeRecoveryHistoryRequest(source, format);
    assert.equal(recoveryHistoryRequestBytes(normalized), maximum);
    assert.equal(normalizeRecoveryHistoryRequest(normalized, format), normalized);
    assert.ok(
      Object.isFrozen(normalized) &&
        Object.isFrozen(normalized.history) &&
        Object.isFrozen(normalized.history[0])
    );
    assert.throws(() => {
      normalized.history[0].content = 'changed';
    });
    source.history[31].content += 'x';
    assert.throws(() => normalizeRecoveryHistoryRequest(source, format));
    if (format === 3) assert.throws(() => normalizeRecoveryHistoryRequest(normalized, 2));
  }
  const input = request([user('🙂\r\n\u0000"\\')], {
    policy: { a: [0, -0, null, false, { 2: 2, 10: 10 }] },
  });
  const normalized = normalizeRecoveryHistoryRequest(input, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(normalized)), JSON.parse(JSON.stringify(input)));
  assert.equal(recoveryHistoryRequestBytes(normalized), Buffer.byteLength(JSON.stringify(input)));
  assert.throws(() => {
    normalized.policy.a[4]['2'] = 99;
  });
  assert.throws(() => recoveryHistoryRequestBytes(input));
  assert.equal(normalizeRecoveryHistoryRequest(request([]), 3).history.length, 0);
  const empty = request([], { policy: '' });
  const { history: _history, ...metadata } = empty;
  empty.policy = 'x'.repeat(2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(metadata)));
  assert.throws(() => normalizeRecoveryHistoryRequest(empty, 2));
});

test('history item byte admission and bounded canonical encoding preserve JSON including repeated and uncached text', () => {
  const vectors = [
    { content: 'reordered', role: 'tool', tool_call_id: 'a' },
    { role: 'tool', tool_call_id: 'b', content: null },
    { role: 'tool', content: 'text', tool_call_id: 'c' },
    { role: 'user', content: [null, true, false, 0, -0, 1e300, 1e-10, [], {}] },
    JSON.parse('{"role":"user","content":{"10":"a","2":"b","__proto__":"c","":"\\ud800"}}'),
    ...Array.from({ length: 200 }, (_, index) => user('uncached-' + index)),
    ...Array.from({ length: 6 }, (_, index) => user(String(index).repeat(1024 * 1024))),
  ];
  const input = request(vectors);
  const data = normalizeRecoveryHistoryRequest(input, 3);
  assert.equal(recoveryHistoryRequestBytes(data), Buffer.byteLength(JSON.stringify(input)));
  assert.deepEqual(JSON.parse(JSON.stringify(data)), JSON.parse(JSON.stringify(input)));
  const encode = createCanonicalBindingEncoder();
  for (const item of [...data.history, ...data.history])
    assert.equal(encode(item), canonicalBindingData(item));
  for (const item of [
    user(NaN),
    user(Infinity),
    user(undefined),
    user(1n),
    user(Array(1)),
    user({
      toJSON() {
        throw Error('must not execute');
      },
    }),
    Object.defineProperty({ role: 'user' }, 'content', { value: 'hidden' }),
    user(Object.create({ inherited: true })),
  ])
    assert.throws(() => normalizeRecoveryHistoryRequest(request([item]), 3));
});

test('history admission counts unescaped long text without allocating a JSON copy, including after cache saturation', (t) => {
  const texts = [
    'x'.repeat(32768),
    '中文é'.repeat(8192),
    '\u2028\u2029'.repeat(8192),
    '\u007f\u0080\u009f'.repeat(8192),
    '🙂'.repeat(8192),
  ];
  const input = request([
    ...Array.from({ length: 160 }, (_, index) => user('saturate-' + index)),
    ...texts.flatMap((text) => [user(text), user(text)]),
    user('"\\\u0000🙂\ud800'),
  ]);
  const expected = JSON.stringify(input);
  const expectedBytes = Buffer.byteLength(expected);
  const stringify = JSON.stringify;
  t.mock.method(JSON, 'stringify', (value, ...options) => {
    if (texts.includes(value)) throw new Error('unescaped_history_text_was_serialized');
    return stringify(value, ...options);
  });
  const result = normalizeRecoveryHistoryRequest(input, 3);
  assert.equal(recoveryHistoryRequestBytes(result), expectedBytes);
  assert.equal(stringify(result), expected);
  assert.equal(Object.isFrozen(result.history), true);
  assert.equal(Object.isFrozen(result.history.at(-1)), true);
});

test('history accounting matches native JSON for every UTF-16 unit and supplementary code point', () => {
  function verify(content) {
    const input = request([user(content), { role: 'user', content: { [content]: content } }]);
    const result = normalizeRecoveryHistoryRequest(input, 3);
    assert.equal(recoveryHistoryRequestBytes(result), Buffer.byteLength(JSON.stringify(input)));
    assert.equal(JSON.stringify(result), JSON.stringify(input));
  }
  for (let start = 0; start < 0x10000; start += 256) {
    // Separators prevent neighboring surrogate units from becoming pairs.
    verify(
      Array.from({ length: 256 }, (_, offset) => String.fromCharCode(start + offset)).join('|')
    );
  }
  for (let start = 0x10000; start <= 0x10ffff; start += 2048) {
    verify(
      Array.from({ length: 2048 }, (_, offset) => String.fromCodePoint(start + offset)).join('')
    );
  }
});

test('history byte counting matches JSON for plain Unicode, escapes and paired or lone surrogates', () => {
  const strings = [
    '',
    'plain ASCII',
    '中文日本語',
    '\u007f\u0080\u2028\u2029',
    '🙂',
    '\ud800',
    '\udfff',
    '\ud800x\udfff',
    '\ud800\udc00',
    '"\\\b\f\n\r\t',
    ...Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)),
    'x'.repeat(1024 * 1024),
    '中'.repeat(100000),
  ];
  for (const content of strings) {
    const input = request([user(content), user(content)]);
    const result = normalizeRecoveryHistoryRequest(input, 3);
    assert.equal(recoveryHistoryRequestBytes(result), Buffer.byteLength(JSON.stringify(input)));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), JSON.parse(JSON.stringify(input)));
  }
  for (const unit of ['x', '中', '\ud800', '\u0000', '"', '\\']) {
    const overhead = Buffer.byteLength(JSON.stringify(user('')));
    const unitBytes = Buffer.byteLength(JSON.stringify(unit)) - 2;
    const count = Math.floor((2 * 1024 * 1024 - overhead) / unitBytes);
    const content = unit.repeat(count) + 'x'.repeat((2 * 1024 * 1024 - overhead) % unitBytes);
    assert.equal(Buffer.byteLength(JSON.stringify(user(content))), 2 * 1024 * 1024);
    assert.doesNotThrow(() => normalizeRecoveryHistoryRequest(request([user(content)]), 3));
    assert.throws(() => normalizeRecoveryHistoryRequest(request([user(content + 'x')]), 3));
  }
});

test('single function proxy containers retain generic trap order and failures', () => {
  function observe(level, general, throwing = false) {
    const item = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
    };
    if (general) item.extra = null;
    const events = [];
    const handler = {
      getPrototypeOf(value) {
        events.push('prototype');
        return Reflect.getPrototypeOf(value);
      },
      ownKeys(value) {
        events.push('keys');
        return Reflect.ownKeys(value);
      },
      getOwnPropertyDescriptor(value, name) {
        events.push('descriptor:' + String(name));
        if (throwing) throw new Error('synthetic proxy refusal');
        return Reflect.getOwnPropertyDescriptor(value, name);
      },
      get(value, name, receiver) {
        events.push('get:' + String(name));
        return Reflect.get(value, name, receiver);
      },
    };
    if (level === 'list') item.tool_calls = new Proxy(item.tool_calls, handler);
    else if (level === 'call') item.tool_calls[0] = new Proxy(item.tool_calls[0], handler);
    else item.tool_calls[0].function = new Proxy(item.tool_calls[0].function, handler);
    if (throwing) assert.throws(() => normalizeRecoveryHistoryRequest(request([item]), 3));
    else assert.ok(normalizeRecoveryHistoryRequest(request([item]), 3));
    return events;
  }
  for (const level of ['list', 'call', 'function'])
    for (const throwing of [false, true])
      assert.deepEqual(observe(level, false, throwing), observe(level, true, throwing));
  let descriptors = 0;
  const item = new Proxy(
    { role: 'assistant', content: null, tool_calls: [] },
    {
      getOwnPropertyDescriptor() {
        descriptors++;
        throw new Error('synthetic root proxy refusal');
      },
    }
  );
  assert.throws(() => normalizeRecoveryHistoryRequest(request([item]), 3));
  assert.equal(descriptors, 1);
});

test('single function messages preserve full JSON and exact byte budgets on common and general paths', () => {
  const message = (text) => ({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call-' + text,
        type: 'function',
        function: { name: 'lookup-' + text, arguments: text },
      },
    ],
  });
  for (const text of [
    '',
    'ASCII',
    '中文🙂',
    '\\"\u0000\ud800',
    ...Array.from({ length: 140 }, (_, index) => 'argument-' + index),
  ]) {
    const item = message(text);
    const input = request([item]);
    const normalized = normalizeRecoveryHistoryRequest(input, 3);
    assert.equal(JSON.stringify(normalized), JSON.stringify(input));
    assert.equal(recoveryHistoryRequestBytes(normalized), Buffer.byteLength(JSON.stringify(input)));
    const call = normalized.history[0].tool_calls[0];
    assert.ok(Object.isFrozen(call));
    assert.ok(Object.isFrozen(call.function));
    assert.ok(Object.isFrozen(normalized.history[0].tool_calls));
    item.tool_calls[0].function.arguments = 'changed';
    assert.equal(call.function.arguments, text);
    for (const alternative of [
      { tool_calls: item.tool_calls, role: item.role, content: item.content },
      {
        content: null,
        tool_calls: [
          {
            function: { arguments: text, name: 'lookup-' + text },
            type: 'function',
            id: 'call-' + text,
          },
        ],
        role: 'assistant',
      },
      { ...item, extra: 'retained' },
      { ...item, tool_calls: [item.tool_calls[0], item.tool_calls[0]] },
      { ...item, content: '' },
    ]) {
      const source = request([alternative]);
      const result = normalizeRecoveryHistoryRequest(source, 3);
      assert.equal(JSON.stringify(result), JSON.stringify(source));
      assert.equal(recoveryHistoryRequestBytes(result), Buffer.byteLength(JSON.stringify(source)));
    }
  }
  const item = message('');
  const overhead = Buffer.byteLength(JSON.stringify(item));
  item.tool_calls[0].function.arguments = 'x'.repeat(2 * 1024 * 1024 - overhead);
  assert.doesNotThrow(() => normalizeRecoveryHistoryRequest(request([item]), 3));
  item.tool_calls[0].function.arguments += 'x';
  assert.throws(() => normalizeRecoveryHistoryRequest(request([item]), 3));
});

test('single function normalization rejects descriptor hooks and preserves aggregate node and depth bounds', () => {
  const fresh = () => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
  });
  const executableRecord = (fields) => {
    const value = () => {};
    delete value.name;
    delete value.length;
    Object.setPrototypeOf(value, null);
    return Object.assign(value, fields);
  };
  let touched = 0;
  const hook = {
    enumerable: true,
    get() {
      touched++;
      throw Error('private');
    },
  };
  for (const mutate of [
    (item) => Object.defineProperty(item, 'role', hook),
    (item) => Object.defineProperty(item, 'content', hook),
    (item) => Object.defineProperty(item, 'tool_calls', hook),
    (item) => Object.defineProperty(item.tool_calls, '0', hook),
    (item) => Object.defineProperty(item.tool_calls[0], 'id', hook),
    (item) => Object.defineProperty(item.tool_calls[0], 'function', hook),
    (item) => Object.defineProperty(item.tool_calls[0].function, 'arguments', hook),
    (item) =>
      Object.defineProperty(item.tool_calls[0].function, 'name', {
        value: 'lookup',
        enumerable: false,
      }),
    (item) => Object.setPrototypeOf(item.tool_calls[0], { unsafe: true }),
    (item) => Object.setPrototypeOf(item.tool_calls[0].function, { unsafe: true }),
    (item) => {
      item.tool_calls[0] = executableRecord(item.tool_calls[0]);
    },
    (item) => {
      item.tool_calls[0].function = executableRecord(item.tool_calls[0].function);
    },
    (item) => {
      item.tool_calls[0].function[Symbol('unsafe')] = true;
    },
    (item) => {
      item.tool_calls[0].function.arguments = item;
    },
    (item) => {
      delete item.tool_calls[0];
    },
  ]) {
    const item = fresh();
    mutate(item);
    assert.throws(() => normalizeRecoveryHistoryRequest(request([item]), 3));
  }
  assert.equal(touched, 0);
  const common = fresh();
  const general = { content: common.content, role: common.role, tool_calls: common.tool_calls };
  for (const item of [common, general]) {
    assert.doesNotThrow(() => normalizeRecoveryHistoryRequest(request(Array(6500).fill(item)), 3));
    assert.throws(() => normalizeRecoveryHistoryRequest(request(Array(6554).fill(item)), 3));
    const atLimit = request(Array(6553).fill(item), { previousResponseId: 'parent' });
    assert.doesNotThrow(() => normalizeRecoveryHistoryRequest(atLimit, 3));
    assert.throws(() => normalizeRecoveryHistoryRequest({ ...atLimit, policy: null }, 3));
    for (const count of [57, 58]) {
      let content = item;
      for (let index = 0; index < count; index++) content = { nested: content };
      const input = request([user(content)]);
      if (count === 57) assert.doesNotThrow(() => normalizeRecoveryHistoryRequest(input, 3));
      else assert.throws(() => normalizeRecoveryHistoryRequest(input, 3));
    }
  }
});

test('history request boundaries reject unsafe, sparse, deep, escaped and aggregate node excess', () => {
  let touched = 0;
  const accessor = Object.defineProperty({}, 'history', {
    enumerable: true,
    get() {
      touched++;
      return [];
    },
  });
  const arrayAccessor = [];
  Object.defineProperty(arrayAccessor, '0', {
    enumerable: true,
    get() {
      touched++;
      return user('secret');
    },
  });
  const cycle = {};
  cycle.self = cycle;
  let deep = 'leaf';
  for (let index = 0; index < 64; index++) deep = { child: deep };
  for (const input of [
    null,
    undefined,
    1,
    [],
    accessor,
    Object.create(request()),
    request(Array(1)),
    request(arrayAccessor),
    request([null]),
    request([[]]),
    request([cycle]),
    request([user(deep)]),
    request([user('x'.repeat(2 * 1024 * 1024))]),
    request([user('x')], { policy: 'x'.repeat(2 * 1024 * 1024) }),
    request(Array.from({ length: 32 }, () => user('\u0000'.repeat(256 * 1024)))),
    request(
      Array.from({ length: 16000 }, () => ({ role: 'user', content: '', a: true, b: false }))
    ),
    request([], { extra: true }),
    request([], { [Symbol('secret')]: true }),
  ])
    assert.throws(() => normalizeRecoveryHistoryRequest(input, 3));
  for (const format of [undefined, null, 0, 1, 4, '3', Infinity]) {
    if (format !== undefined)
      assert.throws(() => normalizeRecoveryHistoryRequest(request(), format));
    assert.throws(() => recoveryHistoryRequestLimit(format));
  }
  assert.equal(touched, 0);
  for (const options of [
    null,
    [],
    { historyFormat: 4 },
    { historyFormat: '3' },
    Object.create({ historyFormat: 3 }),
    Object.defineProperty({}, 'historyFormat', {
      enumerable: true,
      get() {
        touched++;
        return 3;
      },
    }),
  ])
    assert.throws(() => createContextBindingRegistry(options));
  assert.equal(touched, 0);
});

test('format 3 long-history bindings survive export and restore while old roots keep 2 MiB admission', () => {
  const large = request(Array.from({ length: 12 }, () => user('x'.repeat(1024 * 1024))));
  const registry = createContextBindingRegistry({ now: () => 100, historyFormat: 3 });
  let restored, old;
  try {
    const first = registry.begin(large);
    assert.equal(first.ok, true);
    assert.equal(registry.commit(first.token, [assistant('large')], 'large').ok, true);
    const state = exportContextBindingRegistry(registry, first.snapshotId);
    assert.equal(state.format, 3);
    assert.ok(state.snapshots[0].bytes > 12 * 1024 * 1024);
    restored = restoreContextBindingRegistry({ now: () => 200, binding: large }, state).registry;
    const child = restored.begin({ ...large, previousResponseId: 'large' });
    assert.equal(child.ok, true);
    assert.equal(child.parentSnapshotId, first.snapshotId);
    const small = request();
    const legacy = createContextBindingRegistry({ now: () => 100 });
    const initial = legacy.begin(small);
    legacy.commit(initial.token, [assistant('old')], 'old');
    const legacyState = exportContextBindingRegistry(legacy, initial.snapshotId);
    legacy.close();
    old = restoreContextBindingRegistry(
      { now: () => 200, binding: small, historyFormat: 3 },
      legacyState
    ).registry;
    assert.equal(
      old.begin({ ...large, previousResponseId: 'old' }).code,
      'invalid_context_binding'
    );
    const next = old.begin({ ...small, previousResponseId: 'old' });
    assert.equal(next.ok, true);
    old.commit(next.token, [assistant('continued')], 'continued');
    assert.equal(exportContextBindingRegistry(old, initial.snapshotId).format, 2);
    const fresh = old.begin(large);
    assert.equal(fresh.ok, true);
    old.commit(fresh.token, [assistant('fresh')]);
    assert.equal(exportContextBindingRegistry(old, fresh.snapshotId).format, 3);
  } finally {
    registry.close();
    restored?.close();
    old?.close();
  }
});

test('Claude equality accepts only bounded text representations and validated cache metadata', () => {
  const text = 'exact 中文🙂';
  const cached = (cache) => ({
    role: 'user',
    content: [{ type: 'text', text, cache_control: cache }],
  });
  const nativeCall = {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'native-anchor', name: 'Read', input: {} }],
  };
  const checks = [
    [cached({ type: 'ephemeral' }), user(text), true],
    [cached({ type: 'ephemeral', ttl: '5m' }), user(text), true],
    [cached({ type: 'ephemeral', ttl: '1h' }), user(text), true],
    [{ role: 'user', content: [{ type: 'text', text: '' }] }, user(''), true],
    [cached({ type: 'ephemeral' }), user(text + ' changed'), false],
    [cached(null), user(text), false],
    [cached([]), user(text), false],
    [cached('ephemeral'), user(text), false],
    [cached({ type: 'persistent' }), user(text), false],
    [cached({ type: 'ephemeral', ttl: '24h' }), user(text), false],
    [cached({ type: 'ephemeral', ttl: 300 }), user(text), false],
    [cached({ type: 'ephemeral', scope: 'unknown' }), user(text), false],
    [{ role: 'user', content: [{ type: 'text', text, signature: 'opaque' }] }, user(text), false],
    [
      {
        role: 'user',
        content: [
          { type: 'text', text },
          { type: 'text', text: '' },
        ],
      },
      user(text),
      false,
    ],
    [
      { role: 'assistant', content: [{ type: 'text', text }] },
      { role: 'assistant', content: text },
      false,
    ],
    [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'c',
            content: text,
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: text }] },
      true,
    ],
    [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'c', content: [{ type: 'text', text }] }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: text }] },
      false,
    ],
    [{ role: 'user', content: [] }, user(''), false],
    [{ role: 'user', content: [null] }, user(''), false],
    [{ role: 'user', content: [{ type: 'image', source: 'opaque' }] }, user(''), false],
  ];
  for (const protocol of ['claude', 'chat', 'responses']) {
    for (const [initial, candidate, equivalent] of checks) {
      const registry = createContextBindingRegistry({ now: () => 100 });
      const first = registry.begin(request([initial], { protocol }));
      assert.equal(first.ok, true);
      assert.equal(registry.commit(first.token, [nativeCall], 'fixture').ok, true);
      const state = exportContextBindingRegistry(registry, first.snapshotId);
      const restored = restoreContextBindingRegistry(
        { now: () => 101, binding: request([initial], { protocol }) },
        state
      );
      const next = restored.registry.begin(request([candidate, nativeCall], { protocol }));
      assert.equal(
        next.reason,
        protocol === 'claude' && equivalent ? 'observed_continuation' : 'isolated_request'
      );
      restored.registry.close();
      registry.close();
    }
  }
  const registry = createContextBindingRegistry();
  let getterExecuted = false;
  const malicious = {
    role: 'user',
    content: [
      {
        type: 'text',
        text,
        get cache_control() {
          getterExecuted = true;
          throw new Error('getter executed');
        },
      },
    ],
  };
  assert.equal(registry.begin(request([malicious], { protocol: 'claude' })).ok, false);
  assert.equal(getterExecuted, false);
  registry.close();
});

test('Claude assistant tool cache metadata can move across observed and restored native histories', () => {
  const native = {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'native-cache-anchor', name: 'Read', input: {} }],
  };
  const changed = (patch) => ({
    ...native,
    content: [{ ...native.content[0], ...patch }],
  });
  const cases = [
    [changed({ cache_control: { type: 'ephemeral' } }), true],
    [changed({ cache_control: { type: 'ephemeral', ttl: '5m' } }), true],
    [changed({ cache_control: { type: 'ephemeral', ttl: '1h' } }), true],
    [changed({ cache_control: null }), false],
    [changed({ cache_control: [] }), false],
    [changed({ cache_control: 'ephemeral' }), false],
    [changed({ cache_control: { type: 'persistent' } }), false],
    [changed({ cache_control: { type: 'ephemeral', ttl: '' } }), false],
    [changed({ cache_control: { type: 'ephemeral', ttl: '24h' } }), false],
    [changed({ cache_control: { type: 'ephemeral', ttl: 300 } }), false],
    [changed({ cache_control: { type: 'ephemeral', scope: 'unknown' } }), false],
    [changed({ cache_control: { type: 'ephemeral' }, id: 'different' }), false],
    [changed({ cache_control: { type: 'ephemeral' }, name: 'different' }), false],
    [changed({ cache_control: { type: 'ephemeral' }, input: { path: 'different' } }), false],
    [changed({ cache_control: { type: 'ephemeral' }, signature: 'opaque' }), false],
    [changed({ cache_control: { type: 'ephemeral' }, type: 'thinking' }), false],
    [{ ...changed({ cache_control: { type: 'ephemeral' } }), role: 'user' }, false],
    [{ ...changed({ cache_control: { type: 'ephemeral' } }), role: 'system' }, false],
    [{ ...native, content: [] }, false],
    [{ ...native, content: [null] }, false],
    [{ ...native, content: [native.content[0], { type: 'text', text: 'extra' }] }, false],
  ];
  for (const protocol of ['claude', 'chat', 'responses']) {
    for (const [candidate, equivalent] of cases) {
      for (const [output, nextOutput] of [
        [native, candidate],
        [candidate, native],
      ]) {
        const input = request([user('owned window')], { protocol });
        const registry = createContextBindingRegistry({ now: () => 100 });
        const first = registry.begin(input);
        assert.equal(registry.commit(first.token, [output]).ok, true);
        const before = JSON.stringify([output, nextOutput]);
        const state = exportContextBindingRegistry(registry, first.snapshotId);
        const restored = restoreContextBindingRegistry({ now: () => 101, binding: input }, state);
        try {
          const next = restored.registry.begin({
            ...input,
            history: [...input.history, nextOutput],
          });
          assert.equal(
            next.reason,
            protocol === 'claude' && equivalent ? 'observed_continuation' : 'isolated_request'
          );
          assert.equal(JSON.stringify([output, nextOutput]), before);
        } finally {
          restored.registry.close();
          registry.close();
        }
      }
    }
  }
  for (const type of ['text', 'thinking', 'redacted_thinking']) {
    const registry = createContextBindingRegistry({ now: () => 100 });
    try {
      const input = request([user('opaque window')], { protocol: 'claude' });
      const first = registry.begin(input);
      const output = {
        role: 'assistant',
        id: 'opaque-anchor',
        content: [{ type, text: 'opaque value', signature: 'opaque signature' }],
      };
      assert.equal(registry.commit(first.token, [output]).ok, true);
      const cachedOutput = {
        ...output,
        content: [{ ...output.content[0], cache_control: { type: 'ephemeral' } }],
      };
      assert.equal(
        registry.begin({ ...input, history: [...input.history, cachedOutput] }).reason,
        'isolated_request'
      );
    } finally {
      registry.close();
    }
  }
  const registry = createContextBindingRegistry();
  let accessed = false;
  const first = registry.begin(request([user('getter')], { protocol: 'claude' }));
  try {
    const output = {
      role: 'assistant',
      content: [
        {
          ...native.content[0],
          get cache_control() {
            accessed = true;
            throw new Error('private native error');
          },
        },
      ],
    };
    assert.equal(registry.commit(first.token, [output]).code, 'invalid_context_binding_output');
    assert.equal(accessed, false);
  } finally {
    registry.close();
  }
});

test('verified response-ID deltas bind the complete cumulative public window across restart', () => {
  const registry = createContextBindingRegistry({ now: () => 100 });
  const initial = [user('initial-private-user-marker')];
  const firstOutput = assistant('root-anchor');
  const first = registry.begin(request(initial));
  assert.equal(registry.commit(first.token, [firstOutput], 'r1').ok, true);
  const delta = user('delta');
  const plain = { role: 'assistant', content: 'plain successor' };
  const child = registry.begin(request([delta], { previousResponseId: 'r1' }));
  assert.equal(registry.commit(child.token, [plain], 'r2').ok, true);
  const deltaTwo = user('delta-two');
  const plainTwo = { role: 'assistant', content: 'second plain successor' };
  const grandchild = registry.begin(request([deltaTwo], { previousResponseId: 'r2' }));
  assert.equal(registry.commit(grandchild.token, [plainTwo], 'r2b').ok, true);
  const full = [...initial, firstOutput, delta, plain, deltaTwo, plainTwo];
  const next = registry.begin(request([...full, user('next')]));
  assert.equal(next.parentSnapshotId, grandchild.snapshotId);
  registry.rollback(next.token);
  assert.equal(registry.begin(request([delta, plain])).parentSnapshotId, null);
  const sibling = registry.begin(request([user('sibling')], { previousResponseId: 'r1' }));
  registry.commit(sibling.token, [assistant('sibling')], 'sibling');
  const state = exportContextBindingRegistry(registry, first.snapshotId);
  assert.equal(state.format, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(state.snapshots[1].window)), {
    kind: 'delta',
    count: 4,
  });
  assert.equal(JSON.stringify(state).includes('initial-private-user-marker'), false);
  registry.close();
  const restored = restoreContextBindingRegistry(
    { now: () => 200, binding: request(initial) },
    state
  );
  try {
    const continued = restored.registry.begin(request([...full, user('after restart')]));
    assert.equal(continued.parentSnapshotId, grandchild.snapshotId);
    assert.deepEqual(restored.registry.ancestors(continued.token).snapshotIds, [
      grandchild.snapshotId,
      child.snapshotId,
      first.snapshotId,
    ]);
    const foreign = restored.registry.begin(
      request([...full, user('next')], { principal: 'foreign' })
    );
    assert.equal(foreign.parentSnapshotId, null);
    const explicitFull = restored.registry.begin(
      request([...full, user('full-and-id')], { previousResponseId: 'r2b' })
    );
    const final = assistant('full-final');
    assert.equal(restored.registry.commit(explicitFull.token, [final], 'r3').ok, true);
    const finalWindow = [...full, user('full-and-id'), final, user('tail')];
    assert.equal(
      restored.registry.begin(request(finalWindow)).parentSnapshotId,
      explicitFull.snapshotId
    );
  } finally {
    restored.registry.close();
  }
});

test('window metadata validates normal, empty, malformed, extreme and accessor values without expanding authority', () => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(parseBindingWindow({ kind: 'full', count: 0 })), {
    kind: 'full',
    count: 0,
  });
  assert.deepEqual(
    selectBindingWindow({ count: 0, hasPrevious: false, fullPrefix: false, parentCount: null }),
    { kind: 'full', count: 0 }
  );
  assert.deepEqual(
    selectBindingWindow({ count: 1, hasPrevious: true, fullPrefix: false, parentCount: 2 }),
    { kind: 'delta', count: 3 }
  );
  assert.deepEqual(
    selectBindingWindow({ count: 1, hasPrevious: true, fullPrefix: false, parentCount: null }),
    { kind: 'unavailable', count: null }
  );
  assert.deepEqual(
    selectBindingWindow({ count: 1, hasPrevious: true, fullPrefix: false, parentCount: 16384 }),
    { kind: 'unavailable', count: null }
  );
  assert.deepEqual(publishBindingWindow({ kind: 'delta', count: 3 }, 1, false), {
    kind: 'delta',
    count: 4,
  });
  assert.deepEqual(publishBindingWindow({ kind: 'full', count: 16384 }, 1, false), {
    kind: 'unavailable',
    count: null,
  });
  assert.deepEqual(publishBindingWindow({ kind: 'unavailable', count: null }, 1, true), {
    kind: 'compaction',
    count: 1,
  });
  let ran = 0;
  const accessor = {
    kind: 'full',
    get count() {
      ran++;
      return 1;
    },
  };
  for (const input of [
    null,
    [],
    {},
    { kind: 'unknown', count: 1 },
    { kind: 'full', count: null },
    { kind: 'full', count: -1 },
    { kind: 'full', count: 16385 },
    { kind: 'full', count: Infinity },
    { kind: 'full', count: 1, extra: true },
    { kind: 'unavailable', count: 0 },
    accessor,
  ])
    assert.throws(() => parseBindingWindow(input));
  for (const input of [
    { count: -1, hasPrevious: false, fullPrefix: false, parentCount: null },
    { count: 1, hasPrevious: 'true', fullPrefix: false, parentCount: null },
    { count: 1, hasPrevious: true, fullPrefix: false, parentCount: Number.MAX_SAFE_INTEGER },
    {},
  ])
    assert.throws(() => selectBindingWindow(input));
  for (const output of [0, -1, 1.5, 16385, NaN])
    assert.throws(() => publishBindingWindow({ kind: 'full', count: 1 }, output, false));
  assert.throws(() => publishBindingWindow({ kind: 'full', count: 1 }, 1, 'true'));
  assert.equal(ran, 0);
});

test('legacy window completeness stays unavailable after import and malformed new metadata cannot be restored', () => {
  const registry = createContextBindingRegistry({ now: () => 100 });
  const input = request();
  const output = assistant('root');
  const root = registry.begin(input);
  registry.commit(root.token, [output], 'root');
  const state = JSON.parse(JSON.stringify(exportContextBindingRegistry(registry, root.snapshotId)));
  registry.close();
  for (const mutate of [
    (value) => {
      value.format = 4;
    },
    (value) => {
      value.snapshots[0].window.count = 1;
    },
    (value) => {
      value.snapshots[0].window.kind = 'delta';
    },
    (value) => {
      value.snapshots[0].window.extra = true;
    },
    (value) => {
      value.snapshots[0].window = { kind: 'unavailable', count: 2 };
    },
  ]) {
    const invalid = globalThis.structuredClone(state);
    mutate(invalid);
    assert.throws(
      () => restoreContextBindingRegistry({ now: () => 200, binding: input }, invalid),
      { code: 'invalid_context_binding_state' }
    );
  }
  const legacy = globalThis.structuredClone(state);
  delete legacy.format;
  for (const snapshot of legacy.snapshots) delete snapshot.window;
  const restored = restoreContextBindingRegistry({ now: () => 200, binding: input }, legacy);
  try {
    const delta = user('old delta');
    const plain = { role: 'assistant', content: 'old plain' };
    const child = restored.registry.begin(request([delta], { previousResponseId: 'root' }));
    restored.registry.commit(child.token, [plain], 'child');
    const again = exportContextBindingRegistry(restored.registry, root.snapshotId);
    assert.equal(again.snapshots[0].expiresAt, state.snapshots[0].expiresAt);
    assert.equal(again.snapshots[0].window.kind, 'unavailable');
    assert.equal(again.snapshots[1].window.kind, 'unavailable');
    const full = [...input.history, output, delta, plain, user('fresh full')];
    const fresh = restored.registry.begin(request(full));
    assert.equal(fresh.parentSnapshotId, root.snapshotId);
    restored.registry.commit(fresh.token, [assistant('fresh')], 'fresh');
    const next = restored.registry.begin(
      request([user('new delta')], { previousResponseId: 'fresh' })
    );
    restored.registry.commit(next.token, [plain], 'final');
    assert.equal(
      restored.registry.begin(
        request([...full, assistant('fresh'), user('new delta'), plain, user('tail')])
      ).parentSnapshotId,
      next.snapshotId
    );
  } finally {
    restored.registry.close();
  }
});

test('native compaction starts a new cumulative window without carrying the old public prefix', () => {
  const registry = createContextBindingRegistry();
  const initial = request();
  const root = registry.begin(initial);
  const rootOutput = assistant('root');
  registry.commit(root.token, [rootOutput], 'root');
  const delta = user('before compact');
  const output = assistant('before compact');
  const child = registry.begin(request([delta], { previousResponseId: 'root' }));
  registry.commit(child.token, [output], 'child');
  const compact = registry.beginCompaction(
    request([...initial.history, rootOutput, delta, output])
  );
  assert.equal(compact.parentSnapshotId, child.snapshotId);
  const canonical = { type: 'compaction', encrypted_content: 'synthetic-opaque-canonical' };
  assert.equal(registry.commitCompaction(compact.token, [canonical]).ok, true);
  const nextInput = [canonical, user('after compact')];
  const next = registry.begin(request(nextInput));
  assert.equal(next.parentSnapshotId, compact.snapshotId);
  const nextOutput = assistant('after compact');
  registry.commit(next.token, [nextOutput], 'after');
  const tail = user('tail');
  const final = registry.begin(request([tail], { previousResponseId: 'after' }));
  const finalOutput = assistant('tail');
  registry.commit(final.token, [finalOutput], 'final');
  assert.equal(
    registry.begin(request([...nextInput, nextOutput, tail, finalOutput, user('continue')]))
      .parentSnapshotId,
    final.snapshotId
  );
  const state = exportContextBindingRegistry(registry, root.snapshotId);
  assert.equal(state.snapshots.find((value) => value.id === compact.snapshotId).window.count, 1);
  assert.equal(state.snapshots.find((value) => value.id === final.snapshotId).window.count, 5);
  registry.close();
});

test('binding continues only an observed full window, independent of JSON key order', () => {
  const registry = createContextBindingRegistry();
  const first = registry.begin(request());
  assert.equal(first.reason, 'isolated_request');
  assert.equal(registry.commit(first.token, [assistant('answer')]).ok, true);
  const next = registry.begin(
    request([{ content: 'question', role: 'user' }, assistant('answer'), user('next')])
  );
  assert.equal(next.reason, 'observed_continuation');
  assert.equal(next.parentSnapshotId, first.snapshotId);
  assert.deepEqual(registry.ancestors(next.token).snapshotIds, [first.snapshotId]);
  assert.equal(registry.begin(request([user('question')])).parentSnapshotId, null);
});

test('withdraw invalidates a published branch and its descendants while preserving siblings and ancestors', () => {
  const registry = createContextBindingRegistry();
  const root = registry.begin(request());
  registry.commit(root.token, [assistant('root')], 'root-response');
  const a = registry.begin(request([user('a')], { previousResponseId: 'root-response' }));
  registry.commit(a.token, [assistant('a')], 'a-response');
  const sibling = registry.begin(
    request([user('sibling')], { previousResponseId: 'root-response' })
  );
  registry.commit(sibling.token, [assistant('sibling')], 'sibling-response');
  const child = registry.begin(request([user('child')], { previousResponseId: 'a-response' }));
  registry.commit(child.token, [assistant('child')], 'child-response');
  const grandchild = registry.begin(
    request([user('grandchild')], { previousResponseId: 'child-response' })
  );
  assert.deepEqual(registry.withdraw(a.token), [
    a.snapshotId,
    child.snapshotId,
    grandchild.snapshotId,
  ]);
  assert.equal(registry.ancestors(child.token).ok, false);
  assert.equal(registry.ancestors(root.token).ok, true);
  assert.equal(registry.ancestors(sibling.token).ok, true);
  assert.deepEqual(registry.withdraw(a.token), []);
  assert.deepEqual(registry.withdraw({}), []);
  assert.equal(
    registry.begin(request([user('next')], { previousResponseId: 'a-response' })).code,
    'context_binding_previous_unavailable'
  );
});

test('parallel continuations fork and cannot read sibling futures', () => {
  const registry = createContextBindingRegistry();
  const history = [user('question')];
  const root = registry.begin(request(history));
  registry.commit(root.token, [assistant('answer')]);
  const a = registry.begin(request([...history, assistant('answer'), user('a')]));
  const b = registry.begin(request([...history, assistant('answer'), user('b')]));
  assert.notEqual(a.snapshotId, b.snapshotId);
  registry.commit(a.token, [assistant('a-result')]);
  registry.commit(b.token, [assistant('b-result')]);
  assert.deepEqual(registry.ancestors(a.token).snapshotIds, [root.snapshotId]);
  assert.deepEqual(registry.ancestors(b.token).snapshotIds, [root.snapshotId]);
});

test('plain descendants retain the latest full anchored window without creating text-only identity', () => {
  const registry = createContextBindingRegistry();
  const initial = [user('question')];
  const root = registry.begin(request(initial));
  const anchor = assistant('observed');
  registry.commit(root.token, [anchor], 'root-response');
  const window = [...initial, anchor, user('next')];
  const child = registry.begin(request(window));
  const plain = { role: 'assistant', content: 'finished' };
  assert.equal(registry.commit(child.token, [plain], 'child-response').ok, true);
  const full = [...window, plain, user('continue')];
  const next = registry.begin(request(full));
  assert.equal(next.parentSnapshotId, child.snapshotId);
  assert.deepEqual(registry.ancestors(next.token).snapshotIds, [child.snapshotId, root.snapshotId]);
  const foreign = registry.begin(request(full, { principal: 'other' }));
  assert.equal(foreign.parentSnapshotId, null);
  assert.equal(registry.begin(request([user('next'), plain])).parentSnapshotId, null);
  // Explicit incremental chaining does not contain the observed root window.
  const incremental = registry.begin(
    request([user('short')], { previousResponseId: 'root-response' })
  );
  registry.commit(incremental.token, [plain]);
  assert.equal(registry.begin(request([user('short'), plain])).parentSnapshotId, null);
  const textRoot = registry.begin(request([user('text only')]));
  registry.commit(textRoot.token, [plain], 'text-response');
  const textChild = registry.begin(
    request([user('text only'), plain], { previousResponseId: 'text-response' })
  );
  registry.commit(textChild.token, [plain]);
  assert.equal(registry.begin(request([user('text only'), plain, plain])).parentSnapshotId, null);
  // Identical full descendants remain ambiguous; do not fall back to the root.
  const duplicate = registry.begin(request(window));
  registry.commit(duplicate.token, [plain]);
  assert.equal(registry.begin(request(full)).reason, 'ambiguous_continuation');
  assert.ok(registry.withdraw(child.token).includes(next.snapshotId));
  assert.equal(registry.begin(request(full)).parentSnapshotId, duplicate.snapshotId);
  registry.close();
});

test('identical independent windows are ambiguous and never merge', () => {
  const registry = createContextBindingRegistry();
  const a = registry.begin(request());
  const b = registry.begin(request());
  registry.commit(a.token, [assistant('same')]);
  registry.commit(b.token, [assistant('same')]);
  const next = registry.begin(request([user('question'), assistant('same'), user('next')]));
  assert.equal(next.reason, 'ambiguous_continuation');
  assert.equal(next.parentSnapshotId, null);
  assert.deepEqual(registry.ancestors(next.token).snapshotIds, []);
});

test('principal, protocol, target and policy changes cannot inherit evidence', () => {
  const registry = createContextBindingRegistry();
  const root = registry.begin(request());
  registry.commit(root.token, [assistant('answer')], 'response-1');
  for (const extra of [
    { principal: 'principal-b' },
    { protocol: 'claude' },
    { target: 'target-b' },
    { policy: 'changed' },
  ]) {
    assert.equal(
      registry.begin(request([user('question'), assistant('answer')], extra)).parentSnapshotId,
      null
    );
    assert.equal(
      registry.begin(request([], { ...extra, previousResponseId: 'response-1' })).ok,
      false
    );
  }
  const next = registry.begin(request([user('next')], { previousResponseId: 'response-1' }));
  assert.equal(next.parentSnapshotId, root.snapshotId);
});

test('unknown and duplicate response aliases cannot select an arbitrary branch', () => {
  const registry = createContextBindingRegistry();
  assert.equal(
    registry.begin(request([], { previousResponseId: 'missing' })).code,
    'context_binding_previous_unavailable'
  );
  for (const question of ['a', 'b']) {
    const root = registry.begin(request([user(question)]));
    registry.commit(root.token, [assistant('answer')], 'same-response');
  }
  const next = registry.begin(request([], { previousResponseId: 'same-response' }));
  assert.equal(next.reason, 'ambiguous_continuation');
  assert.equal(next.parentSnapshotId, null);
});

test('failed commits stay unpublished and claims cannot be forged or reused', () => {
  const registry = createContextBindingRegistry();
  const root = registry.begin(request());
  assert.equal(registry.commit({}, [assistant('answer')]).ok, false);
  assert.equal(registry.commit(root.token, []).ok, false);
  assert.equal(
    registry.begin(request([user('question'), assistant('answer')])).parentSnapshotId,
    null
  );
  assert.equal(registry.commit(root.token, [assistant('answer')]).ok, true);
  assert.equal(registry.commit(root.token, [assistant('answer')]).ok, false);
  assert.equal(registry.rollback(root.token), false);
  const pending = registry.begin(request());
  assert.equal(registry.rollback(pending.token), true);
  assert.equal(registry.commit(pending.token, [assistant('late')]).ok, false);
});

test('absolute expiry, missing ancestors and quotas preserve isolation', () => {
  let now = 1;
  const registry = createContextBindingRegistry({ now: () => now, maxSnapshots: 2 });
  const root = registry.begin(request());
  registry.commit(root.token, [assistant('answer')]);
  now = 100;
  const next = registry.begin(request([user('question'), assistant('answer')]));
  assert.equal(registry.begin(request()).code, 'context_binding_quota');
  now = 30 * 60 * 1000 + 1;
  assert.equal(registry.ancestors(next.token).code, 'context_binding_ancestor_unavailable');
  assert.equal(registry.commit(root.token, [assistant('late')]).ok, false);
  now += 100;
  assert.equal(registry.inspect().snapshots, 0);
});

test('invalid input, accessors, coercion, media size and extreme options fail safely', () => {
  const registry = createContextBindingRegistry();
  for (const input of [
    null,
    [],
    {},
    request([], { principal: '' }),
    request([], { protocol: 'unknown' }),
    request([null]),
    request([], { sessionId: 'model-selected' }),
    request([user('x'.repeat(2 * 1024 * 1024))]),
  ]) {
    assert.equal(registry.begin(input).code, 'invalid_context_binding');
  }
  let invoked = 0;
  const input = request();
  Object.defineProperty(input, 'history', {
    enumerable: true,
    get() {
      invoked++;
      return [];
    },
  });
  assert.equal(registry.begin(input).ok, false);
  assert.equal(invoked, 0);
  assert.throws(() => createContextBindingRegistry({ maxSnapshots: 0 }));
  assert.throws(() => createContextBindingRegistry({ maxSnapshots: 4097 }));
});

test('invalid and backward clocks close the registry without reviving old claims', () => {
  for (const invalid of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER, 0]) {
    let now = 1;
    const registry = createContextBindingRegistry({ now: () => now });
    const root = registry.begin(request());
    now = invalid;
    assert.equal(registry.commit(root.token, [assistant('answer')]).ok, false);
    now = 10;
    assert.equal(registry.begin(request()).ok, false);
  }
  const broken = createContextBindingRegistry({
    now: () => {
      throw new Error('private');
    },
  });
  assert.equal(broken.begin(request()).code, 'context_binding_unavailable');
});

test('close removes all mappings and an unrelated registry cannot use a claim', () => {
  const a = createContextBindingRegistry();
  const b = createContextBindingRegistry();
  const claim = a.begin(request());
  assert.equal(b.commit(claim.token, [assistant('answer')]).ok, false);
  a.close();
  assert.equal(a.inspect().snapshots, 0);
  assert.equal(a.ancestors(claim.token).ok, false);
  assert.equal(a.begin(request()).ok, false);
});

test('plain text matches alone never establish chat identity', () => {
  const registry = createContextBindingRegistry();
  const first = registry.begin(request());
  assert.equal(
    registry.commit(first.token, [{ role: 'assistant', content: 'common answer' }]).ok,
    true
  );
  const next = registry.begin(
    request([user('question'), { role: 'assistant', content: 'common answer' }])
  );
  assert.equal(next.reason, 'isolated_request');
  assert.equal(next.parentSnapshotId, null);
});

test('conflicting explicit response and observed history are refused', () => {
  const registry = createContextBindingRegistry();
  const a = registry.begin(request([user('a')]));
  const b = registry.begin(request([user('b')]));
  registry.commit(a.token, [assistant('a-result')], 'response-a');
  registry.commit(b.token, [assistant('b-result')], 'response-b');
  assert.equal(
    registry.begin(
      request([user('b'), assistant('b-result')], { previousResponseId: 'response-a' })
    ).code,
    'context_binding_conflict'
  );
});

test('native compaction binds the whole replacement window and preserves opaque data', () => {
  const registry = createContextBindingRegistry();
  const first = registry.begin(request());
  const window = [
    user('question'),
    { type: 'compaction', encrypted_content: 'opaque-checkpoint-fixture' },
    assistant('tail'),
  ];
  const before = JSON.stringify(window);
  assert.equal(registry.commitCompaction(first.token, window).ok, true);
  assert.equal(JSON.stringify(window), before);
  const next = registry.begin(request([...window, user('next')]));
  assert.equal(next.parentSnapshotId, first.snapshotId);
  assert.equal(registry.begin(request([window[1], user('next')])).parentSnapshotId, null);
  const invalid = registry.begin(request());
  assert.equal(
    registry.commitCompaction(invalid.token, [assistant('fake-local-summary')]).ok,
    false
  );
});

test('explicit text-only descendant continues its full window despite an older ancestral anchor', () => {
  const registry = createContextBindingRegistry();
  const original = registry.begin(request([user('q')]));
  const observed = assistant('anchored');
  assert.equal(registry.commit(original.token, [observed], 'r1').ok, true);
  const before = [user('q'), observed, user('continue')];
  const descendant = registry.begin(request(before));
  const plain = { role: 'assistant', content: 'plain final' };
  assert.equal(registry.commit(descendant.token, [plain], 'r2').ok, true);
  const resumed = registry.begin(
    request([...before, plain, user('next')], { previousResponseId: 'r2' })
  );
  assert.equal(resumed.ok, true);
  assert.equal(resumed.parentSnapshotId, descendant.snapshotId);
  assert.equal(
    registry.begin(
      request([...before, { ...plain, content: 'edited' }], { previousResponseId: 'r2' })
    ).code,
    'context_binding_conflict'
  );
});
