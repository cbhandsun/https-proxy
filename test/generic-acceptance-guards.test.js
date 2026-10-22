'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  installGenericAcceptanceGuards,
  summarizeGenericAcceptanceGuards,
} = require('../scripts/lib/generic-acceptance-guards');
const { genericAcceptanceRunName } = require('../scripts/lib/generic-evidence-acceptance-runtime');
const { discoverTestFiles } = require('../lib/test-discovery');

function setup(t, upstreamError = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-guard-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const authFile = path.join(directory, 'original/.codex/auth.json');
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  fs.writeFileSync(authFile, 'synthetic-secret-never-in-receipt');
  const isolatedHome = path.join(directory, 'isolated');
  const permitFile = path.join(directory, 'permit');
  const receiptFile = path.join(directory, 'receipt');
  fs.writeFileSync(permitFile, '0');
  fs.writeFileSync(receiptFile, '');
  let calls = 0;
  const request = () => {
    calls++;
    if (upstreamError) throw new Error('synthetic dispatch error');
    return { end() {} };
  };
  const capabilities = { fs: { ...fs }, http: { request }, https: { request } };
  const options = { authFile, isolatedHome, permitFile, receiptFile };
  installGenericAcceptanceGuards(options, capabilities);
  return {
    options,
    capabilities,
    calls: () => calls,
    permit: (index) => fs.writeFileSync(permitFile, String(index)),
    receipt: () => fs.readFileSync(receiptFile, 'utf8'),
  };
}
const model = { hostname: 'chatgpt.com', path: '/backend-api/codex/responses', method: 'POST' };

test('credential capability aliases only the isolated exact read without changing home or writes', (t) => {
  const f = setup(t);
  const homeBefore = os.homedir();
  const alias = path.join(f.options.isolatedHome, '.codex/auth.json');
  assert.equal(f.capabilities.fs.existsSync(alias), true);
  assert.equal(f.capabilities.fs.readFileSync(alias, 'utf8'), 'synthetic-secret-never-in-receipt');
  assert.equal(f.capabilities.fs.existsSync(alias + '.backup'), false);
  assert.equal(fs.existsSync(alias), false);
  assert.throws(() => f.capabilities.fs.writeFileSync(alias, 'not-written'));
  assert.equal(fs.readFileSync(f.options.authFile, 'utf8'), 'synthetic-secret-never-in-receipt');
  assert.equal(os.homedir(), homeBefore);
  assert.equal(f.receipt(), '{"kind":"auth_read"}\n');
});

test('one permit admits one actual dispatch, blocks retry, and reserves synchronous failures', (t) => {
  for (const throws of [false, true]) {
    const f = setup(t, throws);
    f.permit(1);
    if (throws) assert.throws(() => f.capabilities.https.request(model));
    else f.capabilities.https.request(model);
    assert.throws(() => f.capabilities.https.request(model), {
      code: 'generic_acceptance_capability_refused',
    });
    assert.equal(f.calls(), 1);
    assert.equal(summarizeGenericAcceptanceGuards(f.options.receiptFile, 1).verified, false);
    assert.ok(!f.receipt().includes('secret'));
  }
});

test('twelve exact permits include compact requests and reject a thirteenth without dispatch', (t) => {
  const f = setup(t);
  for (let i = 1; i <= 12; i++) {
    f.permit(i);
    f.capabilities.https.request(
      new URL('https://api.openai.com/v1/responses' + (i % 2 ? '' : '/compact')),
      { method: 'POST' }
    );
  }
  assert.deepEqual(summarizeGenericAcceptanceGuards(f.options.receiptFile, 12), {
    actualUpstreamAttempts: 12,
    authenticationReadOnlyReads: 0,
    blockedAttempts: 0,
    verified: true,
  });
  f.permit(13);
  assert.throws(() => f.capabilities.https.request(model));
  assert.equal(f.calls(), 12);
});

test('empty, nonsequential, invalid and extreme permits fail closed', (t) => {
  for (const permit of ['', 'NaN', '2', '0', '-1', '1.5', '1e100', '13']) {
    const f = setup(t);
    fs.writeFileSync(f.options.permitFile, permit);
    assert.throws(() => f.capabilities.https.request(model));
    assert.equal(f.calls(), 0);
  }
});

test('nonallowlisted origins, URL overrides, ports, methods and bypass get calls fail closed', (t) => {
  const f = setup(t);
  f.permit(1);
  for (const target of [
    { ...model, hostname: 'chatgpt.com.evil.test' },
    { ...model, hostname: 'api.openai.com', path: '/v1/files' },
    { ...model, port: 444 },
    { ...model, protocol: 'http:' },
    { ...model, method: 'GET' },
    { ...model, path: '/backend-api/codex/responses?token=private' },
    null,
  ])
    assert.throws(() => f.capabilities.https.request(target));
  assert.throws(() =>
    f.capabilities.https.request('https://chatgpt.com/backend-api/codex/responses', {
      ...model,
      hostname: 'evil.test',
    })
  );
  assert.throws(() => f.capabilities.https.get('https://chatgpt.com/backend-api/codex/responses'));
  assert.throws(() => f.capabilities.http.request(model));
  assert.equal(f.calls(), 0);
  f.capabilities.http.get('http://127.0.0.1:1234/health');
  assert.equal(f.calls(), 1);
  assert.ok(!f.receipt().includes('token'));
});

test('invalid capabilities and missing, malformed or oversized receipts do not qualify', (t) => {
  const f = setup(t);
  for (const options of [
    null,
    {},
    { ...f.options, authFile: 'relative' },
    { ...f.options, permitFile: 'x\0' },
    { ...f.options, authFile: path.join(f.options.isolatedHome, '.codex/auth.json') },
  ])
    assert.throws(() => installGenericAcceptanceGuards(options, f.capabilities));
  assert.equal(
    summarizeGenericAcceptanceGuards(f.options.receiptFile + '.missing', 0).verified,
    false
  );
  fs.writeFileSync(f.options.receiptFile, '{invalid');
  assert.equal(summarizeGenericAcceptanceGuards(f.options.receiptFile, 0).verified, false);
  fs.writeFileSync(f.options.receiptFile, 'x'.repeat(16385));
  assert.equal(summarizeGenericAcceptanceGuards(f.options.receiptFile, 0).verified, false);
  assert.ok(
    discoverTestFiles(path.resolve('.')).includes('test/generic-acceptance-guards.test.js')
  );
});

test('new authorization namespace cannot escape or overwrite the historical default', () => {
  assert.equal(genericAcceptanceRunName(), 'context-generic-model-acceptance-20261013-run1');
  assert.equal(
    genericAcceptanceRunName('context-generic-model-acceptance-20261015-run1'),
    'context-generic-model-acceptance-20261015-run1'
  );
  for (const name of [
    '',
    '../old',
    'context-generic-model-acceptance-..',
    'context-generic-model-acceptance-' + 'a'.repeat(81),
    1,
  ])
    assert.throws(() => genericAcceptanceRunName(name));
});
