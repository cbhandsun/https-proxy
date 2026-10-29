'use strict';

const { createHash, randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { types } = require('node:util');
const { createCompactionByteBudget } = require('./context-compaction-byte-budget');
const { normalizeCallIdDigests } = require('./context-call-id-lineage');
const {
  LOCAL_COMPACTION_PREFIX,
  RENEWABLE_COMPACTION_PREFIX,
  compactionTokenPrefix,
  compactionLeasePolicy,
} = require('./context-compaction-lease');

const MAX_COMPACTION_WINDOW_BYTES = 128 * 1024;
function invalidCompaction(code = 'invalid_local_compaction') {
  const error = new TypeError('Invalid or unavailable local compaction state');
  error.code = code;
  return error;
}

// Normalize unknown data without executing getters, coercion, toJSON or custom
// prototypes. Byte admission is also checked after serialization (JSON escaping).
function normalizeCompactionData(value, maxBytes = MAX_COMPACTION_WINDOW_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024)
    throw invalidCompaction();
  const budget = { nodes: 65536, bytes: maxBytes };
  const encoded = createCompactionByteBudget(maxBytes, invalidCompaction);
  const seen = new Set();
  function clone(item, depth) {
    if (depth > 64 || --budget.nodes < 0) throw invalidCompaction();
    if (typeof item === 'string') {
      const raw = Buffer.byteLength(item);
      budget.bytes -= raw;
      if (budget.bytes < 0) throw invalidCompaction();
      encoded.string(item, raw);
      return item;
    }
    if (item === null || typeof item === 'boolean') {
      encoded.spend(item === false ? 5 : 4);
      return item;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      encoded.spend(String(item).length);
      return item;
    }
    // Reject proxies before structural reflection can invoke their traps.
    // This also gives revoked proxies the same fixed parser failure.
    if (!item || typeof item !== 'object' || types.isProxy(item) || seen.has(item))
      throw invalidCompaction();
    const array = Array.isArray(item);
    if (
      (array && Object.getPrototypeOf(item) !== Array.prototype) ||
      (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) ||
      (array && item.length > budget.nodes)
    )
      throw invalidCompaction();
    const keys = Reflect.ownKeys(item);
    if (keys.length > budget.nodes || (array && keys.length !== item.length + 1))
      throw invalidCompaction();
    seen.add(item);
    const output = array ? [] : Object.create(null);
    encoded.spend(2);
    let position = 0;
    for (const name of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, name);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalidCompaction();
      if (array && name === 'length') continue;
      if (
        typeof name !== 'string' ||
        !descriptor.enumerable ||
        (array && name !== String(position))
      )
        throw invalidCompaction();
      const raw = Buffer.byteLength(name);
      budget.bytes -= raw;
      if (budget.bytes < 0) throw invalidCompaction();
      encoded.spend(position++ ? 1 : 0);
      if (!array) {
        encoded.string(name, raw);
        encoded.spend(1);
      }
      const child = clone(descriptor.value, depth + 1);
      // Records have a null prototype, so even __proto__ is an ordinary own
      // data slot. Arrays retain descriptor writes: numeric setters on their
      // shared prototype must never participate in normalization.
      if (!array) output[name] = child;
      else
        Object.defineProperty(output, name, {
          value: child,
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
    seen.delete(item);
    return output;
  }
  const data = clone(value, 0);
  return data;
}

function identity(value, maximum = 256) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}
function bindingDigest(binding) {
  const safe = normalizeCompactionData(binding, 4096);
  if (
    !safe ||
    Array.isArray(safe) ||
    Object.keys(safe).sort().join(',') !== 'endpoint,model,owner,provider' ||
    !identity(safe.owner) ||
    !identity(safe.provider) ||
    !identity(safe.model) ||
    !identity(safe.endpoint, 2048)
  )
    throw invalidCompaction();
  return createHash('sha256')
    .update(JSON.stringify([safe.owner, safe.provider, safe.model, safe.endpoint]))
    .digest('hex');
}
function bounded(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw invalidCompaction();
  return value;
}
function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function createContextCompactionEnvelopeStore(options = {}) {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  )
    throw invalidCompaction();
  for (const name of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalidCompaction();
  }
  const now = options.now === undefined ? Date.now : options.now;
  if (typeof now !== 'function') throw invalidCompaction();
  const ttlMs = bounded(options.ttlMs, 15 * 60 * 1000, 60 * 60 * 1000);
  const lease = compactionLeasePolicy(options, ttlMs);
  const maxWindowBytes = bounded(
    options.maxWindowBytes,
    MAX_COMPACTION_WINDOW_BYTES,
    MAX_COMPACTION_WINDOW_BYTES
  );
  const maxEntries = bounded(options.maxEntries, 128, 1024);
  const maxOwnerBytes = bounded(options.maxOwnerBytes, 1024 * 1024, 16 * 1024 * 1024);
  const maxBytes = bounded(options.maxBytes, 4 * 1024 * 1024, 32 * 1024 * 1024);
  const key = randomBytes(32);
  const entries = new Map();
  let closed = false;
  let bytes = 0;
  let lastTime = 0;
  function remove(digest) {
    const entry = entries.get(digest);
    if (entry) bytes -= entry.bytes;
    entries.delete(digest);
  }
  function clock() {
    if (closed) throw invalidCompaction('local_compaction_closed');
    const current = now();
    if (
      !Number.isSafeInteger(current) ||
      current < lastTime ||
      current < 0 ||
      current > Number.MAX_SAFE_INTEGER - lease.maxLifetimeMs
    ) {
      entries.clear();
      bytes = 0;
      throw invalidCompaction('local_compaction_clock_invalid');
    }
    lastTime = current;
    for (const [digest, entry] of entries) if (current >= entry.expiresAt) remove(digest);
    return current;
  }
  function windowData(window) {
    const safe = normalizeCompactionData(window, maxWindowBytes);
    if (
      !Array.isArray(safe) ||
      safe.length === 0 ||
      safe.length > 2048 ||
      safe.some(
        (item) =>
          !item ||
          typeof item !== 'object' ||
          Array.isArray(item) ||
          ['compaction', 'compaction_trigger'].includes(item.type)
      )
    )
      throw invalidCompaction();
    return safe;
  }
  const store = {
    issue(window, binding, callIdDigests = [], evidenceReceipts = []) {
      const issuedAt = clock();
      const bound = bindingDigest(binding);
      const safe = windowData(window);
      const lineage = normalizeCallIdDigests(callIdDigests);
      const evidence = normalizeCompactionData(evidenceReceipts, 128 * 1024);
      if (
        !Array.isArray(evidence) ||
        evidence.length > 256 ||
        evidence.some(
          (ref) =>
            !ref ||
            Array.isArray(ref) ||
            Object.keys(ref).sort().join(',') !== 'bytes,digest,kind,locator,scope' ||
            ref.kind !== 'local_compaction_evidence' ||
            typeof ref.locator !== 'string' ||
            !/^hca_[a-f0-9]{32}$/.test(ref.locator) ||
            typeof ref.scope !== 'string' ||
            !/^hcs_[a-f0-9]{32}$/.test(ref.scope) ||
            typeof ref.digest !== 'string' ||
            !/^[a-f0-9]{64}$/.test(ref.digest) ||
            !Number.isSafeInteger(ref.bytes) ||
            ref.bytes < 1 ||
            ref.bytes > 2 * 1024 * 1024
        )
      )
        throw invalidCompaction();
      const expiresAt = issuedAt + ttlMs;
      const hardExpiresAt = issuedAt + lease.maxLifetimeMs;
      const version = lease.renewable ? 2 : 1;
      const prefix = lease.renewable ? RENEWABLE_COMPACTION_PREFIX : LOCAL_COMPACTION_PREFIX;
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(prefix + bound));
      const payload = Buffer.from(
        JSON.stringify({ version, issuedAt, expiresAt: hardExpiresAt, window: safe })
      );
      const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
      const token =
        prefix + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
      // Lineage is private, token/binding-bound metadata, not sent to the model
      // or buried in ciphertext to falsely inflate the compressed window.
      const size =
        Buffer.byteLength(token) +
        Buffer.byteLength(JSON.stringify(lineage)) +
        (evidence.length ? Buffer.byteLength(JSON.stringify(evidence)) : 0);
      const owner = hash(binding.owner);
      const ownerBytes = [...entries.values()]
        .filter((entry) => entry.owner === owner)
        .reduce((sum, entry) => sum + entry.bytes, 0);
      if (
        entries.size >= maxEntries ||
        bytes + size > maxBytes ||
        ownerBytes + size > maxOwnerBytes
      )
        throw invalidCompaction('local_compaction_quota');
      entries.set(hash(token), {
        bound,
        owner,
        expiresAt,
        hardExpiresAt,
        version,
        bytes: size,
        callIdDigests: lineage,
        evidenceReceipts: evidence,
      });
      bytes += size;
      return token;
    },
    readState(token, binding) {
      const current = clock();
      const bound = bindingDigest(binding);
      if (
        typeof token !== 'string' ||
        token.length > maxWindowBytes * 2 + 1024 ||
        !compactionTokenPrefix(token)
      )
        throw invalidCompaction();
      const entry = entries.get(hash(token));
      if (!entry || entry.bound !== bound) throw invalidCompaction();
      const prefix = compactionTokenPrefix(token);
      const encoded = token.slice(prefix.length);
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw invalidCompaction();
      const wire = Buffer.from(encoded, 'base64url');
      if (wire.length < 29 || wire.toString('base64url') !== encoded) throw invalidCompaction();
      let payload;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, wire.subarray(0, 12));
        decipher.setAAD(Buffer.from(prefix + bound));
        decipher.setAuthTag(wire.subarray(12, 28));
        payload = JSON.parse(
          Buffer.concat([decipher.update(wire.subarray(28)), decipher.final()]).toString('utf8')
        );
      } catch {
        throw invalidCompaction();
      }
      if (
        payload.version !== entry.version ||
        prefix !== (entry.version === 2 ? RENEWABLE_COMPACTION_PREFIX : LOCAL_COMPACTION_PREFIX) ||
        payload.expiresAt !== entry.hardExpiresAt ||
        !Number.isSafeInteger(payload.issuedAt) ||
        current < payload.issuedAt
      )
        throw invalidCompaction();
      return {
        window: windowData(payload.window),
        callIdDigests: [...entry.callIdDigests],
        ...(entry.evidenceReceipts.length
          ? { evidenceReceipts: normalizeCompactionData(entry.evidenceReceipts, 128 * 1024) }
          : {}),
      };
    },
    read(token, binding) {
      return store.readState(token, binding).window;
    },
    renew(tokens, binding, renewEvidence) {
      const safe = normalizeCompactionData(tokens, 4 * 1024 * 1024);
      if (
        !Array.isArray(safe) ||
        safe.length > 128 ||
        safe.some((token) => typeof token !== 'string')
      )
        throw invalidCompaction();
      bindingDigest(binding);
      const selected = [];
      const tokenKeys = [];
      const references = new Map();
      for (const token of new Set(safe)) {
        store.readState(token, binding);
        const entry = entries.get(hash(token));
        selected.push(entry);
        tokenKeys.push(hash(token));
        for (const ref of entry.evidenceReceipts) {
          const key = ref.scope + ':' + ref.locator;
          const previous = references.get(key);
          if (previous && (previous.digest !== ref.digest || previous.bytes !== ref.bytes))
            throw invalidCompaction('compaction_evidence_unavailable');
          references.set(key, ref);
        }
      }
      const current = clock();
      // A clock change while authenticating cannot revive an expired entry.
      if (selected.some((entry) => current >= entry.expiresAt)) throw invalidCompaction();
      if (!selected.length) return { expiresAt: null, renewed: 0 };
      let expiresAt = Math.min(
        ...selected.map((entry) =>
          entry.version === 2 ? Math.min(current + ttlMs, entry.hardExpiresAt) : entry.expiresAt
        )
      );
      if (references.size) {
        if (references.size > 256 || typeof renewEvidence !== 'function')
          throw invalidCompaction('compaction_evidence_unavailable');
        const renewed = renewEvidence(
          [...references.values()].map((ref) => ({ ...ref })),
          expiresAt
        );
        if (
          !renewed ||
          renewed.ok !== true ||
          !Number.isSafeInteger(renewed.expiresAt) ||
          renewed.expiresAt <= current ||
          renewed.expiresAt > expiresAt
        )
          throw invalidCompaction('compaction_evidence_unavailable');
        expiresAt = renewed.expiresAt;
      }
      const completedAt = clock();
      if (
        completedAt >= expiresAt ||
        selected.some(
          (entry, index) =>
            entries.get(tokenKeys[index]) !== entry || completedAt >= entry.expiresAt
        )
      )
        throw invalidCompaction();
      for (const entry of selected) if (entry.version === 2) entry.expiresAt = expiresAt;
      return { expiresAt, renewed: selected.filter((entry) => entry.version === 2).length };
    },
    discard(token, binding) {
      const bound = bindingDigest(binding);
      if (typeof token !== 'string') throw invalidCompaction();
      const digest = hash(token);
      if (entries.get(digest)?.bound === bound) remove(digest);
    },
    stats() {
      return { entries: entries.size, retainedBytes: bytes, closed };
    },
    close() {
      closed = true;
      entries.clear();
      bytes = 0;
      key.fill(0);
    },
  };
  return store;
}

module.exports = {
  LOCAL_COMPACTION_PREFIX,
  RENEWABLE_COMPACTION_PREFIX,
  compactionTokenPrefix,
  MAX_COMPACTION_WINDOW_BYTES,
  normalizeCompactionData,
  invalidCompaction,
  validateLocalCompactionBinding: bindingDigest,
  createContextCompactionEnvelopeStore,
};
