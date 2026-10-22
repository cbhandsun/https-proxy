'use strict';

const { ENTRY_AUTH_HEADERS } = require('./entry-auth');

const CONTEXT_HEADERS = new Set([
  'x-hpm-evidence-token',
  'x-hpm-context-target',
  'x-hpm-tool-discovery',
]);
const ENTRY_HEADERS = new Set(ENTRY_AUTH_HEADERS);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

function validText(value) {
  return value.length <= 65536 && HEADER_VALUE.test(value);
}

// A fresh copy preserves ingress capabilities for local checks. Never invoke
// accessors or stringify unknown values while preparing upstream headers.
function createContextForwardHeaders(input, stripEntryCredentials = false) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    typeof stripEntryCredentials !== 'boolean'
  ) {
    throw new TypeError('Invalid context transport headers');
  }
  if (Object.keys(input).length > 1024) throw new TypeError('Invalid context transport headers');
  const result = Object.create(null);
  for (const key of Object.keys(input)) {
    const name = key.toLowerCase();
    if (CONTEXT_HEADERS.has(name) || (stripEntryCredentials && ENTRY_HEADERS.has(name))) continue;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!HEADER_NAME.test(key) || !descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Invalid context transport headers');
    }
    const value = descriptor.value;
    if (value === undefined) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && !Array.isArray(value)) {
      throw new TypeError('Invalid context transport headers');
    }
    if (
      (typeof value === 'string' && !validText(value)) ||
      (typeof value === 'number' && !Number.isFinite(value))
    ) {
      throw new TypeError('Invalid context transport headers');
    }
    if (Array.isArray(value)) {
      if (value.length > 1024) throw new TypeError('Invalid context transport headers');
      const copy = [];
      for (let i = 0; i < value.length; i++) {
        const item = Object.getOwnPropertyDescriptor(value, String(i));
        if (
          !item ||
          !Object.hasOwn(item, 'value') ||
          typeof item.value !== 'string' ||
          !validText(item.value)
        ) {
          throw new TypeError('Invalid context transport headers');
        }
        copy.push(item.value);
      }
      result[key] = copy;
    } else result[key] = value;
  }
  return result;
}

module.exports = { createContextForwardHeaders };
