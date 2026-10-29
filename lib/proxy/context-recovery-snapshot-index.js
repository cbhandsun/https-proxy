'use strict';

const snapshots = new WeakMap();
const invalid = () => new TypeError('invalid_recovery_snapshot_index');

// A fixed 256-byte negative-membership hint per branch. It contains no keys or
// values and can only rule out a string that was never added. Collisions always
// fall back to exact Map lookup; the hint can never grant branch membership.
function stringMembershipBit(key) {
  if (typeof key !== 'string' || key.length > 256) return null;
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++)
    hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  return hash & 2047;
}

// Private append-only indexes. A child references only a sealed parent, so
// later requests cannot mutate an ancestor or observe a sibling's additions.
// No transcript, authority, expiry or persisted wire representation lives here.
function createIndex(parent, kind) {
  const prior = parent === undefined ? null : snapshots.get(parent);
  if (parent !== undefined && (!prior || prior.kind !== kind)) throw invalid();
  const depth = (prior?.depth ?? 0) + 1;
  if (depth > 4096) throw invalid();
  const node = { parent: prior, kind, depth, entries: new Map(), size: prior?.size ?? 0 };
  const membership = prior ? new Uint32Array(prior.membership) : new Uint32Array(64);
  node.membership = membership;
  let sealed = false;
  let snapshot;
  function has(key) {
    const bit = stringMembershipBit(key);
    if (bit !== null && !(membership[bit >>> 5] & (1 << (bit & 31)))) return false;
    for (let current = node; current; current = current.parent)
      if (current.entries.has(key)) return true;
    return false;
  }
  function get(key) {
    const bit = stringMembershipBit(key);
    if (bit !== null && !(membership[bit >>> 5] & (1 << (bit & 31)))) return undefined;
    for (let current = node; current; current = current.parent)
      if (current.entries.has(key)) return current.entries.get(key);
    return undefined;
  }
  function* entries() {
    const chain = [];
    for (let current = node; current; current = current.parent) chain.push(current);
    for (let index = chain.length - 1; index >= 0; index--) yield* chain[index].entries.entries();
  }
  function* keys() {
    for (const [key] of entries()) yield key;
  }
  function* values() {
    for (const [, value] of entries()) yield value;
  }
  function add(key, value) {
    if (sealed || has(key)) throw invalid();
    node.entries.set(key, value);
    const bit = stringMembershipBit(key);
    if (bit !== null) membership[bit >>> 5] |= 1 << (bit & 31);
    node.size++;
    return builder;
  }
  function view() {
    return {
      get size() {
        return node.size;
      },
      has,
      ...(kind === 'map' ? { get, entries, keys, values } : {}),
      [Symbol.iterator]: kind === 'map' ? entries : keys,
    };
  }
  // Each factory call owns a fresh view with its live size accessor. Reuse
  // that object directly instead of materializing and copying descriptors.
  const builder = view();
  Object.assign(builder, kind === 'map' ? { set: add } : { add: (key) => add(key, true) });
  Object.assign(builder, {
    freeze() {
      if (!snapshot) {
        sealed = true;
        snapshot = Object.freeze(view());
        snapshots.set(snapshot, node);
      }
      return snapshot;
    },
  });
  return Object.freeze(builder);
}

function createRecoverySnapshotMap(parent) {
  return createIndex(parent, 'map');
}
function createRecoverySnapshotSet(parent) {
  return createIndex(parent, 'set');
}
function recoverySnapshotOwnEntries(snapshot) {
  const node = snapshots.get(snapshot);
  if (!node) throw invalid();
  return node.kind === 'map' ? node.entries.entries() : node.entries.keys();
}
function inspectRecoverySnapshotIndex(snapshot) {
  const node = snapshots.get(snapshot);
  if (!node) throw invalid();
  return Object.freeze({ size: node.size, ownEntries: node.entries.size, depth: node.depth });
}

module.exports = {
  createRecoverySnapshotMap,
  createRecoverySnapshotSet,
  recoverySnapshotOwnEntries,
  inspectRecoverySnapshotIndex,
};
