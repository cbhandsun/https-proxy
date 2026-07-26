'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const lineBudgets = {
  'lib/proxy/handlers/route-handlers.js': 1620,
  'lib/proxy/protocol-openai.js': 1527,
  'tauri-ui/src/app/domains/audit.js': 1559,
  'tauri-ui/src/app/domains/bridge.js': 1275,
  'tauri-ui/src/app/domains/tool-status.js': 1227,
};

for (const [relativePath, budget] of Object.entries(lineBudgets)) {
  const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
  const lineCount = source.split(/\r?\n/).length;
  assert.ok(lineCount <= budget, `${relativePath} has ${lineCount} lines; budget is ${budget}`);
}

console.log('[module-size-budgets.test] ok');
