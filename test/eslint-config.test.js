'use strict';

const assert = require('assert');
const eslintConfig = require('../eslint.config');

const ignores = eslintConfig.find((entry) => Array.isArray(entry.ignores))?.ignores || [];

assert.ok(
  ignores.includes('src-tauri/target*/**'),
  'generated Tauri target variants must stay outside the lint source boundary'
);

const productionConsoleGate = eslintConfig.find(
  (entry) =>
    Array.isArray(entry.files) &&
    entry.files.includes('lib/proxy/**/*.js') &&
    entry.rules?.['no-console'] === 'error'
);
assert.ok(productionConsoleGate, 'production proxy modules must reject direct console usage');
assert.ok(
  productionConsoleGate.ignores.includes('lib/proxy/logger.js') &&
    productionConsoleGate.ignores.includes('lib/proxy/runtime-support.js'),
  'only the safe logger fallback and runtime console tee may access console directly'
);

console.log('[eslint-config.test] ok');
