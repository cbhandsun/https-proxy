'use strict';

// Search history is context only: no URL is fetched and no executable tool is emitted.
function invalid() {
  const error = new TypeError('Invalid Responses web search history');
  error.code = 'invalid_request_error';
  throw error;
}
function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length > 128) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !['__proto__', 'prototype', 'constructor'].includes(key) && 'value' in descriptor;
  });
}
function text(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 65536) invalid();
  return value;
}
function url(value) {
  text(value);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    invalid();
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) invalid();
  return value;
}
function list(value, convert) {
  if (!Array.isArray(value) || value.length > 128) invalid();
  return value.map(convert);
}
function bounded(value) {
  if (Buffer.byteLength(value) > 262144) invalid();
  return value;
}
function parseWebSearchAction(action) {
  if (!record(action)) invalid();
  const allowed = {
    search: ['type', 'query', 'queries', 'sources'],
    open_page: ['type', 'url'],
    find_in_page: ['type', 'url', 'pattern'],
  };
  if (
    typeof action.type !== 'string' ||
    !Object.hasOwn(allowed, action.type) ||
    Object.keys(action).some((key) => !allowed[action.type].includes(key))
  )
    invalid();
  const result = { type: action.type };
  if (action.type === 'search') {
    if (action.query !== undefined) result.query = text(action.query);
    if (action.queries !== undefined) result.queries = list(action.queries, text);
    if (action.sources !== undefined)
      result.sources = list(action.sources, (source) => {
        if (
          !record(source) ||
          source.type !== 'url' ||
          Object.keys(source).some((key) => !['type', 'url'].includes(key))
        )
          invalid();
        return { type: 'url', url: url(source.url) };
      });
  } else if (action.type === 'open_page') {
    if (action.url !== undefined) result.url = action.url === null ? null : url(action.url);
  } else if (action.type === 'find_in_page') {
    result.url = url(action.url);
    result.pattern = text(action.pattern);
  } else invalid();
  bounded(JSON.stringify(result));
  return result;
}
function webSearchHistoryText(item) {
  if (!record(item)) invalid();
  if (item.action != null) return JSON.stringify(parseWebSearchAction(item.action));
  if (item.arguments != null) {
    let args = item.arguments;
    if (typeof args === 'string') {
      text(args);
      try {
        args = args.trim() ? JSON.parse(args) : {};
      } catch {
        invalid();
      }
    }
    if (!record(args)) invalid();
    // Only documented legacy query aliases are interpreted; reject unsafe keys.
    if (Object.keys(args).some((key) => ['__proto__', 'prototype', 'constructor'].includes(key)))
      invalid();
    if (args.query != null) return text(args.query) || 'search';
    if (args.q != null) return text(args.q) || 'search';
    if (Object.keys(args).length) invalid();
  }
  return item.query == null ? 'search' : text(item.query) || 'search';
}
module.exports = { webSearchHistoryText, parseWebSearchAction };
