'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const {
  parsePolicyMigrationRequest,
  preparePolicyMigration,
} = require('../lib/proxy/context-policy-migration');
const { createManagementConfigHandlers } = require('../lib/proxy/handlers/management-config');
const {
  createManagementContextPolicyHandlers,
} = require('../lib/proxy/handlers/management-context-policy');
const { dispatchLocalManagementRoute } = require('../lib/proxy/management-router');

const revision = 'a'.repeat(64);
const request = (overrides = {}) => ({ confirm: true, revision, targetVersion: 2, ...overrides });
const config = (settings) => ({
  activeProfile: 'main',
  profiles: [{ id: 'main', protocol: 'openai', targetUrl: 'https://api.example.test/v1' }],
  ...(settings === undefined ? {} : { appSettings: settings }),
});

test('migration preserves explicit preferences and all unrelated raw data without modifying input', () => {
  for (const version of [undefined, 1, 2]) {
    for (const recovery of [false, true]) {
      for (const persistent of [false, true]) {
        const input = config({
          ...(version === undefined ? {} : { contextPolicyVersion: version }),
          contextRecoveryEnabled: recovery,
          contextRecoveryPersistenceEnabled: persistent,
          unrelated: { enabled: true },
        });
        input.profiles[0].apiKey = 'hpm-aes-v2:PRIVATE';
        input.protocolOptions = { contextWindowPolicy: 'overflow-drop-oldest' };
        input.oldRecords = [{ expiresAt: 123, revoked: true }];
        const bytes = JSON.stringify(input);
        const { config: next, preview } = preparePolicyMigration(input);
        assert.equal(JSON.stringify(input), bytes);
        const expected = JSON.parse(bytes);
        expected.appSettings.contextPolicyVersion = 2;
        assert.equal(JSON.stringify(next), JSON.stringify(expected));
        assert.equal(preview.fromVersion, version ?? 1);
        assert.equal(preview.migrationRequired, version !== 2);
        assert.equal(preview.requestedRecovery, recovery);
        assert.equal(preview.persistencePreference, persistent);
        assert.equal(preview.requestedPolicy, recovery ? 'enhanced' : 'native-first');
        assert.equal(Object.isFrozen(preview), true);
        assert.equal(Object.isFrozen(preview.impacts), true);
        assert.doesNotMatch(JSON.stringify(preview), /PRIVATE|expiresAt|apiKey/);
      }
    }
  }
  for (const input of [{}, config(), config(null)]) {
    const result = preparePolicyMigration(input);
    assert.equal(result.config.appSettings.contextPolicyVersion, 2);
    assert.equal(result.preview.requestedPolicy, 'native-first');
    assert.deepEqual(result.preview.impacts, [
      'automatic_trimming_disabled',
      'evidence_dependent_history_requires_recovery',
    ]);
  }
});

test('migration boundaries reject invalid, unknown, extreme and executable input without running hooks', () => {
  let hooks = 0;
  const getter = Object.defineProperty({}, 'appSettings', {
    enumerable: true,
    get() {
      hooks++;
      throw new Error('PRIVATE');
    },
  });
  const cycle = {};
  cycle.self = cycle;
  for (const value of [
    null,
    [],
    true,
    'PRIVATE',
    undefined,
    new Date(),
    cycle,
    getter,
    {
      toJSON() {
        hooks++;
        return {};
      },
    },
    config([]),
    config({ contextPolicyVersion: '2' }),
    config({ contextPolicyVersion: 3 }),
    config({ contextRecoveryEnabled: null }),
    config({ contextRecoveryEnabled: 1 }),
    config({ contextRecoveryPersistenceEnabled: 'true' }),
    { private: 'x'.repeat(4 * 1024 * 1024) },
    { [Symbol('PRIVATE')]: true },
  ]) {
    assert.throws(
      () => preparePolicyMigration(value),
      /^TypeError: invalid_context_policy_migration$/
    );
  }
  assert.equal(hooks, 0);
  const malicious = JSON.parse(
    '{"__proto__":{"polluted":true},"appSettings":{"__proto__":{"polluted":true}}}'
  );
  const safe = preparePolicyMigration(malicious).config;
  assert.equal(Object.getPrototypeOf(safe), null);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.hasOwn(safe.appSettings, '__proto__'), true);
});

