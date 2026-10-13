'use strict';

const path = require('node:path');

function createIsolatedTestEnv(baseEnv, workspaceDir) {
  if (!baseEnv || typeof baseEnv !== 'object' || Array.isArray(baseEnv)) {
    throw new TypeError('baseEnv must be an object');
  }
  if (typeof workspaceDir !== 'string' || workspaceDir.trim() === '') {
    throw new TypeError('workspaceDir must be a non-empty string');
  }
  if (workspaceDir.includes('\0')) {
    throw new TypeError('workspaceDir must not contain null bytes');
  }
  const workspaceRoot = path.resolve(workspaceDir);
  const env = { ...baseEnv };
  delete env.PROXY_DATA_DIR;
  delete env.PROXY_CONFIG_DIR;
  delete env.PROXY_RUNTIME_DIR;
  delete env.PROXY_CERT_DIR;
  delete env.NODE_COMPILE_CACHE;
  env.PROXY_CONFIG_DIR = path.join(workspaceRoot, 'config');
  env.PROXY_RUNTIME_DIR = path.join(workspaceRoot, 'runtime');
  env.NODE_COMPILE_CACHE = path.join(env.PROXY_RUNTIME_DIR, '.node-compile-cache');
  env.NODE_ENV = 'test';
  return env;
}

module.exports = { createIsolatedTestEnv };
