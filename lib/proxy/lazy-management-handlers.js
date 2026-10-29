'use strict';

const bootstrapNames = new Map([
  ['health', 'health'],
  ['handleLocalHealthRequest', 'health'],
  ['getConfig', 'getConfig'],
  ['handleLocalGetConfigRequest', 'getConfig'],
  ['proxyStop', 'proxyStop'],
  ['handleLocalProxyStopRequest', 'proxyStop'],
]);

function loadDefaultManagementModule() {
  return require('./handlers/management');
}

function createLazyManagementHandlers(deps, options = {}) {
  const loadModule = options.loadModule || loadDefaultManagementModule;
  if (typeof loadModule !== 'function') {
    throw new TypeError('createLazyManagementHandlers requires loadModule to be a function');
  }

  let handlers;
  let bootstrap;

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
      // Custom loaders retain their complete contract. Production bootstrap
      // routes share the existing implementations without loading writers or
      // unrelated features during bounded native health/token/stop requests.
      const bootstrapName = bootstrapNames.get(property);
      if (loadModule === loadDefaultManagementModule && bootstrapName) {
        if (!bootstrap) {
          const { createManagementBootstrapHandlers } = require('./handlers/management-bootstrap');
          bootstrap = createManagementBootstrapHandlers(deps);
        }
        return bootstrap[bootstrapName];
      }
      return resolveHandlers()[property];
    },
  });
}

module.exports = {
  createLazyManagementHandlers,
};
