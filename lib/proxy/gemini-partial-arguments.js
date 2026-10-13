'use strict';

const { createConversionStreamBudget } = require('./conversion-stream-budget');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function invalid() {
  const error = new TypeError('Invalid or incomplete Gemini partial arguments');
  error.code = 'upstream_stream_invalid_tool_arguments';
  throw error;
}
function serialize(value) {
  try {
    return JSON.stringify(value);
  } catch {
    invalid();
  }
}

// Provider paths address one field. Query selectors (wildcards, slices, filters,
// descendants and unions) cannot identify one writable argument and are rejected.
function parseArgumentPath(path) {
  if (typeof path !== 'string' || path.length > 4096 || !path.startsWith('$')) invalid();
  const keys = [];
  let offset = 1;
  while (offset < path.length) {
    if (keys.length >= 64) invalid();
    if (path[offset] === '.') {
      const match = path
        .slice(offset + 1)
        .match(/^[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*/u);
      if (!match) invalid();
      keys.push(match[0]);
      offset += match[0].length + 1;
    } else if (path[offset] === '[') {
      offset++;
      const quote = path[offset];
      if (quote === '"' || quote === "'") {
        offset++;
        let value = '';
        let closed = false;
        while (offset < path.length) {
          const character = path[offset++];
          if (character === quote) {
            closed = true;
            break;
          }
          if (character.charCodeAt(0) < 32) invalid();
          if (character !== '\\') {
            value += character;
            continue;
          }
          const escape = path[offset++];
          if (escape === 'u') {
            const hex = path.slice(offset, offset + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) invalid();
            value += String.fromCharCode(Number.parseInt(hex, 16));
            offset += 4;
          } else {
            const escapes = {
              '"': '"',
              "'": "'",
              '\\': '\\',
              '/': '/',
              b: '\b',
              f: '\f',
              n: '\n',
              r: '\r',
              t: '\t',
            };
            if (!has(escapes, escape)) invalid();
            value += escapes[escape];
          }
        }
        if (!closed || path[offset++] !== ']') invalid();
        keys.push(value);
      } else {
        const match = path.slice(offset).match(/^(0|[1-9][0-9]*)\]/);
        if (!match) invalid();
        const index = Number(match[1]);
        if (!Number.isSafeInteger(index) || index >= 4096) invalid();
        keys.push(index);
        offset += match[0].length;
      }
    } else invalid();
  }
  if (!keys.length || typeof keys[0] !== 'string') invalid();
  for (const key of keys)
    if (
      typeof key === 'string' &&
      (key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key))
    )
      invalid();
  return keys;
}

function partialValue(part) {
  if (!record(part) || (part.willContinue != null && typeof part.willContinue !== 'boolean'))
    invalid();
  const fields = ['stringValue', 'numberValue', 'boolValue', 'nullValue'].filter((key) =>
    has(part, key)
  );
  if (fields.length !== 1) invalid();
  const key = fields[0];
  const value = part[key];
  if (
    (key === 'stringValue' && typeof value !== 'string') ||
    (key === 'numberValue' && (typeof value !== 'number' || !Number.isFinite(value))) ||
    (key === 'boolValue' && typeof value !== 'boolean') ||
    (key === 'nullValue' && value !== 'NULL_VALUE') ||
    (part.willContinue === true && key !== 'stringValue')
  )
    invalid();
  return key === 'nullValue' ? null : value;
}

function assertDense(value) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!has(value, index)) invalid();
      assertDense(value[index]);
    }
  } else if (record(value)) for (const child of Object.values(value)) assertDense(child);
}

function snapshotLeaves(value, keys = [], leaves = []) {
  if (keys.length > 64) invalid();
  if (record(value) || Array.isArray(value)) {
    if (Array.isArray(value) && value.length > 4096) invalid();
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) invalid();
      for (let index = 0; index < value.length; index++) if (!has(value, index)) invalid();
    }
    const entries = Object.entries(value);
    if (!entries.length && keys.length)
      leaves.push({ keys, value: Array.isArray(value) ? [] : {} });
    for (const [key, child] of entries) {
      if (key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid();
      snapshotLeaves(child, [...keys, Array.isArray(value) ? Number(key) : key], leaves);
    }
  } else {
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      !(typeof value === 'number' && Number.isFinite(value))
    )
      invalid();
    leaves.push({ keys, value });
  }
  return leaves;
}

