'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { KEY_PREFIX } = require('../lib/proxy/context-recovery-key-contract');
const { protectWithCurrentUser } = require('../lib/proxy/context-recovery-key-dpapi');

const key = Buffer.alloc(32, 1).toString('base64');
const blob = Buffer.alloc(128, 2).toString('base64');
const safeFailure = (error) =>
  error.code === 'context_recovery_key_unavailable' &&
  error.message === 'context_recovery_key_unavailable' &&
  error.cause === undefined;

for (const backend of ['native', 'legacy']) {
  for (const operation of ['protect', 'unprotect']) {
    test(`key wire rejects ambiguous replies without retry: ${backend}/${operation}`, (t) => {
      const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hpm-key-wire-'));
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const executable = path.join(directory, 'helper.exe');
      fs.writeFileSync(executable, 'synthetic, never executed');
      const value = operation === 'protect' ? blob : key;
      const canonical = JSON.stringify({ ok: true, value });
      let attempts = 0;
      let reply = canonical;
      const options = {
        platform: 'win32',
        environment: { SystemRoot: 'C:\\Windows' },
        nativeExecutable: backend === 'native' ? executable : null,
        execute(file, args, invocation) {
          attempts++;
          assert.equal(invocation.timeout, 10000);
          assert.equal(invocation.maxBuffer, 20000);
          assert.deepEqual(invocation.stdio, ['pipe', 'pipe', 'pipe']);
          assert.deepEqual(Object.keys(invocation.env).sort(), ['SystemRoot', 'WINDIR']);
          if (backend === 'native') {
            assert.equal(file, executable);
            assert.deepEqual(args, ['--hpm-context-key-v1']);
          } else assert.equal(path.win32.basename(file), 'powershell.exe');
          return reply;
        },
      };
      const request = { operation, value: operation === 'protect' ? key : KEY_PREFIX + blob };
      assert.equal(
        protectWithCurrentUser(request, options),
        operation === 'protect' ? KEY_PREFIX + blob : key
      );
      assert.equal(attempts, 1);
      if (operation === 'protect') {
        const maximum = Buffer.alloc(12288, 2).toString('base64');
        reply = JSON.stringify({ ok: true, value: maximum });
        assert.equal(protectWithCurrentUser(request, options), KEY_PREFIX + maximum);
      }
      const invalid = [
        canonical.replace('"ok":true', '"ok":false,"ok":true'),
        canonical.replace('"ok":true', '"ok":true,"ok":true'),
        canonical.replace('"value":', '"value":"private-placeholder","value":'),
        canonical.replace('"ok":true', '"\\u006fk":true'),
        ' ' + canonical,
        canonical + '\n',
        JSON.stringify({ ok: true, value, extra: 'private-placeholder' }),
        JSON.stringify({ ok: true, value: '' }),
        JSON.stringify({ ok: false, value }),
        '',
        'null',
        '[]',
        'private-placeholder',
        'x'.repeat(17001),
        Buffer.from(canonical),
        undefined,
      ];
      for (const input of invalid) {
        reply = input;
        const before = attempts;
        assert.throws(() => protectWithCurrentUser(request, options), safeFailure);
        assert.equal(attempts, before + 1);
      }
      options.execute = () => {
        attempts++;
        throw Object.assign(new Error('private-placeholder'), { code: 'ETIMEDOUT' });
      };
      const before = attempts;
      assert.throws(() => protectWithCurrentUser(request, options), safeFailure);
      assert.equal(attempts, before + 1);
    });
  }
}
