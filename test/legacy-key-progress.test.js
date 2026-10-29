'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { protectWithCurrentUser } = require('../lib/proxy/context-recovery-key-dpapi');
const { KEY_PREFIX } = require('../lib/proxy/context-recovery-key-contract');
const {
  observeLegacyKeyArguments,
  legacyKeyPhase,
  legacyKeyErrorPhase,
} = require('./helpers/legacy-key-progress.cjs');
function argumentsFixture() {
  let args;
  protectWithCurrentUser(
    { operation: 'unprotect', value: KEY_PREFIX + Buffer.alloc(64, 7).toString('base64') },
    {
      platform: 'win32',
      environment: { SystemRoot: 'C:\\Windows' },
      nativeExecutable: null,
      execute(_file, input) {
        args = input;
        return JSON.stringify({ ok: true, value: Buffer.alloc(32, 11).toString('base64') });
      },
    }
  );
  return args;
}
const phases = [
  'script_started',
  'assembly_started',
  'assembly_finished',
  'input_started',
  'input_finished',
  'dpapi_started',
  'dpapi_finished',
  'roundtrip_started',
  'roundtrip_finished',
  'output_started',
  'script_completed',
];
const text = (names) => names.map((name) => 'hpm_legacy_key_phase=' + name + '\n').join('');
test('legacy diagnostics leave the exact fixed program intact after removing fixed stderr writes', () => {
  const args = argumentsFixture();
  const observed = observeLegacyKeyArguments(args);
  assert.deepEqual(observed.slice(0, 4), args.slice(0, 4));
  assert.equal(observed.length, 5);
  assert.equal(
    observed[4].replace(/\[Console\]::Error\.WriteLine\('hpm_legacy_key_phase=[a-z_]+'\);/g, ''),
    args[4]
  );
  assert.equal(args[4].includes('hpm_legacy_key_phase='), false);
  for (const phase of phases) assert.ok(observed[4].includes('hpm_legacy_key_phase=' + phase));
  for (const secret of [
    Buffer.alloc(64, 7).toString('base64'),
    Buffer.alloc(32, 11).toString('base64'),
  ])
    assert.equal(observed[4].includes(secret), false);
  for (const needle of ['timeout', 'env', 'input:'])
    assert.equal(observed.slice(0, 4).includes(needle), false);
});
test('legacy phase parsing is bounded, accepts complete prefixes of both branches, and exposes no other text', () => {
  for (let i = 0; i < phases.length; i++)
    assert.equal(legacyKeyPhase(text(phases.slice(0, i + 1))), phases[i]);
  const unprotect = phases.filter((p) => !p.startsWith('roundtrip_'));
  assert.equal(legacyKeyPhase(text(unprotect).replaceAll('\n', '\r\n')), 'script_completed');
  assert.equal(legacyKeyPhase(''), 'unobserved');
  assert.equal(
    legacyKeyPhase('PRIVATE_NATIVE_ERROR\n' + text(phases.slice(0, 2))),
    'assembly_started'
  );
  for (const invalid of [
    null,
    {},
    Buffer.alloc(0),
    'x'.repeat(2049),
    text(['dpapi_started']),
    text(['script_started', 'script_started']),
    text(['script_started', 'PRIVATE']),
    text(['script_started']).trimEnd(),
  ])
    assert.equal(legacyKeyPhase(invalid), 'invalid');
});
test('legacy observer refuses malformed or executable invocation and exception fields without calling hooks', () => {
  let touched = 0;
  const args = argumentsFixture();
  const accessor = args.slice();
  Object.defineProperty(accessor, '4', {
    get() {
      touched++;
      return args[4];
    },
    enumerable: true,
  });
  const extra = args.slice();
  extra[Symbol('PRIVATE')] = 1;
  const revoked = Proxy.revocable(args, {});
  revoked.revoke();
  for (const input of [
    null,
    {},
    [],
    args.slice(0, 4),
    ['-Command', ...args.slice(1)],
    accessor,
    extra,
    new Proxy(args, {
      ownKeys() {
        touched++;
        throw Error('PRIVATE');
      },
    }),
    revoked.proxy,
    [...args.slice(0, 4), args[4] + 'hpm_legacy_key_phase='],
  ])
    assert.throws(() => observeLegacyKeyArguments(input), /legacy_key_probe_invalid/);
  const getter = Object.defineProperty({}, 'stderr', {
    get() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  for (const error of [
    null,
    getter,
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          touched++;
          throw Error('PRIVATE');
        },
      }
    ),
  ])
    assert.equal(legacyKeyErrorPhase(error), 'unobserved');
  assert.equal(legacyKeyErrorPhase({ stderr: text(phases.slice(0, 3)) }), 'assembly_finished');
  assert.equal(touched, 0);
});
test(
  'the actual PowerShell parser accepts the observed fixed legacy program without executing key operations',
  { timeout: 10000 },
  () => {
    const code = observeLegacyKeyArguments(argumentsFixture())[4];
    const parser =
      "$source=[Console]::In.ReadToEnd();$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);if($errors.Count -ne 0){exit 1};[Console]::Out.Write('parse_ok')";
    const result = spawnSync(
      'pwsh',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', parser],
      { input: code, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 }
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'parse_ok');
    assert.equal(result.stderr, '');
  }
);

test(
  'real PowerShell failure retains its fixed catch reply and only the reached diagnostic prefix',
  { timeout: 10000 },
  () => {
    const args = observeLegacyKeyArguments(argumentsFixture());
    const line =
      "[void][Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a');";
    assert.equal(args[4].split(line).length, 2);
    args[4] = args[4].replace(line, "throw 'PRIVATE_SYNTHETIC_FAILURE';");
    const result = spawnSync('pwsh', args, {
      input: '{}',
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 4096,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '{"ok":false}');
    assert.equal(legacyKeyErrorPhase({ stderr: result.stderr }), 'assembly_started');
    assert.equal(result.stderr.includes('PRIVATE'), false);
  }
);
