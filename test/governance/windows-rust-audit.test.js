'use strict';

const assert = require('node:assert/strict');
const {
  packageKeysFromCargoTree,
  blockingWarnings,
  relevantWarnings,
  warningEntries,
} = require('../../scripts/check-windows-rust-audit');

const packages = packageKeysFromCargoTree('app v0.1.0\n├── anyhow v1.0.103\n└── tauri v2.11.2\n');
assert.equal(packages.has('anyhow@1.0.103'), true);
assert.equal(packages.has('tauri@2.11.2'), true);

const report = {
  warnings: {
    unsound: [
      { package: { name: 'anyhow', version: '1.0.102' }, advisory: { id: 'RUSTSEC-2026-0190' } },
      { package: { name: 'glib', version: '0.18.5' }, advisory: { id: 'RUSTSEC-2024-0429' } },
    ],
  },
};
assert.deepEqual(warningEntries(report), [
  { kind: 'unsound', id: 'RUSTSEC-2026-0190', packageKey: 'anyhow@1.0.102' },
  { kind: 'unsound', id: 'RUSTSEC-2024-0429', packageKey: 'glib@0.18.5' },
]);
assert.deepEqual(relevantWarnings(report, new Set(['anyhow@1.0.102'])), [
  { kind: 'unsound', id: 'RUSTSEC-2026-0190', packageKey: 'anyhow@1.0.102' },
]);
assert.deepEqual(blockingWarnings(report, new Set(['anyhow@1.0.102'])), [
  { kind: 'unsound', id: 'RUSTSEC-2026-0190', packageKey: 'anyhow@1.0.102' },
]);
assert.deepEqual(blockingWarnings(report, new Set(['glib@0.18.5'])), [
  { kind: 'unsound', id: 'RUSTSEC-2024-0429', packageKey: 'glib@0.18.5' },
]);

console.log('[windows-rust-audit.test] ok');
