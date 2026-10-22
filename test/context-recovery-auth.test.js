'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createAuthResolver } = require('../lib/proxy/auth-resolver');
const {
  bindRecoveryOfficialCredentials,
  recoveryOfficialCredentialsAllowed,
  createRecoveryCredentialFileGuard,
} = require('../lib/proxy/context-recovery-auth');
const {
  nativeRecoveryProviderAllowed,
  createRecoveryHttpAuthorization,
} = require('../lib/proxy/context-recovery-http-entry');
const {
  nativeRecoveryCompactionProviderAllowed,
} = require('../lib/proxy/context-recovery-compaction');

const profile = {
  id: 'official-fixture',
  protocol: 'openai',
  targetUrl: 'https://api.openai.com/v1',
  apiKey: 'fixture-official',
};
const prepared = () => ({
  profile: { ...profile, targetUrl: 'https://chatgpt.com/backend-api/codex' },
  authMode: 'official-login',
  authProvider: 'openai',
});

test('official recovery provenance cannot be manufactured by body metadata or copied arbitrary objects', () => {
  const p = prepared();
  assert.equal(recoveryOfficialCredentialsAllowed(p, profile), false);
  bindRecoveryOfficialCredentials(p, profile);
  assert.equal(recoveryOfficialCredentialsAllowed({ ...p }, { ...profile }), true);
  assert.equal(recoveryOfficialCredentialsAllowed(JSON.parse(JSON.stringify(p)), profile), false);
  for (const change of [
    { apiKey: 'changed' },
    { targetUrl: 'https://different.invalid' },
    { protocol: 'claude' },
  ]) {
    assert.equal(
      recoveryOfficialCredentialsAllowed({ ...p, profile: { ...p.profile, ...change } }, profile),
      false
    );
    assert.equal(recoveryOfficialCredentialsAllowed(p, { ...profile, ...change }), false);
  }
  assert.equal(recoveryOfficialCredentialsAllowed({ ...p, authMode: 'api-key' }, profile), false);
  assert.equal(recoveryOfficialCredentialsAllowed({ ...p, authProvider: 'other' }, profile), false);
  for (const value of [null, undefined, [], {}, { profile: null }])
    assert.equal(recoveryOfficialCredentialsAllowed(value, profile), false);
  let invoked = 0;
  const accessor = {
    ...prepared(),
    get profile() {
      invoked++;
      throw new Error('must not escape');
    },
  };
  assert.equal(bindRecoveryOfficialCredentials(accessor, profile), accessor);
  assert.equal(recoveryOfficialCredentialsAllowed(accessor, profile), false);
  assert.equal(invoked, 0);
  const throwing = bindRecoveryOfficialCredentials(prepared(), profile, () => {
    throw new Error('private');
  });
  assert.equal(recoveryOfficialCredentialsAllowed(throwing, profile), false);
});

test('official capability accepts only resolver-qualified Codex HTTPS paths and pinned live scope', () => {
  const p = bindRecoveryOfficialCredentials(prepared(), profile);
  const base = {
    kind: 'responses',
    target: { protocol: 'https:', hostname: 'chatgpt.com' },
    path: '/backend-api/codex/responses',
    prepared: p,
    requestOptions: { hostname: 'chatgpt.com', port: 443 },
  };
  assert.equal(nativeRecoveryProviderAllowed(base), true);
  assert.equal(
    nativeRecoveryCompactionProviderAllowed({ ...base, path: base.path + '/compact' }),
    true
  );
  for (const patch of [
    { prepared: prepared() },
    { kind: 'chat' },
    { path: '/backend-api/responses' },
    { target: { protocol: 'http:', hostname: 'chatgpt.com' } },
    { requestOptions: { hostname: 'other.invalid', port: 443 } },
    { requestOptions: { hostname: 'chatgpt.com', port: 8443 } },
  ])
    assert.equal(nativeRecoveryProviderAllowed({ ...base, ...patch }), false);
  let valid = true;
  bindRecoveryOfficialCredentials(p, profile, () => valid);
  const auth = { ok: true, enabled: true, key: { id: 'owner' } };
  const scope = { enabled: true, allowed: true, auth, profile: { ...profile }, environment: {} };
  const allowed = createRecoveryHttpAuthorization(() => scope, auth, p);
  assert.equal(allowed(), true);
  valid = false;
  assert.equal(allowed(), false);
  assert.equal(nativeRecoveryProviderAllowed(base), false);
});

