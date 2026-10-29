'use strict';

const { types } = require('node:util');
const failures = new WeakMap();

function fail(code) {
  const error = new Error(code);
  failures.set(error, code);
  throw error;
}

function failureCode(value, fallback) {
  return failures.get(value) ?? fallback;
}

function record(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(value, name, code) {
  if (!record(value)) fail(code);
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) fail(code);
  return descriptor.value;
}

function callable(value) {
  return typeof value === 'function' && !types.isProxy(value);
}

function methods(value, names, code) {
  const result = {};
  for (const name of names) {
    const method = own(value, name, code);
    if (!callable(method)) fail(code);
    result[name] = (...args) => Reflect.apply(method, value, args);
  }
  return result;
}

// Box synchronous results before await can inspect a hostile `then` property.
// Native promises use the intrinsic method; custom thenables are never invoked.
function settle(value, code) {
  if (types.isProxy(value)) fail(code);
  if (!types.isPromise(value)) return Promise.resolve({ value });
  if (Object.getPrototypeOf(value) !== Promise.prototype || Object.hasOwn(value, 'constructor'))
    fail(code);
  return new Promise((resolve, reject) => {
    Reflect.apply(Promise.prototype.then, value, [
      (result) => {
        if (types.isProxy(result)) {
          try {
            fail(code);
          } catch (error) {
            reject(error);
          }
        } else resolve({ value: result });
      },
      reject,
    ]);
  });
}

// JSON-compatible own-data snapshots never evaluate getters, Proxy traps,
// coercion hooks or toJSON. Limits also bound hostile depth/width and cycles.
function dataSnapshot(value, code) {
  const seen = new Set();
  let nodes = 0;
  let stringBytes = 0;
  function visit(current, depth) {
    if (++nodes > 20000 || depth > 32) fail(code);
    if (typeof current === 'string') {
      stringBytes += Buffer.byteLength(current);
      if (stringBytes > 256 * 1024) fail(code);
      return current;
    }
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'number' && Number.isFinite(current)) return current;
    if (typeof current !== 'object' || types.isProxy(current) || seen.has(current)) fail(code);
    const array = Array.isArray(current);
    if (!array && !record(current)) fail(code);
    if (array && current.length > 20000) fail(code);
    seen.add(current);
    const output = array ? [] : Object.create(null);
    const keys = Reflect.ownKeys(current);
    if (keys.length > 20000) fail(code);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') fail(code);
      stringBytes += Buffer.byteLength(key);
      if (stringBytes > 256 * 1024) fail(code);
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= current.length)) fail(code);
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail(code);
      Object.defineProperty(output, key, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
        writable: true,
      });
    }
    if (array && output.length !== current.length) fail(code);
    seen.delete(current);
    return output;
  }
  return visit(value, 0);
}

module.exports = { fail, failureCode, record, own, callable, methods, settle, dataSnapshot };
