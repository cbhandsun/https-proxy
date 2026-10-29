'use strict';

// The lifecycle is composed eagerly by the entrypoint. Loading the request
// implementation is deferred until use; authorization and dispatch still run
// through the same core handler before any request can reach an upstream.
function createLazyCoreRequestHandler(dependencies, options = {}) {
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies))
    throw new TypeError('Invalid core request dependencies');
  const loadModule = options.loadModule ?? (() => require('./core-request-handler'));
  if (typeof loadModule !== 'function') throw new TypeError('Invalid core request module loader');
  let handler;
  let initializing = false;
  function resolve() {
    if (handler) return handler;
    if (initializing) throw new Error('Core request initialization is recursive');
    initializing = true;
    try {
      const loaded = loadModule();
      if (!loaded || typeof loaded.createCoreRequestHandler !== 'function')
        throw new TypeError('Core request module must export createCoreRequestHandler');
      const created = loaded.createCoreRequestHandler(dependencies);
      if (typeof created !== 'function')
        throw new TypeError('Core request factory must return a function');
      handler = created;
      return handler;
    } finally {
      initializing = false;
    }
  }
  function handleRequest(...args) {
    return Reflect.apply(resolve(), this, args);
  }
  Object.defineProperty(handleRequest, 'contextRecoveryLifecycle', {
    get: () => dependencies.contextRecoveryLifecycle ?? resolve().contextRecoveryLifecycle,
  });
  return handleRequest;
}

module.exports = { createLazyCoreRequestHandler };
