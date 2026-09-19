'use strict';

const assert = require('node:assert/strict');

(async () => {
  const configuration = await import('../../tauri-ui/src/app/models/configuration.js');
  const {
    buildDefaultEntryServers,
    createDefaultEntryAuthKey,
    createEntryAuthSecret,
    entryProtocolName,
    inferRouteClientProtocols,
    normalizeAppSettings,
    normalizeEntryAuth,
    normalizeEntryAuthKey,
    normalizeEntryProtocol,
    normalizeEntryServers,
    normalizeLocalServer,
    normalizeRouteClientProtocol,
    normalizeRouteClientProtocols,
    preferredEntryProtocolForProfile,
    protocolName,
    routeProtocolHintState,
    routeClientProtocols,
    splitEntryAuthList,
  } = configuration;

  assert.equal(normalizeRouteClientProtocol(' CHAT '), 'openai-chat');
  assert.equal(normalizeRouteClientProtocol('openai-response'), 'openai-responses');
  assert.equal(normalizeRouteClientProtocol('unknown'), '');
  assert.equal(normalizeRouteClientProtocol({ toString: () => 'claude' }), '');
  assert.deepEqual(normalizeRouteClientProtocols('claude, chat, claude, invalid'), [
    'claude',
    'openai-chat',
  ]);
  assert.deepEqual(normalizeRouteClientProtocols(null), []);
  assert.deepEqual(inferRouteClientProtocols(' claude-sonnet-4-6 '), ['claude']);
  assert.deepEqual(inferRouteClientProtocols('Claude 4 Sonnet'), ['claude']);
  assert.deepEqual(inferRouteClientProtocols('claude/opus-5'), ['claude']);
  assert.deepEqual(inferRouteClientProtocols('anthropic/claude-opus-5'), ['claude']);
  assert.deepEqual(inferRouteClientProtocols('gpt-5.4'), ['openai-chat', 'openai-responses']);
  assert.deepEqual(inferRouteClientProtocols(''), []);
  assert.deepEqual(
    routeClientProtocols({ from: 'claude-opus-4', clientProtocols: ['responses'] }),
    ['openai-responses']
  );
  assert.deepEqual(routeClientProtocols({ from: 'claude-opus-4', clientProtocols: ['invalid'] }), [
    'claude',
  ]);
  assert.deepEqual(routeClientProtocols(null), []);
  assert.deepEqual(routeProtocolHintState('', []), {
    mode: 'empty',
    text: '输入客户端模型后会显示将暴露的入口协议；不勾选时按模型名推断。',
  });
  assert.deepEqual(routeProtocolHintState('Claude 4 Sonnet', []), {
    mode: 'inferred',
    text: '按模型名推断：Claude (3443/3080)',
  });
  assert.deepEqual(routeProtocolHintState('Claude 4 Sonnet', ['openai-chat']), {
    mode: 'explicit',
    text: '显式暴露到：OpenAI Chat (3447/3084)',
  });
  assert.equal(protocolName('tianxi'), 'Tianxi');
  assert.equal(entryProtocolName('openai-responses'), 'OpenAI Responses');
  assert.equal(preferredEntryProtocolForProfile({ protocol: 'tianxi' }), 'openai-responses');
  assert.equal(preferredEntryProtocolForProfile({ protocol: 'claude' }), 'claude');
  assert.equal(preferredEntryProtocolForProfile(null), 'openai-chat');

  for (const alias of ['responses', 'response', 'openai-response']) {
    assert.equal(normalizeEntryProtocol(alias), 'openai-responses');
  }
  for (const alias of ['chat', 'chat-completions', 'openai-chat-completions', 'openai']) {
    assert.equal(normalizeEntryProtocol(alias), 'openai-chat');
  }
  assert.equal(normalizeEntryProtocol('desktop'), 'claude-desktop');
  assert.equal(normalizeEntryProtocol(Symbol('invalid')), 'claude');

  const localInput = { host: ' proxy.local ', listenPort: '4545', basePath: ' /gateway ' };
  const local = normalizeLocalServer(localInput, { listenPort: 65536 });
  assert.deepEqual(local, {
    host: 'proxy.local',
    listenPort: 4545,
    basePath: '/gateway',
    protocol: 'claude',
  });
  assert.deepEqual(localInput, {
    host: ' proxy.local ',
    listenPort: '4545',
    basePath: ' /gateway ',
  });
  assert.equal(normalizeLocalServer({ listenPort: -1 }, { listenPort: 3555 }).listenPort, 3555);
  assert.equal(normalizeLocalServer({ listenPort: Infinity }).listenPort, 3443);
  assert.equal(normalizeLocalServer({ host: 'x'.repeat(500) }).host.length, 253);

  const defaults = buildDefaultEntryServers(local);
  assert.equal(defaults.length, 6);
  assert.equal(defaults[0].listenPort, 4545);
  assert.equal(defaults[0].host, 'proxy.local');
  assert.equal(defaults[3].tls, false);
  defaults[0].host = 'mutated';
  assert.equal(buildDefaultEntryServers(local)[0].host, 'proxy.local');

  const entries = normalizeEntryServers(
    [
      {
        protocol: 'claude',
        tls: true,
        name: 'Primary',
        host: '127.0.0.1',
        listenPort: 4443,
        basePath: '/api',
        enabled: false,
      },
      {
        protocol: 'desktop',
        tls: false,
        name: 'Desktop',
        listenPort: 9010,
      },
      { protocol: 'desktop', tls: true, listenPort: 70000 },
      null,
      'invalid',
    ],
    local
  );
  assert.equal(entries.length, 7);
  assert.deepEqual(entries[0], {
    name: 'Primary',
    host: '127.0.0.1',
    listenPort: 4443,
    basePath: '/api',
    protocol: 'claude',
    tls: true,
    enabled: false,
  });
  assert.equal(entries[6].protocol, 'claude-desktop');
  assert.equal(entries[6].listenPort, 9010);
  assert.equal(entries[6].tls, false);

  assert.deepEqual(splitEntryAuthList(' one, two ,, one '), ['one', 'two', 'one']);
  assert.deepEqual(splitEntryAuthList({ toString: () => 'unsafe' }), []);
  assert.ok(splitEntryAuthList('x'.repeat(5000))[0].length <= 4096);

  const authKey = normalizeEntryAuthKey(
    {
      id: ' key-1 ',
      name: ' local ',
      key: ` ${'s'.repeat(5000)} `,
      enabled: false,
      allowedEntryProtocols: ['chat', 'chat', 'responses'],
      allowedEntryPorts: [3443, '3443', 0, 65536, 'bad'],
      allowedProfileIds: [' main ', 'main', '', { id: 'unsafe' }],
    },
    4
  );
  assert.equal(authKey.id, 'key-1');
  assert.equal(authKey.name, 'local');
  assert.equal(authKey.key.length, 4096);
  assert.equal(authKey.enabled, false);
  assert.deepEqual(authKey.allowedEntryProtocols, ['openai-chat', 'openai-responses']);
  assert.deepEqual(authKey.allowedEntryPorts, [3443]);
  assert.deepEqual(authKey.allowedProfileIds, ['main']);
  assert.equal(normalizeEntryAuthKey(null, -1).id, 'entry-key-1');

  const deterministicRandom = {
    getRandomValues(bytes) {
      bytes.fill(0xab);
      return bytes;
    },
  };
  assert.equal(createEntryAuthSecret(deterministicRandom), `hpm_${'ab'.repeat(24)}`);
  assert.throws(() => createEntryAuthSecret(null), /secure random source is unavailable/);
  assert.throws(
    () =>
      createEntryAuthSecret({
        getRandomValues() {
          throw new Error('random source failed');
        },
      }),
    /random source failed/
  );

  const defaultKey = createDefaultEntryAuthKey(
    [
      { protocol: 'claude', listenPort: 3443, enabled: true },
      { protocol: 'chat', listenPort: '3447', enabled: true },
      { protocol: 'responses', listenPort: 3082, enabled: false },
      { protocol: 'chat', listenPort: 3447, enabled: true },
      { protocol: 'desktop', listenPort: 0, enabled: true },
    ],
    () => 'hpm_secret'
  );
  assert.equal(defaultKey.key, 'hpm_secret');
  assert.deepEqual(defaultKey.allowedEntryProtocols, ['claude', 'openai-chat', 'claude-desktop']);
  assert.deepEqual(defaultKey.allowedEntryPorts, [3443, 3447]);
  assert.throws(() => createDefaultEntryAuthKey([], null), /createSecret must be a function/);

  let generatedSecrets = 0;
  const normalizedAuth = normalizeEntryAuth(null, defaults, () => {
    generatedSecrets += 1;
    return 'hpm_generated';
  });
  assert.equal(normalizedAuth.enabled, true);
  assert.equal(normalizedAuth.keys.length, 1);
  assert.equal(normalizedAuth.keys[0].key, 'hpm_generated');
  assert.equal(generatedSecrets, 1);
  assert.equal(
    normalizeEntryAuth({ enabled: false, keys: [] }, defaults, () => 'hpm_recovered').enabled,
    true
  );
  const existingAuth = normalizeEntryAuth(
    {
      enabled: false,
      keys: [{ id: 'existing', key: 'secret' }],
      allowedOrigins: [
        'https://trusted.example',
        'https://trusted.example/path',
        'javascript:alert(1)',
      ],
    },
    defaults,
    () => {
      throw new Error('must not generate');
    }
  );
  assert.deepEqual(existingAuth.allowedOrigins, ['https://trusted.example']);
  assert.equal(existingAuth.enabled, false);
  assert.equal(existingAuth.keys[0].id, 'existing');

  const defaultSettings = normalizeAppSettings(null, {
    notificationsSupported: true,
    cachedPerformanceMode: 'false',
  });
  assert.equal(defaultSettings.closeToTray, true);
  assert.equal(defaultSettings.desktopNotifications, true);
  assert.equal(defaultSettings.performanceMode, false);
  assert.equal(defaultSettings.forceResponseStreaming, false);
  assert.equal(defaultSettings.forceChatStreaming, false);
  assert.equal(defaultSettings.upstreamWarmupEnabled, false);
  assert.equal(defaultSettings.streamDirectRequestBodies, false);
  assert.equal(defaultSettings.upstreamWarmupIntervalMs, 45000);
  assert.equal(defaultSettings.upstreamWarmupMaxTargets, 4);
  assert.equal(defaultSettings.upstreamWarmupStaggerMs, 200);
  assert.equal(defaultSettings.responseStreamingRolloutPercent, 0);
  const customSettings = normalizeAppSettings(
    {
      closeToTray: false,
      autoStartProxy: 'false',
      extensionSetting: 'preserved',
    },
    {}
  );
  assert.equal(customSettings.closeToTray, false);
  assert.equal(customSettings.autoStartProxy, true);
  assert.equal(customSettings.desktopNotifications, false);
  assert.equal(customSettings.extensionSetting, 'preserved');
  assert.equal(customSettings.upstreamWarmupIntervalMs, 45000);
  assert.equal(customSettings.upstreamWarmupMaxTargets, 4);
  assert.equal(customSettings.upstreamWarmupStaggerMs, 200);
  assert.equal(customSettings.responseStreamingRolloutPercent, 0);

  console.log('[configuration-model.test] ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