test('bounded credential source guard rejects rotation, missing, directories and oversized files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-recovery-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'auth.json');
  const bytes = Buffer.from('{"tokens":{"access_token":"eyJ.synthetic.fixture"}}');
  fs.writeFileSync(file, bytes);
  const guard = createRecoveryCredentialFileGuard(file, bytes);
  assert.equal(guard(), true);
  fs.writeFileSync(file, Buffer.from('{"tokens":{"access_token":"eyJ.changed"}}'));
  assert.equal(guard(), false);
  fs.writeFileSync(file, Buffer.alloc(128 * 1024 + 1));
  assert.equal(guard(), false);
  fs.unlinkSync(file);
  assert.equal(guard(), false);
  for (const [name, input] of [
    [dir, bytes],
    ['', bytes],
    [file, null],
    [file, Buffer.alloc(128 * 1024 + 1)],
  ])
    assert.equal(createRecoveryCredentialFileGuard(name, input)(), false);
});

test('credential load failure never logs raw file errors or credential contents', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-recovery-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'auth.json');
  fs.writeFileSync(file, '{}');
  const script = `
    const fs = require('node:fs');
    const {createAuthResolver} = require(process.argv[1]);
    const file = process.argv[2];
    const originalRead = fs.readFileSync;
    fs.readFileSync = (name, ...args) => {
      if (name === file) throw new Error('opaque-fixture-error-must-stay-private');
      return originalRead(name, ...args);
    };
    const profile = {id:'fixture',protocol:'openai',apiKey:'PROXY_MANAGED'};
    const resolver = createAuthResolver({
      officialLoginProvider:()=> 'openai', inferOfficialProfileAuthMode:()=> 'official-login',
      configuredAuthMode:()=>'', isRedactedSecret:(v)=> !v || v==='PROXY_MANAGED',
      PROFILES:[profile],codexAuthPath:file
    });
    resolver.resolveOfficialCredentials({profile:{...profile}},{}).catch(()=>{process.exitCode=1});
  `;
  const result = spawnSync(
    process.execPath,
    ['-e', script, path.resolve(__dirname, '../lib/proxy/auth-resolver.js'), file],
    {
      encoding: 'utf8',
      env: { ...process.env, PROXY_LOG_LEVEL: 'info', NODE_ENV: 'production' },
      timeout: 10000,
    }
  );
  assert.equal(result.status, 0, 'isolated credential logger fixture must terminate');
  const output = result.stdout + result.stderr;
  assert.match(output, /Codex OAuth credentials are unavailable/);
  assert.doesNotMatch(output, /opaque-fixture-error-must-stay-private/);
});

test('real auth resolver binds configured and local-login sources without admitting inbound keys', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-recovery-resolver-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'auth.json');
  const configured = { ...profile };
  const resolver = createAuthResolver({
    officialLoginProvider: () => 'openai',
    inferOfficialProfileAuthMode: () => 'official-login',
    configuredAuthMode: () => '',
    isRedactedSecret: (value) => !value || value === 'PROXY_MANAGED',
    decryptKey: (value) => value,
    shouldUseChatGPTBackendForOfficialLogin: () => true,
    PROFILES: () => [configured],
    codexAuthPath: file,
  });
  const wrong = await resolver.resolveOfficialCredentials(
    { profile: { ...configured, apiKey: 'inbound-wrong' } },
    {}
  );
  assert.equal(wrong.profile.apiKey, null);
  assert.equal(recoveryOfficialCredentialsAllowed(wrong, configured), false);
  const first = await resolver.resolveOfficialCredentials({ profile: { ...configured } }, {});
  assert.equal(first.profile.apiKey, profile.apiKey);
  assert.equal(recoveryOfficialCredentialsAllowed(first, configured), true);
  configured.apiKey = 'PROXY_MANAGED';
  fs.writeFileSync(file, JSON.stringify({ tokens: { access_token: 'eyJ.synthetic.fixture' } }));
  const second = await resolver.resolveOfficialCredentials({ profile: { ...configured } }, {});
  assert.equal(second.profile.targetUrl, 'https://chatgpt.com/backend-api/codex');
  assert.equal(recoveryOfficialCredentialsAllowed(second, configured), true);
  fs.writeFileSync(file, '{}');
  assert.equal(recoveryOfficialCredentialsAllowed(second, configured), false);
  assert.doesNotMatch(JSON.stringify(first), /recoveryOfficialCredentialBinding/);
});
