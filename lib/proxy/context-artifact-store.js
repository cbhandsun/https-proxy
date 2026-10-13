'use strict';

const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');
const { buildContextArtifactPage } = require('./context-artifact-page');
const { artifactLifecyclePolicy, canAdmitArtifact } = require('./context-artifact-lifecycle');

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ARTIFACT_BYTES = 1024 * 1024;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 256;
const LOCATOR_PATTERN = /^hca_[0-9a-f]{32}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function boundedInteger(value, fallback, maximum) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function validIdentity(value) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
  );
}

function serializeArtifact(value) {
  if (typeof value === 'string') return { encoding: 'utf8', payload: value };
  try {
    const payload = JSON.stringify(value);
    return typeof payload === 'string' ? { encoding: 'json', payload } : null;
  } catch (_error) {
    return null;
  }
}

function deserializeArtifact(record) {
  if (record.encoding === 'utf8') return record.payload;
  try {
    return JSON.parse(record.payload);
  } catch (_error) {
    return undefined;
  }
}

function digestPayload(payload) {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function safeDigestEqual(left, right) {
  if (
    typeof left !== 'string' ||
    typeof right !== 'string' ||
    !DIGEST_PATTERN.test(left) ||
    !DIGEST_PATTERN.test(right)
  )
    return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function createContextArtifactStore(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) options = {};
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const ttlMs = boundedInteger(options.ttlMs, DEFAULT_TTL_MS, 24 * 60 * 60 * 1000);
  const maxArtifactBytes = boundedInteger(
    options.maxArtifactBytes,
    DEFAULT_MAX_ARTIFACT_BYTES,
    8 * 1024 * 1024
  );
  const maxBytes = Math.max(
    maxArtifactBytes,
    boundedInteger(options.maxBytes, DEFAULT_MAX_BYTES, 128 * 1024 * 1024)
  );
  const maxEntries = boundedInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, 4096);
  const lifecycle = artifactLifecyclePolicy(options, {
    ttlMs,
    maxBytes,
    maxEntries,
    maxArtifactBytes,
  });
  const limits = { ...lifecycle, maxBytes, maxEntries };
  const records = new Map();
  // Uncommitted evidence reserves quota but is not visible to readers. All
  // writers share this reservation map; concurrent plans cannot overbook it.
  const pendingRecords = new Map();
  let retainedBytes = 0;
  let lastObservedTime = 0;
  let closed = false;

  function currentTime() {
    const current = now();
    if (
      !Number.isSafeInteger(current) ||
      current < lastObservedTime ||
      current < 0 ||
      current > Number.MAX_SAFE_INTEGER - lifecycle.maxLifetimeMs
    ) {
      records.clear();
      pendingRecords.clear();
      retainedBytes = 0;
      return null;
    }
    lastObservedTime = current;
    return current;
  }

  function remove(locator) {
    const record = records.get(locator);
    if (!record) return false;
    retainedBytes -= record.bytes;
    records.delete(locator);
    return true;
  }

  function pruneExpired() {
    const current = currentTime();
    if (current === null) return null;
    for (const [locator, record] of records) {
      if (current < record.createdAt || current >= record.expiresAt) remove(locator);
    }
    for (const [locator, record] of pendingRecords) {
      if (current < record.createdAt || current >= record.expiresAt) pendingRecords.delete(locator);
    }
    return current;
  }

  function prepareRecord(owner, session, value) {
    if (closed || !validIdentity(owner) || !validIdentity(session)) return null;
    const serialized = serializeArtifact(value);
    if (!serialized) return null;
    const bytes = Buffer.byteLength(serialized.payload);
    if (bytes === 0 || bytes > maxArtifactBytes) return null;
    const createdAt = pruneExpired();
    if (createdAt === null) return null;
    const reservations = new Map([...records, ...pendingRecords]);
    if (!canAdmitArtifact(reservations, owner, session, bytes, limits)) return null;
    return {
      owner,
      session,
      createdAt,
      expiresAt: createdAt + ttlMs,
      hardExpiresAt: createdAt + lifecycle.maxLifetimeMs,
      encoding: serialized.encoding,
      payload: serialized.payload,
      bytes,
      digest: digestPayload(serialized.payload),
    };
  }

  function receipt(locator, record) {
    return { locator, bytes: record.bytes, digest: record.digest, expiresAt: record.expiresAt };
  }

  function renewRecord(record) {
    record.expiresAt = Math.min(lastObservedTime + ttlMs, record.hardExpiresAt);
  }

  function ownedRecord(owner, session, locator) {
    if (closed || pruneExpired() === null) return null;
    if (
      !validIdentity(owner) ||
      !validIdentity(session) ||
      typeof locator !== 'string' ||
      !LOCATOR_PATTERN.test(locator)
    ) {
      return null;
    }
    const record = records.get(locator);
    return record && record.owner === owner && record.session === session ? record : null;
  }

  return {
    put(owner, session, value) {
      const record = prepareRecord(owner, session, value);
      if (!record) return null;
      const locator = 'hca_' + randomUUID().replace(/-/g, '');
      records.set(locator, record);
      retainedBytes += record.bytes;
      return receipt(locator, record);
    },

    beginTransaction(owner, session) {
      if (closed || !validIdentity(owner) || !validIdentity(session)) return null;
      const staged = new Set();
      const reservationToken = {};
      let settled = false;
      let result = null;
      let committedReferences = null;
      function rollback() {
        if (settled) return false;
        for (const locator of staged.keys()) pendingRecords.delete(locator);
        staged.clear();
        settled = true;
        return true;
      }
      function fail(reason) {
        rollback();
        return { ok: false, reason };
      }
      return {
        stats() {
          return { stagedEntries: staged.size };
        },
        put(candidateOwner, candidateSession, value) {
          if (settled || candidateOwner !== owner || candidateSession !== session) return null;
          const record = prepareRecord(owner, session, value);
          if (!record) return null;
          const locator = 'hca_' + randomUUID().replace(/-/g, '');
          staged.add(locator);
          record.reservationToken = reservationToken;
          pendingRecords.set(locator, record);
          return receipt(locator, record);
        },
        commit(references) {
          if (!Array.isArray(references) || references.length > maxEntries) {
            return settled ? { ok: false, reason: 'settled' } : fail('invalid_references');
          }
          const selected = new Map();
          for (const reference of references) {
            if (
              !reference ||
              typeof reference !== 'object' ||
              Array.isArray(reference) ||
              typeof reference.locator !== 'string' ||
              !LOCATOR_PATTERN.test(reference.locator) ||
              reference.scope !== session ||
              !safeDigestEqual(reference.digest, reference.digest) ||
              (selected.has(reference.locator) &&
                selected.get(reference.locator) !== reference.digest)
            ) {
              return settled ? { ok: false, reason: 'settled' } : fail('invalid_references');
            }
            selected.set(reference.locator, reference.digest);
          }
          const key = JSON.stringify([...selected].sort(([a], [b]) => a.localeCompare(b)));
          if (settled)
            return key === committedReferences ? { ...result } : { ok: false, reason: 'settled' };
          if (closed || pruneExpired() === null) return fail('store_unavailable');
          // Validate the complete write set first. No partial publication if a
          // required reservation expired or its identity no longer matches.
          for (const [locator, digest] of selected) {
            if (!staged.has(locator)) continue;
            const record = pendingRecords.get(locator);
            if (
              record?.reservationToken !== reservationToken ||
              !safeDigestEqual(record.digest, digest)
            ) {
              return fail('reservation_unavailable');
            }
          }
          let committedEntries = 0;
          const stagedEntries = staged.size;
          for (const locator of staged) {
            const record = pendingRecords.get(locator);
            pendingRecords.delete(locator);
            if (!selected.has(locator)) continue;
            delete record.reservationToken;
            records.set(locator, record);
            retainedBytes += record.bytes;
            committedEntries += 1;
          }
          staged.clear();
          settled = true;
          committedReferences = key;
          result = {
            ok: true,
            committedEntries,
            discardedEntries: stagedEntries - committedEntries,
          };
          return { ...result };
        },
        rollback,
      };
    },

    read(owner, session, locator, expectedDigest) {
      const record = ownedRecord(owner, session, locator);
      if (!record) return { ok: false, reason: 'not_found' };
      const actualDigest = digestPayload(record.payload);
      if (!safeDigestEqual(actualDigest, record.digest)) {
        remove(locator);
        return { ok: false, reason: 'integrity_failed' };
      }
      if (expectedDigest !== undefined && !safeDigestEqual(actualDigest, expectedDigest)) {
        return { ok: false, reason: 'digest_mismatch' };
      }
      const value = deserializeArtifact(record);
      if (value === undefined) {
        remove(locator);
        return { ok: false, reason: 'integrity_failed' };
      }
      renewRecord(record);
      return {
        ok: true,
        value,
        bytes: record.bytes,
        digest: record.digest,
        expiresAt: record.expiresAt,
      };
    },

    readPage(owner, session, locator, expectedDigest, range, maxResultBytes) {
      const record = ownedRecord(owner, session, locator);
      if (
        !record ||
        !safeDigestEqual(digestPayload(record.payload), record.digest) ||
        !safeDigestEqual(record.digest, expectedDigest)
      ) {
        return { ok: false, error: 'context_artifact_unavailable' };
      }
      const result = buildContextArtifactPage(
        record.payload,
        record.encoding,
        record.digest,
        range,
        maxResultBytes
      );
      if (result.ok === true) renewRecord(record);
      return result;
    },

    renew(owner, session, locator, expectedDigest) {
      const record = ownedRecord(owner, session, locator);
      if (
        !record ||
        !safeDigestEqual(record.digest, expectedDigest) ||
        !safeDigestEqual(digestPayload(record.payload), record.digest)
      ) {
        return { ok: false, reason: 'not_found' };
      }
      renewRecord(record);
      return { ok: true, expiresAt: record.expiresAt, hardExpiresAt: record.hardExpiresAt };
    },

    renewReferences(owner, references, requestedExpiresAt) {
      const unavailable = { ok: false, reason: 'not_found' };
      if (
        closed ||
        !validIdentity(owner) ||
        !Array.isArray(references) ||
        references.length > 256 ||
        Object.getPrototypeOf(references) !== Array.prototype ||
        Reflect.ownKeys(references).length !== references.length + 1 ||
        !Number.isSafeInteger(requestedExpiresAt)
      )
        return unavailable;
      const current = pruneExpired();
      if (current === null || requestedExpiresAt <= current) return unavailable;
      const selected = new Map();
      for (let index = 0; index < references.length; index++) {
        const slot = Object.getOwnPropertyDescriptor(references, String(index));
        if (!slot || !Object.hasOwn(slot, 'value')) return unavailable;
        const ref = slot.value;
        if (
          !ref ||
          typeof ref !== 'object' ||
          Array.isArray(ref) ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(ref)) ||
          Reflect.ownKeys(ref).some((key) => typeof key !== 'string') ||
          Object.keys(ref).sort().join(',') !== 'bytes,digest,kind,locator,scope'
        )
          return unavailable;
        const data = {};
        for (const key of Reflect.ownKeys(ref)) {
          const descriptor = Object.getOwnPropertyDescriptor(ref, key);
          if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
            return unavailable;
          data[key] = descriptor.value;
        }
        if (
          data.kind !== 'local_compaction_evidence' ||
          typeof data.locator !== 'string' ||
          !LOCATOR_PATTERN.test(data.locator) ||
          typeof data.scope !== 'string' ||
          !/^hcs_[a-f0-9]{32}$/.test(data.scope) ||
          !Number.isSafeInteger(data.bytes) ||
          data.bytes < 1 ||
          data.bytes > maxArtifactBytes
        )
          return unavailable;
        const record = records.get(data.locator);
        if (
          !record ||
          record.owner !== owner ||
          record.session !== data.scope ||
          record.bytes !== data.bytes ||
          !safeDigestEqual(record.digest, data.digest) ||
          !safeDigestEqual(digestPayload(record.payload), record.digest)
        )
          return unavailable;
        selected.set(data.locator, record);
      }
      const expiresAt = Math.min(
        requestedExpiresAt,
        current + ttlMs,
        ...[...selected.values()].map((record) => record.hardExpiresAt)
      );
      if (expiresAt <= current) return unavailable;
      // Validate the entire private index before changing any record. Never
      // resurrect expired evidence or extend its absolute lifetime.
      for (const record of selected.values())
        record.expiresAt = Math.max(record.expiresAt, expiresAt);
      return { ok: true, expiresAt };
    },

    discard(owner, session, locator) {
      return ownedRecord(owner, session, locator) ? remove(locator) : false;
    },

    discardSession(owner, session) {
      pruneExpired();
      if (!validIdentity(owner) || !validIdentity(session)) return 0;
      let removed = 0;
      for (const [locator, record] of records) {
        if (record.owner === owner && record.session === session && remove(locator)) removed += 1;
      }
      for (const [locator, record] of pendingRecords) {
        if (record.owner === owner && record.session === session) pendingRecords.delete(locator);
      }
      return removed;
    },

    stats() {
      pruneExpired();
      return { entries: records.size, retainedBytes, maxEntries, maxBytes, maxArtifactBytes };
    },

    lifecyclePolicy() {
      return { ttlMs, ...lifecycle, persistence: 'memory' };
    },

    close() {
      closed = true;
      records.clear();
      pendingRecords.clear();
      retainedBytes = 0;
    },
  };
}

module.exports = {
  DEFAULT_MAX_ARTIFACT_BYTES,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
  LOCATOR_PATTERN,
  createContextArtifactStore,
};