test('apply request accepts only explicit current-version confirmation and a bounded exact revision', () => {
  assert.deepEqual(parsePolicyMigrationRequest(request()), { revision });
  for (const value of [
    {},
    null,
    [],
    '',
    true,
    request({ confirm: false }),
    request({ confirm: 'true' }),
    request({ targetVersion: 1 }),
    request({ targetVersion: 3 }),
    request({ revision: '' }),
    request({ revision: 'missing' }),
    request({ revision: revision.toUpperCase() }),
    request({ revision: 'a'.repeat(65) }),
    request({ path: 'PRIVATE' }),
    request({
      revision: {
        toString() {
          throw new Error('PRIVATE');
        },
      },
    }),
    Object.defineProperty(request(), 'confirm', {
      get() {
        throw new Error('PRIVATE');
      },
    }),
  ])
    assert.throws(() => parsePolicyMigrationRequest(value), /invalid_context_policy_migration/);
});

function invoke(
  handlers,
  kind,
  body,
  {
    method = kind === 'Preview' ? 'GET' : 'POST',
    aborted = false,
    raw = false,
    prefix = '/v1/local',
  } = {}
) {
  const req = Readable.from([Buffer.from(raw ? body : JSON.stringify(body ?? {}))]);
  req.method = method;
  req.aborted = aborted;
  const replies = [];
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const res = { replies, finish, destroyed: false, writableEnded: false };
  const pathname = `${prefix}/context-policy/${kind.toLowerCase()}`;
  if (!dispatchLocalManagementRoute({ method, pathname, req, res, handlers })) {
    handlers[`handleLocalContextPolicy${kind}Request`](req, res);
  }
  return { req, res, done };
}

function fixture(t, initial = config()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-policy-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(initial));
  let reloads = 0;
  const handlers = createManagementConfigHandlers({
    configFile,
    loadConfigFn: () => JSON.parse(fs.readFileSync(configFile, 'utf8')),
    encryptConfigForStorage: (value) => value,
    reloadProxyConfig() {
      reloads++;
    },
    sendJson(res, status, value) {
      const reply = { status, value };
      res.replies.push(reply);
      res.finish(reply);
    },
  });
  return {
    handlers,
    configFile,
    reloads: () => reloads,
    bytes: () => fs.readFileSync(configFile, 'utf8'),
  };
}

test('management router aliases preview without writes and apply only the version marker, reporting pending runtime', async (t) => {
  const original = config({
    contextRecoveryEnabled: false,
    contextRecoveryPersistenceEnabled: true,
  });
  original.profiles[0].apiKey = 'hpm-aes-v2:PRIVATE';
  original.protocolOptions = { contextWindowPolicy: 'overflow-drop-oldest' };
  const f = fixture(t, original);
  const bytes = f.bytes();
  for (const prefix of ['/v1/local', '/local']) {
    const preview = await invoke(f.handlers, 'Preview', {}, { prefix }).done;
    assert.equal(preview.status, 200);
    assert.equal(preview.value.migrationRequired, true);
    assert.equal(f.bytes(), bytes);
    assert.equal(f.reloads(), 0);
    assert.doesNotMatch(JSON.stringify(preview), /PRIVATE|apiKey|targetUrl/);
  }
  const preview = (await invoke(f.handlers, 'Preview').done).value;
  const result = await invoke(f.handlers, 'Apply', request({ revision: preview.revision })).done;
  assert.equal(result.status, 200);
  assert.equal(result.value.saved, true);
  assert.equal(result.value.changed, true);
  assert.equal(result.value.runtimeApplication, 'pending');
  assert.notEqual(result.value.revision, preview.revision);
  assert.equal(f.reloads(), 1);
  original.appSettings.contextPolicyVersion = 2;
  assert.deepEqual(JSON.parse(f.bytes()), original);
  const savedBytes = f.bytes();
  const repeat = await invoke(f.handlers, 'Apply', request({ revision: result.value.revision }), {
    prefix: '/local',
  }).done;
  assert.equal(repeat.status, 200);
  assert.equal(repeat.value.changed, false);
  assert.equal(f.bytes(), savedBytes);
  assert.equal(f.reloads(), 2);
});

