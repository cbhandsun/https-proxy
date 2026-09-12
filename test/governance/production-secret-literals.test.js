'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const proxyRoot = path.resolve(__dirname, '..', '..', 'lib', 'proxy');
const sourceFiles = [];

function collectSourceFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectSourceFiles(fullPath);
    else if (/\.(?:c?js|mjs)$/.test(entry.name)) sourceFiles.push(fullPath);
  }
}

collectSourceFiles(proxyRoot);
for (const file of sourceFiles) {
  const source = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(
    source,
    /GOCSPX-[A-Za-z0-9_-]{16,}/,
    `${path.relative(proxyRoot, file)} contains a committed Google OAuth client secret`
  );
}

console.log('[production-secret-literals.test] ok');
