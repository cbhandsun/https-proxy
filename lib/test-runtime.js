'use strict';

function createIsolatedTestEnv(baseEnv, runtimeDir) {
  if (!runtimeDir || typeof runtimeDir !== 'string') {
    throw new TypeError('runtimeDir must be a non-empty string');
  }
  const env = { ...(baseEnv || {}) };
  delete env.PROXY_CONFIG_DIR;
  delete env.PROXY_RUNTIME_DIR;
  env.PROXY_DATA_DIR = runtimeDir;
  env.NODE_ENV = 'test';
  return env;
}

module.exports = { createIsolatedTestEnv };