test('invalid requests, mismatched revisions and competing applies never overwrite config', async (t) => {
  const f = fixture(t);
  const before = f.bytes();
  for (const body of [
    '',
    '{',
    'null',
    '[]',
    '{}',
    JSON.stringify(request({ secret: 'PRIVATE' })),
    ' '.repeat(257),
  ]) {
    const result = await invoke(f.handlers, 'Apply', body, { raw: true }).done;
    assert.deepEqual(result, {
      status: 400,
      value: { ok: false, code: 'context_policy_migration_invalid' },
    });
    assert.equal(f.bytes(), before);
  }
  assert.equal((await invoke(f.handlers, 'Apply', request()).done).status, 409);
  assert.equal(f.bytes(), before);
  const preview = (await invoke(f.handlers, 'Preview').done).value;
  const payload = request({ revision: preview.revision });
  const results = await Promise.all([
    invoke(f.handlers, 'Apply', payload).done,
    invoke(f.handlers, 'Apply', payload).done,
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(f.reloads(), 1);
});

test('migration shares the full-save queue and cancels a disconnected queued mutation', async (t) => {
  const f = fixture(t);
  const preview = (await invoke(f.handlers, 'Preview').done).value;
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const blocker = f.handlers.enqueueConfigMutation(() => hold);
  const before = f.bytes();
  const abandoned = invoke(f.handlers, 'Apply', request({ revision: preview.revision }));
  await new Promise((resolve) => setImmediate(resolve));
  abandoned.res.destroyed = true;
  release();
  await blocker;
  await f.handlers.enqueueConfigMutation(() => {});
  assert.equal(f.bytes(), before);
  assert.equal(f.reloads(), 0);
  assert.equal(abandoned.res.replies.length, 0);
  const changed = config({ contextRecoveryEnabled: true });
  const res = { replies: [], finish() {} };
  f.handlers.handleLocalSaveConfigRequest(
    Readable.from([Buffer.from(JSON.stringify({ ...changed, _revision: preview.revision }))]),
    res
  );
  await new Promise((resolve) => setImmediate(resolve));
  await f.handlers.enqueueConfigMutation(() => {});
  assert.equal(res.replies[0].status, 200);
  assert.equal(
    (await invoke(f.handlers, 'Apply', request({ revision: preview.revision })).done).status,
    409
  );
  assert.deepEqual(JSON.parse(f.bytes()), changed);
});

test('missing, corrupt and unknown config fail safely with fixed public errors and no reload', async (t) => {
  const f = fixture(t);
  for (const source of [
    '{PRIVATE',
    'null',
    '[]',
    JSON.stringify(config({ contextPolicyVersion: 3 })),
    JSON.stringify(config({ contextRecoveryEnabled: null })),
  ]) {
    fs.writeFileSync(f.configFile, source);
    const result = await invoke(f.handlers, 'Preview').done;
    assert.ok([409, 503].includes(result.status));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|contextPolicyVersion|\.json/);
    assert.equal(f.bytes(), source);
  }
  fs.unlinkSync(f.configFile);
  assert.deepEqual(await invoke(f.handlers, 'Preview').done, {
    status: 409,
    value: { ok: false, code: 'context_policy_config_required' },
  });
  assert.equal(f.reloads(), 0);
});

test('write/reload/read failures do not disclose errors or claim runtime application', async () => {
  for (const failure of ['read', 'validate', 'write', 'reload', 'read-after']) {
    let reads = 0;
    let writes = 0;
    const fail = () => {
      throw new Error('PRIVATE_PATH_TOKEN');
    };
    const handlers = createManagementContextPolicyHandlers({
      readCurrent() {
        reads++;
        if (failure === 'read' || (failure === 'read-after' && reads > 1)) fail();
        return { revision, config: config() };
      },
      validateConfig() {
        if (failure === 'validate') fail();
        return { valid: true };
      },
      writeConfig() {
        if (failure === 'write') fail();
        writes++;
        return revision;
      },
      reloadProxyConfig() {
        if (failure === 'reload') fail();
      },
      enqueueConfigMutation: (run) => Promise.resolve().then(run),
      sendJson(res, status, value) {
        res.finish({ status, value });
      },
    });
    const result = await invoke(handlers, 'Apply', request()).done;
    assert.equal(result.status, failure === 'validate' ? 409 : 503);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|runtimeApplication/);
    assert.equal(writes, ['reload', 'read-after'].includes(failure) ? 1 : 0);
    if (writes) assert.equal(result.value.code, 'context_policy_reload_unconfirmed');
  }
});

