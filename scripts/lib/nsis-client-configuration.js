'use strict';

const { performance } = require('node:perf_hooks');
const { dataSnapshot } = require('./context-recovery-daemon-http-boundary');
const fail = () => new Error('installed_client_configuration_failed');
function installedClientConfiguration(before, identity, input) {
  const options = dataSnapshot(input, 'installed_client_configuration_failed');
  before = dataSnapshot(before, 'installed_client_configuration_failed');
  identity = dataSnapshot(identity, 'installed_client_configuration_failed');
  if (
    Object.keys(options).sort().join(',') !== 'client,entryToken,mode,upstreamToken' ||
    !['codex', 'claude'].includes(options.client) ||
    !['default', 'enhanced'].includes(options.mode) ||
    !/^hpm-synthetic-[a-f0-9]{32}$/.test(options.entryToken) ||
    !/^hpm-upstream-[a-f0-9]{32}$/.test(options.upstreamToken) ||
    typeof before._revision !== 'string' ||
    before._revision.length < 1 ||
    before._revision.length > 256 ||
    ![identity.entryPort, identity.managementPort].every(
      (p) => Number.isSafeInteger(p) && p >= 1024 && p <= 65535
    ) ||
    identity.entryPort === identity.managementPort
  )
    throw fail();
  const protocol = options.client === 'codex' ? 'openai-responses' : 'claude';
  const profileId = 'hpm-installed-' + options.client;
  return {
    ...before,
    profiles: [
      {
        id: profileId,
        name: profileId,
        protocol: options.client === 'codex' ? 'openai' : 'claude',
        targetUrl:
          options.client === 'codex' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com',
        apiKey: options.upstreamToken,
        authMode: 'api-key',
      },
    ],
    activeProfile: profileId,
    modelRoutes: [],
    claudeDesktopRoutes: [],
    localServer: {
      host: '127.0.0.1',
      listenPort: identity.entryPort,
      managementPort: identity.managementPort,
      protocol,
      basePath: '/v1',
    },
    entryServers: [{ host: '127.0.0.1', listenPort: identity.entryPort, protocol, tls: false }],
    entryAuth: {
      enabled: true,
      keys: [
        {
          id: profileId,
          key: options.entryToken,
          enabled: true,
          allowedEntryProtocols: [protocol],
          allowedEntryPorts: [identity.entryPort],
          allowedProfileIds: [profileId],
        },
      ],
    },
    appSettings: {
      ...before.appSettings,
      contextRecoveryEnabled: options.mode === 'enhanced',
      contextRecoveryPersistenceEnabled: options.mode === 'enhanced',
      verifyUpstreamTls: true,
      upstreamDnsServers: [],
      upstreamWarmupEnabled: false,
      conversationAuditEnabled: false,
      conversationAuditCaptureContent: false,
      antigravityCredentialWatchdogEnabled: false,
    },
    diagnostics: { enabled: false },
  };
}
async function configureInstalledClient(
  owner,
  options,
  clock = {
    now: () => performance.now(),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
) {
  try {
    const before = await owner.request({ method: 'GET', route: '/v1/local/config' });
    if (before.status !== 200) throw fail();
    const config = installedClientConfiguration(before.body, owner.identity, options);
    const saved = await owner.request({ method: 'POST', route: '/v1/local/config', body: config });
    if (saved.status !== 200 || saved.body?.ok !== true || typeof saved.body.revision !== 'string')
      throw fail();
    const after = await owner.request({ method: 'GET', route: '/v1/local/config' });
    if (
      after.status !== 200 ||
      after.body?._revision !== saved.body.revision ||
      after.body.activeProfile !== config.activeProfile ||
      after.body.appSettings?.contextRecoveryEnabled !==
        config.appSettings.contextRecoveryEnabled ||
      after.body.appSettings?.contextRecoveryPersistenceEnabled !==
        config.appSettings.contextRecoveryPersistenceEnabled ||
      after.body.appSettings?.verifyUpstreamTls !== true ||
      JSON.stringify(after.body.appSettings.upstreamDnsServers) !== '[]' ||
      JSON.stringify(after.body.entryAuth?.keys?.[0]?.allowedProfileIds) !==
        JSON.stringify(config.entryAuth.keys[0].allowedProfileIds) ||
      after.body.profiles?.find((p) => p.id === config.activeProfile)?.targetUrl !==
        config.profiles[0].targetUrl
    )
      throw fail();
    const start = clock.now();
    let previous = start;
    if (!Number.isFinite(start)) throw fail();
    for (let polls = 0; polls < 150; polls++) {
      const now = clock.now();
      if (
        !Number.isFinite(now) ||
        now < previous ||
        now - start >= 15000 ||
        !(await owner.isAlive())
      )
        throw fail();
      previous = now;
      const health = await owner.request({ method: 'GET', route: '/v1/local/health' });
      const value = health.body;
      if (
        health.status === 200 &&
        value?.pid === owner.identity.pid &&
        value.contextRecovery?.configValid === true &&
        value.contextRecovery.appliedEnabled === config.appSettings.contextRecoveryEnabled &&
        value.contextRecovery.storage === (options.mode === 'enhanced' ? 'persistent' : 'memory') &&
        value.ports?.entries?.length === 1 &&
        value.ports.entries[0].protocol === config.entryServers[0].protocol &&
        value.ports.entries[0].listenPort === owner.identity.entryPort &&
        clock.now() - start < 15000
      )
        return { protocol: config.entryServers[0].protocol };
      await clock.wait(100);
    }
    throw fail();
  } catch {
    throw fail();
  }
}
module.exports = { installedClientConfiguration, configureInstalledClient };
