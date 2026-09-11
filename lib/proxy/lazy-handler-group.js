'use strict';

const HANDLER_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function createLazyHandlerGroup(handlerNames, createHandlers) {
  if (!Array.isArray(handlerNames) || handlerNames.length === 0) {
    throw new TypeError('createLazyHandlerGroup requires handler names');
  }
  if (typeof createHandlers !== 'function') {
    throw new TypeError('createLazyHandlerGroup requires a factory');
  }
  const uniqueNames = new Set();
  for (const name of handlerNames) {
    if (typeof name !== 'string' || !HANDLER_NAME_PATTERN.test(name) || uniqueNames.has(name)) {
      throw new TypeError('Invalid or duplicate lazy handler name: ' + String(name));
    }
    uniqueNames.add(name);
  }

  let handlers = null;
  function resolveHandlers() {
    if (handlers) return handlers;
    const created = createHandlers();
    if (!created || typeof created !== 'object') {
      throw new TypeError('lazy handler factory must return an object');
    }
    for (const name of uniqueNames) {
      if (typeof created[name] !== 'function') {
        throw new TypeError('lazy handler factory is missing function: ' + name);
      }
    }
    handlers = created;
    return handlers;
  }

  const group = Object.create(null);
  for (const name of uniqueNames) {
    group[name] = function (...args) {
      return resolveHandlers()[name](...args);
    };
  }
  Object.defineProperty(group, 'isInitialized', {
    value: () => handlers !== null,
    enumerable: false,
  });
  return Object.freeze(group);
}

module.exports = { createLazyHandlerGroup };