test('policy migration awaits async durable writes and contains asynchronous write failures', async () => {
  for (const fails of [false, true]) {
    let settle;
    const pendingWrite = new Promise((resolve, reject) => {
      settle = () => (fails ? reject(Error('PRIVATE_PATH_TOKEN')) : resolve(revision));
    });
    let reloads = 0;
    let writes = 0;
    const handlers = createManagementContextPolicyHandlers({
      readCurrent: () => ({ revision, config: config() }),
      validateConfig: () => ({ valid: true }),
      writeConfig() {
        writes++;
        return pendingWrite;
      },
      reloadProxyConfig() {
        reloads++;
      },
      enqueueConfigMutation: (run) => Promise.resolve().then(run),
      sendJson(res, status, value) {
        res.finish({ status, value });
      },
    });
    const operation = invoke(handlers, 'Apply', request());
    let replied = false;
    operation.done.then(() => {
      replied = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes, 1);
    assert.equal(reloads, 0);
    assert.equal(replied, false);
    settle();
    const result = await operation.done;
    assert.equal(result.status, fails ? 503 : 200);
    assert.equal(reloads, fails ? 0 : 1);
    if (fails) assert.deepEqual(result.value, { ok: false, code: 'context_policy_unavailable' });
    else assert.equal(result.value.revision, revision);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
});

test('method, abort and response failures cannot trigger duplicate mutations', async () => {
  let writes = 0;
  const handlers = createManagementContextPolicyHandlers({
    readCurrent: () => ({ revision, config: config() }),
    validateConfig: () => ({ valid: true }),
    writeConfig() {
      writes++;
      return revision;
    },
    reloadProxyConfig() {},
    enqueueConfigMutation: (run) => Promise.resolve().then(run),
    sendJson(res, status, value) {
      res.finish({ status, value });
      throw new Error('PRIVATE');
    },
  });
  for (const kind of ['Preview', 'Apply'])
    assert.equal((await invoke(handlers, kind, {}, { method: 'DELETE' }).done).status, 405);
  invoke(handlers, 'Apply', request(), { aborted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 0);
  assert.equal((await invoke(handlers, 'Apply', request()).done).status, 200);
  assert.equal(writes, 1);
});

test('an external write after commit never authorizes a stale UI document with the external revision', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-policy-external-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config()));
  const external = config({ contextPolicyVersion: 2, contextRecoveryEnabled: true });
  external.activeProfile = 'external-change';
  const externalBytes = JSON.stringify(external);
  const handlers = createManagementConfigHandlers({
    configFile,
    encryptConfigForStorage: (value) => value,
    reloadProxyConfig() {
      fs.writeFileSync(configFile, externalBytes);
    },
    sendJson(res, status, value) {
      res.finish({ status, value });
    },
  });
  const preview = (await invoke(handlers, 'Preview').done).value;
  const result = await invoke(handlers, 'Apply', request({ revision: preview.revision })).done;
  assert.deepEqual(result, {
    status: 503,
    value: { ok: false, code: 'context_policy_reload_unconfirmed' },
  });
  assert.equal(fs.readFileSync(configFile, 'utf8'), externalBytes);
  assert.equal(Object.hasOwn(result.value, 'revision'), false);
});
