'use strict';

const assert = require('assert');
const eslintConfig = require('../eslint.config');

const ignores = eslintConfig.find((entry) => Array.isArray(entry.ignores))?.ignores || [];

assert.ok(
  ignores.includes('src-tauri/target*/**'),
  'generated Tauri target variants must stay outside the lint source boundary'
);

console.log('[eslint-config.test] ok');
