'use strict';

function loadDefaultManagementModule() {
  return require('./handlers/management');
}

function createLazyManagementHandlers(deps, options = {}) {
  const loadModule = options.loadModule || loadDefaultManagementModule;
  if (typeof loadModule !== 'function') {
    throw new TypeError('createLazyManagementHandlers requires loadModule to be a function');
  }

  let handlers;

  function resolveHandlers() {
    if (handlers) return handlers;

    const loadedModule = loadModule();
    if (!loadedModule || typeof loadedModule.createManagementHandlers !== 'function') {
      throw new TypeError('management module must export createManagementHandlers');
    }

    const createdHandlers = loadedModule.createManagementHandlers(deps);
    if (!createdHandlers || typeof createdHandlers !== 'object') {
      throw new TypeError('createManagementHandlers must return an object');
    }

    handlers = createdHandlers;
    return handlers;
  }

  return new Proxy(Object.create(null), {
    get(target, property) {
      if (property === 'isInitialized') return () => Boolean(handlers);
      if (property === 'initialize') return resolveHandlers;
      return resolveHandlers()[property];
    },
  });
}

module.exports = {
  createLazyManagementHandlers,
};
