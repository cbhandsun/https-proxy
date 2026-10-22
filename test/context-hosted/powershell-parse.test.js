'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
test(
  'all promoted PowerShell sources parse without importing or executing their functions',
  {
    skip: process.platform !== 'win32',
    timeout: 30000,
  },
  () => {
    const root = path.resolve(__dirname, '../..');
    const result = spawnSync(
      'C:/Program Files/PowerShell/7/pwsh.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        path.join(root, 'test/fixtures/context-hosted/parse-powershell.ps1'),
        '-RepositoryRoot',
        root,
      ],
      { shell: false, windowsHide: true, timeout: 25000, maxBuffer: 8192, encoding: 'utf8' }
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { powershellParsed: true });
  }
);
