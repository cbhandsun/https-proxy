'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { isProxy } = require('node:util').types;
const { isWellFormedEvidenceText } = require('./context-evidence-utf8');

const normalized = new WeakMap();
const reusableHistories = new WeakSet();
const invalid = () => new TypeError('invalid_context_history_request');
const fields = ['principal', 'protocol', 'target', 'policy', 'history', 'previousResponseId'];
const messageFields = new Set(['role', 'content', 'tool_call_id']);
const dataSlot = (slot) => slot?.enumerable && Object.hasOwn(slot, 'value');

function recoveryHistoryRequestLimit(format) {
  if (format === 2) return 2 * 1024 * 1024;
  if (format === 3) return 32 * 1024 * 1024;
  throw invalid();
}

// A per-request immutable clone, never a transcript cache. Metadata and every
// individual history item retain the old 2 MiB bound. Aggregate bytes, depth
// and nodes remain checked across all items; no giant JSON string is required.
function normalizeRecoveryHistoryRequest(input, format = 2) {
  const maximum = recoveryHistoryRequestLimit(format);
  const prior = normalized.get(input);
  if (prior) {
    if (prior.bytes > maximum) throw invalid();
    return input;
  }
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid();
  const metadata = Object.create(null);
  let history;
  for (const name of Reflect.ownKeys(input)) {
    const slot = Object.getOwnPropertyDescriptor(input, name);
    if (!fields.includes(name) || !slot?.enumerable || !Object.hasOwn(slot, 'value'))
      throw invalid();
    if (name === 'history') history = slot.value;
    else metadata[name] = slot.value;
  }
  const length = history && Object.getOwnPropertyDescriptor(history, 'length')?.value;
  if (
    !Array.isArray(history) ||
    Object.getPrototypeOf(history) !== Array.prototype ||
    !Number.isSafeInteger(length) ||
    length > 16384 ||
    Reflect.ownKeys(history).length !== length + 1
  )
    throw invalid();
  const value = normalizeCompactionData(metadata, 2 * 1024 * 1024);
  value.history = [];
  let bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > maximum) throw invalid();
  let nodes = 65536;
  function seal(item, depth) {
    if (depth > 64 || --nodes < 0) throw invalid();
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) seal(child, depth + 1);
      Object.freeze(item);
    }
  }
  // Include the outer object, metadata and history array in the shared budget.
  seal(value, 0);
  // The array must be filled before freezing; only its empty initial accounting
  // was needed above. Recreate it while retaining the same counted container.
  const stringBytes = new Map();
  let cachedBytes = 0;
  const ancestors = new Set();
  function encodedBytes(text) {
    const prior = stringBytes.get(text);
    if (prior !== undefined) return prior;
    const raw = Buffer.byteLength(text);
    if (raw > 2 * 1024 * 1024) throw invalid();
    // JSON leaves C1 controls and paired surrogates intact. Use native
    // well-formedness plus a code-unit scan for wide text, retaining the ASCII
    // path and native escaping for C0 controls and lone surrogate units.
    const escaping =
      raw === text.length
        ? /["\\\p{Cc}\p{Cs}]/u.test(text)
        : /["\\]|[^\u0020-\uffff]/.test(text) || !isWellFormedEvidenceText(text);
    const count = escaping ? Buffer.byteLength(JSON.stringify(text)) : raw + 2;
    if (stringBytes.size < 128 && cachedBytes + raw <= 4 * 1024 * 1024) {
      stringBytes.set(text, count);
      cachedBytes += raw;
    }
    return count;
  }
  function spend(budget, count) {
    budget.bytes -= count;
    if (budget.bytes < 0) throw invalid();
  }
  // Exact fixed wire shape only. Failure to match does not spend a budget;
  // unknown JSON keeps the descriptor-only generic traversal.
  function cloneFunctionMessage(item, keys, depth, budget) {
    const role = Object.getOwnPropertyDescriptor(item, 'role');
    const content = Object.getOwnPropertyDescriptor(item, 'content');
    const calls = Object.getOwnPropertyDescriptor(item, 'tool_calls');
    if (
      !dataSlot(role) ||
      role.value !== 'assistant' ||
      !dataSlot(content) ||
      content.value !== null ||
      !dataSlot(calls)
    )
      return null;
    const list = calls.value;
    if (
      isProxy(list) ||
      !Array.isArray(list) ||
      Object.getPrototypeOf(list) !== Array.prototype ||
      list.length !== 1 ||
      Reflect.ownKeys(list).length !== 2
    )
      return null;
    const slot = Object.getOwnPropertyDescriptor(list, '0');
    const call = dataSlot(slot) ? slot.value : null;
    if (
      !call ||
      isProxy(call) ||
      typeof call !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(call))
    )
      return null;
    const callKeys = Reflect.ownKeys(call);
    if (
      callKeys.length !== 3 ||
      !callKeys.every((name) => ['id', 'type', 'function'].includes(name))
    )
      return null;
    const id = Object.getOwnPropertyDescriptor(call, 'id');
    const type = Object.getOwnPropertyDescriptor(call, 'type');
    const fn = Object.getOwnPropertyDescriptor(call, 'function');
    if (
      !dataSlot(id) ||
      typeof id.value !== 'string' ||
      !dataSlot(type) ||
      type.value !== 'function' ||
      !dataSlot(fn)
    )
      return null;
    const value = fn.value;
    if (
      !value ||
      isProxy(value) ||
      typeof value !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      return null;
    const functionKeys = Reflect.ownKeys(value);
    if (
      functionKeys.length !== 2 ||
      !functionKeys.every((name) => ['name', 'arguments'].includes(name))
    )
      return null;
    const name = Object.getOwnPropertyDescriptor(value, 'name');
    const args = Object.getOwnPropertyDescriptor(value, 'arguments');
    if (
      !dataSlot(name) ||
      typeof name.value !== 'string' ||
      !dataSlot(args) ||
      typeof args.value !== 'string'
    )
      return null;
    // Ten occurrence nodes total, root already charged. Every record's
    // descendants cover its own-key reserve; the singleton array has six
    // descendant nodes, exceeding its two-own-key reserve. No prefix requires
    // more than nine remaining nodes, regardless of property order.
    nodes -= 9;
    if (nodes < 0 || depth + 4 > 64) throw invalid();
    // Punctuation, keys, assistant/null/function cost 110 bytes. The three
    // variable JSON strings keep encoded/raw and per-item byte admission.
    spend(
      budget,
      110 + encodedBytes(id.value) + encodedBytes(name.value) + encodedBytes(args.value)
    );
    const copiedFunction = Object.create(null);
    for (const key of functionKeys) copiedFunction[key] = key === 'name' ? name.value : args.value;
    Object.freeze(copiedFunction);
    const copiedCall = Object.create(null);
    for (const key of callKeys)
      copiedCall[key] = key === 'id' ? id.value : key === 'type' ? type.value : copiedFunction;
    Object.freeze(copiedCall);
    const copiedCalls = Object.freeze([copiedCall]);
    const output = Object.create(null);
    for (const key of keys)
      output[key] = key === 'role' ? role.value : key === 'content' ? null : copiedCalls;
    return Object.freeze(output);
  }
  function clone(item, depth, budget) {
    if (depth > 64 || --nodes < 0) throw invalid();
    if (typeof item === 'string') {
      spend(budget, encodedBytes(item));
      return item;
    }
    if (
      item === null ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    ) {
      spend(budget, JSON.stringify(item).length);
      return item;
    }
    if (!item || typeof item !== 'object' || ancestors.has(item)) throw invalid();
    const array = Array.isArray(item);
    if (
      array
        ? Object.getPrototypeOf(item) !== Array.prototype
        : ![Object.prototype, null].includes(Object.getPrototypeOf(item))
    )
      throw invalid();
    const keys = Reflect.ownKeys(item);
    if (keys.length > nodes || (array && (item.length > nodes || keys.length !== item.length + 1)))
      throw invalid();
    if (
      !array &&
      !isProxy(item) &&
      keys.length === 3 &&
      keys.every((name) => ['role', 'content', 'tool_calls'].includes(name))
    ) {
      const copied = cloneFunctionMessage(item, keys, depth, budget);
      if (copied) return copied;
    }
    // Common wire messages have only scalar slots. Validate the same own-data
    // descriptors and shared budgets, but avoid a recursive clone per scalar.
    // Unknown fields or structured content continue through the general path.
    if (
      !array &&
      (keys.length === 2 || keys.length === 3) &&
      keys.every((name) => messageFields.has(name))
    ) {
      const role = Object.getOwnPropertyDescriptor(item, 'role');
      const content = Object.getOwnPropertyDescriptor(item, 'content');
      const call = Object.getOwnPropertyDescriptor(item, 'tool_call_id');
      if (
        dataSlot(role) &&
        dataSlot(content) &&
        (!call || dataSlot(call)) &&
        typeof role.value === 'string' &&
        (typeof content.value === 'string' || content.value === null) &&
        (!call || typeof call.value === 'string')
      ) {
        nodes -= call ? 3 : 2;
        if (nodes < 0 || depth + 1 > 64) throw invalid();
        spend(
          budget,
          20 +
            encodedBytes(role.value) +
            (content.value === null ? 4 : encodedBytes(content.value)) +
            (call ? 16 + encodedBytes(call.value) : 0)
        );
        let output;
        if (keys[0] === 'role' && keys[1] === 'content') {
          output = call
            ? {
                __proto__: null,
                role: role.value,
                content: content.value,
                tool_call_id: call.value,
              }
            : { __proto__: null, role: role.value, content: content.value };
        } else if (keys[0] === 'role' && keys[1] === 'tool_call_id') {
          output = {
            __proto__: null,
            role: role.value,
            tool_call_id: call.value,
            content: content.value,
          };
        } else {
          output = Object.create(null);
          for (const name of keys)
            output[name] =
              name === 'role' ? role.value : name === 'content' ? content.value : call.value;
        }
        return Object.freeze(output);
      }
    }
    if (array && item.length === 1) {
      const slot = Object.getOwnPropertyDescriptor(item, '0');
      if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw invalid();
      ancestors.add(item);
      spend(budget, 2);
      // An array literal creates its own data slot without inherited setters.
      // Keep the shared cycle, depth, node and encoded-byte accounting.
      const output = [clone(slot.value, depth + 1, budget)];
      ancestors.delete(item);
      return Object.freeze(output);
    }
    const output = array ? [] : Object.create(null);
    ancestors.add(item);
    spend(budget, 2);
    const length = array ? item.length : keys.length;
    for (let index = 0; index < length; index++) {
      const name = array ? String(index) : keys[index];
      const slot = Object.getOwnPropertyDescriptor(item, name);
      if (typeof name !== 'string' || !slot?.enumerable || !Object.hasOwn(slot, 'value'))
        throw invalid();
      spend(budget, (index ? 1 : 0) + (array ? 0 : encodedBytes(name) + 1));
      const child = clone(slot.value, depth + 1, budget);
      // Records have no inherited setters, including __proto__. Array numeric
      // slots still require an own descriptor before their final freeze.
      if (!array) output[name] = child;
      else
        Object.defineProperty(output, name, {
          value: child,
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
    ancestors.delete(item);
    return Object.freeze(output);
  }
  // Array.from creates own data slots without consulting numeric setters.
  // The count carrier has no inherited iterator; every source slot is still
  // read through its descriptor and validated before it enters the result.
  const items = Array.from({ __proto__: null, length }, (_, index) => {
    const slot = Object.getOwnPropertyDescriptor(history, String(index));
    if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw invalid();
    const budget = { bytes: 2 * 1024 * 1024 };
    const item = clone(slot.value, 2, budget);
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw invalid();
    bytes += 2 * 1024 * 1024 - budget.bytes + (index ? 1 : 0);
    if (bytes > maximum) throw invalid();
    return item;
  });
  const result = Object.freeze({ ...value, history: Object.freeze(items) });
  normalized.set(result, { bytes });
  return result;
}

// Only the internal multi-probe owner opts a completed immutable request in.
// This is digest reuse, never snapshot/read authority or a transcript cache.
function enableRecoveryHistoryDigestReuse(input) {
  if (!normalized.has(input)) throw invalid();
  reusableHistories.add(input.history);
}

function isReusableRecoveryHistory(input) {
  return reusableHistories.has(input);
}

function recoveryHistoryRequestBytes(input) {
  const info = normalized.get(input);
  if (!info) throw invalid();
  return info.bytes;
}

module.exports = {
  normalizeRecoveryHistoryRequest,
  recoveryHistoryRequestBytes,
  recoveryHistoryRequestLimit,
  enableRecoveryHistoryDigestReuse,
  isReusableRecoveryHistory,
};