function createGeminiPartialArguments(protocolOptions = {}) {
  const budget = createConversionStreamBudget(protocolOptions);
  const count = {};
  const calls = new Map();
  let anonymous = 0;
  function find(call) {
    if (call.id != null) {
      const matched = [...calls.values()].find((entry) => entry.id === call.id);
      if (matched) return matched;
      const unnamed = [...calls.values()].filter(
        (entry) => !entry.id && !entry.closed && (!call.name || entry.name === call.name)
      );
      if (unnamed.length > 1) invalid();
      if (unnamed.length) {
        unnamed[0].id = call.id;
        return unnamed[0];
      }
      return undefined;
    }
    const open = [...calls.values()].filter(
      (entry) => !entry.closed && (!call.name || entry.name === call.name)
    );
    if (open.length > 1) invalid();
    return open[0];
  }
  function accepts(call) {
    return (
      call.partialArgs != null ||
      call.willContinue === true ||
      (call.id != null
        ? [...calls.values()].some(
            (entry) =>
              entry.id === call.id ||
              (!entry.id && !entry.closed && (!call.name || entry.name === call.name))
          )
        : [...calls.values()].some(
            (entry) => !entry.closed && (!call.name || entry.name === call.name)
          ))
    );
  }
  function append(call, thoughtSignature) {
    if (
      !record(call) ||
      (call.id != null && (typeof call.id !== 'string' || !call.id)) ||
      (call.name != null && (typeof call.name !== 'string' || !call.name.trim())) ||
      (call.willContinue != null && typeof call.willContinue !== 'boolean') ||
      (call.partialArgs != null && !Array.isArray(call.partialArgs))
    )
      invalid();
    let entry = find(call);
    if (!entry) {
      if (!call.name) invalid();
      budget.addTool(count);
      entry = {
        id: call.id,
        name: call.name,
        args: {},
        paths: new Map(),
        branches: new Set(),
        openPaths: new Set(),
        closed: false,
      };
      calls.set(call.id || Symbol('anonymous_' + anonymous++), entry);
    }
    if (
      entry.closed ||
      (call.name && call.name !== entry.name) ||
      (thoughtSignature != null && typeof thoughtSignature !== 'string')
    )
      invalid();
    if (thoughtSignature) {
      if (entry.thoughtSignature && entry.thoughtSignature !== thoughtSignature) invalid();
      entry.thoughtSignature = thoughtSignature;
    }
    budget.appendArguments(entry, serialize(call));
    function assign(keys, value, continuing, snapshot = false) {
      const path = JSON.stringify(keys);
      const old = entry.paths.get(path);
      if (old) {
        if (snapshot) {
          if (entry.openPaths.has(path)) {
            if (
              typeof old.value !== 'string' ||
              typeof value !== 'string' ||
              !value.startsWith(old.value)
            )
              invalid();
          } else if (JSON.stringify(old.value) !== JSON.stringify(value)) invalid();
        } else {
          if (
            !entry.openPaths.has(path) ||
            typeof old.value !== 'string' ||
            typeof value !== 'string'
          )
            invalid();
          value = old.value + value;
        }
      } else {
        if (entry.branches.has(path)) invalid();
        for (let length = 1; length < keys.length; length++) {
          const prefix = JSON.stringify(keys.slice(0, length));
          if (entry.paths.has(prefix)) invalid();
          entry.branches.add(prefix);
        }
      }
      entry.paths.set(path, { keys, value });
      if (continuing) entry.openPaths.add(path);
      else entry.openPaths.delete(path);
      let container = entry.args;
      for (let index = 0; index < keys.length - 1; index++) {
        const key = keys[index];
        const array = typeof keys[index + 1] === 'number';
        if (!has(container, key)) container[key] = array ? [] : {};
        if (Array.isArray(container[key]) !== array || (!array && !record(container[key])))
          invalid();
        container = container[key];
      }
      const last = keys.at(-1);
      if (Array.isArray(container) !== (typeof last === 'number')) invalid();
      container[last] = value;
    }
    for (const part of call.partialArgs || [])
      assign(parseArgumentPath(part?.jsonPath), partialValue(part), part.willContinue === true);
    const sources = ['args', 'arguments', 'parameters', 'input'].filter((key) => has(call, key));
    if (sources.length > 1) invalid();
    if (sources.length) {
      let snapshot = call[sources[0]];
      if (typeof snapshot === 'string') {
        try {
          snapshot = JSON.parse(snapshot);
        } catch {
          invalid();
        }
      }
      if (!record(snapshot)) invalid();
      for (const leaf of snapshotLeaves(snapshot))
        assign(
          leaf.keys,
          leaf.value,
          call.willContinue === true && typeof leaf.value === 'string',
          true
        );
    }
    budget.appendArguments({}, serialize(entry.args));
    if (call.willContinue !== true) {
      if (entry.openPaths.size) invalid();
      assertDense(entry.args);
      entry.closed = true;
    }
    return entry;
  }
  function finish({ discard = false } = {}) {
    if (discard) {
      calls.clear();
      return [];
    }
    const output = [...calls.values()];
    if (output.some((entry) => !entry.closed || entry.openPaths.size)) invalid();
    calls.clear();
    return output.map(({ id, name, args, thoughtSignature }) => ({
      id,
      name,
      args,
      thoughtSignature,
    }));
  }
  return { accepts, append, finish, clear: () => calls.clear() };
}
module.exports = { createGeminiPartialArguments, parseArgumentPath };
