'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sentinel = 'PRIVATE_ENTRY_SENTINEL';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

for (const name of ['n08', 'n09']) {
  test(
    `${name} entry reports fixed pre-business phases without exposing input or executing pinned code`,
    { skip: process.platform !== 'win32', timeout: 30000 },
    () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-entry-phase-'));
      const entry = path.resolve(__dirname, `../../scripts/context-hosted/${name}/owned-entry.js`);
      const planFile = path.join(directory, `${name}-hosted-plan.json`);
      const pinnedFile = path.join(directory, 'pinned.js');
      const env = {
        ...process.env,
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_OS: 'Windows',
        NODE_OPTIONS: '',
        NODE_PATH: '',
      };
      function check(code, input, document, environment = env) {
        const bytes = document === undefined ? undefined : Buffer.from(JSON.stringify(document));
        if (bytes) fs.writeFileSync(planFile, bytes);
        const result = spawnSync(
          process.execPath,
          [entry, directory, bytes ? sha(bytes) : 'a'.repeat(64)],
          {
            encoding: 'utf8',
            input,
            env: environment,
            timeout: 10000,
            maxBuffer: 8192,
            windowsHide: true,
          }
        );
        assert.ifError(result.error);
        assert.equal(result.status, code);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `${name}_owned_entry_rejected\n`);
        assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_ENTRY_SENTINEL/);
      }
      try {
        check(64, sentinel, undefined, { ...env, GITHUB_ACTIONS: '' });
        check(65, sentinel);
        check(66, '1');
        check(67, '1', {});
        check(68, '1', { loadedPins: { [pinnedFile]: 'a'.repeat(64) } });
        fs.writeFileSync(pinnedFile, `throw Error('${sentinel}');`);
        check(69, '1', { loadedPins: { [pinnedFile]: sha(fs.readFileSync(pinnedFile)) } });
      } finally {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('hpm-entry-phase-'));
        fs.rmSync(directory, { recursive: true });
      }
    }
  );
}
