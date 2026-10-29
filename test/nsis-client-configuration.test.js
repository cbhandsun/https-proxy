'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  installedClientConfiguration,
  configureInstalledClient,
} = require('../scripts/lib/nsis-client-configuration');
const { validateConfig } = require('../lib/proxy/validator');
const identity = { pid: 23, entryPort: 12345, managementPort: 12346 };
const options = {
  client: 'codex',
  mode: 'default',
  entryToken: 'hpm-synthetic-' + 'a'.repeat(32),
  upstreamToken: 'hpm-upstream-' + 'b'.repeat(32),
};
function fixture(mutate = () => {}) {
  let config = { _revision: 'initial', appSettings: {} },
    posts = 0,
    now = 0;
  const owner = {
    identity,
    isAlive: async () => true,
    request: async (request) => {
      let result;
      if (request.method === 'POST') {
        posts++;
        config = { ...JSON.parse(JSON.stringify(request.body)), _revision: 'saved' };
        result = { status: 200, body: { ok: true, revision: 'saved' } };
      } else if (request.route.endsWith('/config')) result = { status: 200, body: config };
      else
        result = {
          status: 200,
          body: {
            pid: identity.pid,
            contextRecovery: {
              configValid: true,
              appliedEnabled: config.appSettings.contextRecoveryEnabled,
              storage: config.appSettings.contextRecoveryPersistenceEnabled
                ? 'persistent'
                : 'memory',
            },
            ports: { entries: config.entryServers },
          },
        };
      mutate(result, request, posts);
      return result;
    },
  };
  return {
    owner,
    clock: {
      now: () => now,
      wait: async (ms) => {
        now += ms;
      },
    },
    posts: () => posts,
  };
}
test('all four installed client configurations retain real authentication and official TLS boundaries', async () => {
  for (const client of ['codex', 'claude'])
    for (const mode of ['default', 'enhanced']) {
      const f = fixture();
      const selected = { ...options, client, mode };
      const result = await configureInstalledClient(f.owner, selected, f.clock);
      assert.equal(result.protocol, client === 'codex' ? 'openai-responses' : 'claude');
      assert.equal(f.posts(), 1);
      const cfg = installedClientConfiguration(
        { _revision: 'r', profiles: [{ apiKey: 'redacted' }] },
        identity,
        selected
      );
      assert.equal(validateConfig(cfg).valid, true);
      assert.equal(cfg.entryAuth.enabled, true);
      assert.equal(cfg.entryAuth.keys[0].key, options.entryToken);
      assert.equal(cfg.profiles[0].apiKey, options.upstreamToken);
      assert.equal(cfg.appSettings.verifyUpstreamTls, true);
      assert.equal(cfg.appSettings.contextRecoveryPersistenceEnabled, mode === 'enhanced');
      assert.deepEqual(cfg.entryAuth.keys[0].allowedProfileIds, [cfg.activeProfile]);
    }
});
test('configuration rejects invalid empty extreme and accessor input before saving', () => {
  for (const value of [
    null,
    {},
    [],
    { ...options, client: 'other' },
    { ...options, mode: 'other' },
    { ...options, entryToken: '' },
    { ...options, upstreamToken: 'x'.repeat(10000) },
  ])
    assert.throws(() => installedClientConfiguration({ _revision: 'r' }, identity, value));
  for (const revision of ['', null, 'x'.repeat(257)])
    assert.throws(() => installedClientConfiguration({ _revision: revision }, identity, options));
  for (const port of [0, 65536, NaN, 1.5])
    assert.throws(() =>
      installedClientConfiguration({ _revision: 'r' }, { ...identity, entryPort: port }, options)
    );
  let called = false;
  const before = {};
  Object.defineProperty(before, '_revision', {
    enumerable: true,
    get() {
      called = true;
      return 'r';
    },
  });
  assert.throws(() => installedClientConfiguration(before, identity, options));
  assert.equal(called, false);
});
test('configuration refuses save/read drift and preserves original readiness failure boundary', async () => {
  for (const mode of [
    'post',
    'revision',
    'persistence',
    'tls',
    'profile',
    'permission',
    'health',
    'exit',
    'clock',
  ]) {
    const f = fixture((r, q, posts) => {
      if (mode === 'post' && q.method === 'POST') r.status = 400;
      if (posts && q.method === 'GET' && q.route.endsWith('/config')) {
        if (mode === 'revision') r.body._revision = 'stale';
        if (mode === 'persistence') r.body.appSettings.contextRecoveryPersistenceEnabled = true;
        if (mode === 'tls') r.body.appSettings.verifyUpstreamTls = false;
        if (mode === 'profile') r.body.profiles[0].targetUrl = 'http://127.0.0.1';
        if (mode === 'permission') r.body.entryAuth.keys[0].allowedProfileIds = [];
      }
      if (mode === 'health' && q.route.endsWith('/health'))
        r.body.contextRecovery.storage = 'unavailable';
    });
    if (mode === 'exit') f.owner.isAlive = async () => false;
    if (mode === 'clock') f.clock.now = () => NaN;
    await assert.rejects(configureInstalledClient(f.owner, options, f.clock), {
      message: 'installed_client_configuration_failed',
    });
    assert.equal(f.posts(), 1);
  }
});
