'use strict';
const { randomBytes } = require('node:crypto');
const { types } = require('node:util');
const {
  startLifecycleChannel,
  snapshot,
  launchOptions,
} = require('../n09-ipc/lifecycle-channel.js');
const { createSameDirectoryLease } = require('../n09-ipc/same-directory-lease.js');
const { createClearClient } = require('../n09-ipc/clear-client.js');
const { createN09HostAckClient } = require('../n09-ack/bootstrap-client.js');
const { fields, discardN09PromiseRejection } = require('../n09-ack/contract.js');
const { waitForPrivatePreload } = require('./management-status-ready.js');
const { waitForManagementHttp } = require('./management-http-ready.js');
const { waitForAppliedRecovery } = require('./applied-recovery-ready.js');
const { seedReplyFailurePhase } = require('../shared/seed-reply-phase.js');
const { assertSyntheticProfileReadback } = require('./synthetic-profile-readback.js');
const { waitForRejectedStorage } = require('../n09-backup/rejected-storage');
const { recoveryFailurePhase, recoveryAdmissionFailurePhase } = require('./recovery-failure-phase');
const {
  createDaemonManagementHttpClient,
} = require('../../../scripts/lib/context-recovery-daemon-http-client.js');
const fail = () => new Error('n09_lifecycle_client_failed');

function createClientUnsafe(input, dependencies) {
  const options = launchOptions(input);
  dependencies = snapshot(dependencies);
  for (const key of Object.keys(dependencies))
    if (
      !['spawn', 'httpRequest', 'createHostAckClient', 'onPhase'].includes(key) ||
      typeof dependencies[key] !== 'function' ||
      types.isProxy(dependencies[key]) ||
      (key === 'createHostAckClient' && types.isAsyncFunction(dependencies[key]))
    )
      throw fail();
  const onPhase = dependencies.onPhase ?? (() => {});
  function reportAppliedFailure(error) {
    const phase = Object.getOwnPropertyDescriptor(error, 'phase')?.value;
    onPhase(Number.isInteger(phase) && phase >= 162 && phase <= 195 ? phase : 188);
    const detail = Object.getOwnPropertyDescriptor(error, 'detailPhase')?.value;
    if (Number.isInteger(detail) && detail >= 232 && detail <= 239) onPhase(detail);
  }
  // Dedicated synthetic-only token: no daily credentials and no receipt/API getter.
  let token = randomBytes(32).toString('hex');
  let channel;
  let disposed = false;
  let closeFailed = false;
  let current;
  let currentLeaseId;
  let syntheticBusiness;
  let hostAck;
  function closeHostAck() {
    const resource = hostAck;
    hostAck = undefined;
    if (resource) resource.close();
  }
  const handles = new WeakMap();
  const removed = new Set();
  const getChannel = () => {
    if (disposed) throw fail();
    if (!channel) channel = startLifecycleChannel(options, token, dependencies.spawn);
    return channel;
  };
  const record = (handle) => {
    const value = handles.get(handle);
    if (!value) throw fail();
    return value;
  };
  const handleFor = (leaseId, identity) => {
    currentLeaseId = leaseId;
    const handle = Object.freeze({});
    handles.set(handle, { leaseId, identity });
    return handle;
  };
  async function launch(operation, previous) {
    try {
      const older = previous && record(previous);
      const result = await getChannel().exchange(
        older ? { op: operation, leaseId: older.leaseId } : { op: operation }
      );
      return handleFor(older ? older.leaseId : result.leaseId, result.identity);
    } catch {
      // A failed start/restart can own a partial Job before any handle is returned.
      // Closing IPC causes registry-based finally cleanup, then exact-child exit.
      if (channel) {
        try {
          await channel.close();
        } catch {
          /* Preserve safe terminal failure. */
        }
      }
      throw fail();
    }
  }
  const lease = createSameDirectoryLease({
    ownedRoot: options.ownedRoot,
    operations: {
      startFreshOwnedCase: () => launch('start'),
      restartExistingOwnedCase: (previous) => launch('restart', previous),
      attestLifecycleIdentity: (handle) => record(handle).identity,
      stopOwnedCase: async (handle) => {
        const value = record(handle);
        const result = await getChannel().exchange({ op: 'stop', leaseId: value.leaseId });
        if (result.cleanup.pid !== value.identity.pid) throw fail();
        return true;
      },
      closeOwnedHandle: async (handle) => {
        const value = record(handle);
        if (removed.has(value.leaseId)) return true;
        await getChannel().exchange({ op: 'remove', leaseId: value.leaseId });
        removed.add(value.leaseId);
        return true;
      },
    },
  });
  function owner(input) {
    input = snapshot(input);
    if (
      disposed ||
      !current ||
      ['pid', 'manifestSha256', 'configDir', 'runtimeDir'].some(
        (key) => input[key] !== current[key]
      )
    )
      throw fail();
    return current;
  }
  function liveHandle() {
    // The single session opaque ID stays private, and is never caller-selected.
    if (!current || disposed) throw fail();
    return currentLeaseId;
  }
  const management = (identity) =>
    createDaemonManagementHttpClient(
      { port: identity.managementPort, token },
      dependencies.httpRequest
    );
  async function managementReady(identity, deadline = Date.now() + 15000) {
    onPhase(114);
    await waitForPrivatePreload(async () => {
      const reply = await getChannel().exchange({ op: 'status', leaseId: liveHandle() });
      return reply.status;
    }, deadline);
    onPhase(115);
    let response;
    try {
      response = await waitForManagementHttp(
        () => management(identity)({ method: 'GET', route: '/v1/local/health' }),
        deadline
      );
    } catch (error) {
      const phase = Object.getOwnPropertyDescriptor(error, 'phase')?.value;
      onPhase(Number.isInteger(phase) && phase >= 185 && phase <= 195 ? phase : 186);
      throw fail();
    }
    if (Date.now() >= deadline) {
      onPhase(189);
      throw fail();
    }
    if (response.status !== 200) {
      onPhase(187);
      onPhase(seedReplyFailurePhase(response.status));
      throw fail();
    }
    let body, runtime;
    try {
      body = snapshot(response.body);
      runtime = snapshot(body.runtime);
    } catch {
      onPhase(188);
      throw fail();
    }
    let identityFailure;
    if (body.pid !== identity.pid) identityFailure = 240;
    else if (body.ok !== true || body.appId !== 'https-proxy-manager' || body.status !== 'running')
      identityFailure = 241;
    else {
      const fields = ['entrypoint', 'cwd', 'configDir', 'runtimeDir'];
      const mismatch = fields.findIndex((key) => runtime[key] !== identity[key]);
      if (mismatch >= 0) identityFailure = 242 + mismatch;
      else if (body.ports?.management !== identity.managementPort) identityFailure = 246;
    }
    if (identityFailure !== undefined) {
      onPhase(190);
      onPhase(identityFailure);
      throw fail();
    }
    return true;
  }
  const leaseStart = lease.startFreshBusinessHost;
  const leaseRestart = lease.restartSameBusinessHost;
  async function syntheticConfiguration(input) {
    const identity = owner(input);
    if (!syntheticBusiness) throw fail();
    const deadline = Date.now() + 15000;
    await managementReady(identity, deadline);
    const request = management(identity);
    onPhase(116);
    const configReply = await request({ method: 'GET', route: '/v1/local/config' });
    const config = snapshot(configReply.body);
    if (
      configReply.status !== 200 ||
      config.activeProfile !== 'n09-synthetic' ||
      !assertSyntheticProfileReadback(config.profiles) ||
      config.entryAuth?.enabled !== true ||
      config.entryAuth.keys?.length !== 1 ||
      config.entryAuth.keys[0].id !== 'n09-synthetic' ||
      JSON.stringify(config.entryAuth.keys[0].allowedEntryPorts) !==
        JSON.stringify([identity.entryPort]) ||
      JSON.stringify(config.entryAuth.keys[0].allowedProfileIds) !==
        JSON.stringify(['n09-synthetic']) ||
      config.appSettings?.contextRecoveryEnabled !== true ||
      config.appSettings?.contextRecoveryPersistenceEnabled !== true
    ) {
      onPhase(130);
      throw fail();
    }
    onPhase(119);
    return { identity, request, deadline };
  }
  const implementation = {
    async readRecoveryAdmissionFailurePhase(input) {
      const identity = owner(input);
      return recoveryAdmissionFailurePhase(
        await management(identity)({ method: 'GET', route: '/v1/local/health' })
      );
    },
    async readRecoveryFailurePhase(input) {
      const identity = owner(input);
      return recoveryFailurePhase(
        await management(identity)({ method: 'GET', route: '/v1/local/health' })
      );
    },
    async startLifecycle() {
      onPhase(112);
      current = await leaseStart();
      onPhase(113);
      return current;
    },
    async stopLifecycle(input) {
      const identity = owner(input);
      const result = await lease.killOwnedJob(identity);
      current = undefined;
      // Never insert mailbox or management I/O before the original forced kill.
      closeHostAck();
      return result;
    },
    async restartLifecycle(input) {
      // The lease validates the old identity and physical directory pins.
      current = await leaseRestart(input);
      return current;
    },
    async status(input) {
      owner(input);
      return (await getChannel().exchange({ op: 'status', leaseId: liveHandle() })).status;
    },
    async configureSyntheticBusiness(input, fixture) {
      const identity = owner(input);
      fixture = snapshot(fixture);
      if (
        Object.keys(fixture).sort().join(',') !== 'entryKey,upstreamKey' ||
        !['entryKey', 'upstreamKey'].every(
          (name) => typeof fixture[name] === 'string' && /^[a-f0-9]{48}$/.test(fixture[name])
        )
      )
        throw fail();
      if (
        syntheticBusiness &&
        (syntheticBusiness.entryKey !== fixture.entryKey ||
          syntheticBusiness.upstreamKey !== fixture.upstreamKey)
      )
        throw fail();
      syntheticBusiness = Object.freeze({
        entryKey: fixture.entryKey,
        upstreamKey: fixture.upstreamKey,
      });
      const deadline = Date.now() + 15000;
      await managementReady(identity, deadline);
      const request = management(identity);
      onPhase(116);
      const beforeReply = await request({ method: 'GET', route: '/v1/local/config' });
      const before = snapshot(beforeReply.body);
      if (
        beforeReply.status !== 200 ||
        typeof before._revision !== 'string' ||
        before._revision.length < 1 ||
        before._revision.length > 256
      )
        throw fail();
      const next = {
        ...before,
        activeProfile: 'n09-synthetic',
        modelRoutes: [],
        profiles: [
          {
            id: 'n09-synthetic',
            name: 'N09 synthetic',
            protocol: 'openai',
            targetUrl: 'https://api.openai.com/v1',
            apiKey: syntheticBusiness.upstreamKey,
            authMode: 'api-key',
          },
        ],
        entryAuth: {
          enabled: true,
          keys: [
            {
              id: 'n09-synthetic',
              key: syntheticBusiness.entryKey,
              enabled: true,
              allowedEntryProtocols: ['openai-responses'],
              allowedEntryPorts: [identity.entryPort],
              allowedProfileIds: ['n09-synthetic'],
            },
          ],
        },
        appSettings: {
          ...snapshot(before.appSettings),
          contextRecoveryEnabled: true,
          contextRecoveryPersistenceEnabled: true,
          verifyUpstreamTls: true,
          upstreamDnsServers: [],
          upstreamWarmupEnabled: false,
          conversationAuditEnabled: false,
          conversationAuditCaptureContent: false,
        },
      };
      onPhase(117);
      let saved;
      try {
        saved = await request({ method: 'POST', route: '/v1/local/config', body: next });
      } catch (error) {
        const deadline =
          error &&
          typeof error === 'object' &&
          !types.isProxy(error) &&
          Object.getOwnPropertyDescriptor(error, 'code')?.value === 'HPM_DAEMON_HTTP_DEADLINE';
        onPhase(deadline ? 126 : 121); // Fixed category only; never forward its error.
        throw fail();
      }
      if (saved.status !== 200) {
        onPhase(saved.status === 400 ? 122 : saved.status === 409 ? 123 : 124);
        throw fail();
      }
      if (saved.body?.ok !== true || typeof saved.body.revision !== 'string') {
        onPhase(125);
        throw fail();
      }
      onPhase(118);
      let afterReply;
      try {
        afterReply = await request({ method: 'GET', route: '/v1/local/config' });
      } catch (error) {
        const deadline =
          error &&
          typeof error === 'object' &&
          !types.isProxy(error) &&
          Object.getOwnPropertyDescriptor(error, 'code')?.value === 'HPM_DAEMON_HTTP_DEADLINE';
        onPhase(deadline ? 127 : 128);
        throw fail();
      }
      if (afterReply.status !== 200) {
        onPhase(129);
        throw fail();
      }
      try {
        const after = snapshot(afterReply.body);
        if (
          after._revision !== saved.body.revision ||
          after.activeProfile !== 'n09-synthetic' ||
          after.appSettings?.contextRecoveryEnabled !== true ||
          after.appSettings?.contextRecoveryPersistenceEnabled !== true ||
          after.appSettings?.verifyUpstreamTls !== true ||
          after.appSettings?.upstreamWarmupEnabled !== false ||
          after.appSettings?.conversationAuditEnabled !== false ||
          after.appSettings?.conversationAuditCaptureContent !== false ||
          !Array.isArray(after.appSettings?.upstreamDnsServers) ||
          after.appSettings.upstreamDnsServers.length !== 0 ||
          !assertSyntheticProfileReadback(after.profiles) ||
          after.entryAuth?.enabled !== true ||
          after.entryAuth.keys?.length !== 1 ||
          after.entryAuth.keys[0].id !== 'n09-synthetic' ||
          JSON.stringify(after.entryAuth.keys[0].allowedEntryPorts) !==
            JSON.stringify([identity.entryPort]) ||
          JSON.stringify(after.entryAuth.keys[0].allowedProfileIds) !==
            JSON.stringify(['n09-synthetic'])
        )
          throw fail();
      } catch {
        onPhase(130);
        throw fail();
      }
      onPhase(119);
      while (true) {
        if (Date.now() >= deadline) throw fail();
        const health = await request({ method: 'GET', route: '/v1/local/health' });
        if (Date.now() >= deadline) throw fail();
        if (
          health.status === 200 &&
          health.body?.pid === identity.pid &&
          health.body.contextRecovery?.appliedEnabled === true &&
          health.body.contextRecovery?.storage === 'persistent'
        )
          break;
        if (
          Date.now() >= deadline ||
          (await getChannel().exchange({ op: 'status', leaseId: liveHandle() })).status.alive !==
            true
        )
          throw fail();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      onPhase(120);
      return Object.freeze({
        configured: true,
        evidenceLevel: 'synthetic-management-configuration',
        dailyConfigurationUsed: false,
      });
    },
    async attestSyntheticBusiness(input) {
      const { identity, request, deadline } = await syntheticConfiguration(input);
      try {
        await waitForAppliedRecovery(
          () => request({ method: 'GET', route: '/v1/local/health' }),
          async () =>
            (await getChannel().exchange({ op: 'status', leaseId: liveHandle() })).status.alive,
          identity.pid,
          deadline
        );
      } catch (error) {
        reportAppliedFailure(error);
        throw fail();
      }
      return Object.freeze({ ready: true, syntheticBusinessConfigured: true });
    },
    async attestRejectedPersistentStorage(input) {
      const { identity, request, deadline } = await syntheticConfiguration(input);
      await waitForRejectedStorage(
        () => request({ method: 'GET', route: '/v1/local/health' }),
        async () =>
          (await getChannel().exchange({ op: 'status', leaseId: liveHandle() })).status.alive,
        identity.pid,
        deadline
      );
      return Object.freeze({ persistentStorageRejected: true, syntheticBusinessConfigured: true });
    },
    getClearCapability(input) {
      const identity = owner(input);
      const clear = createClearClient(
        { port: identity.managementPort, token },
        dependencies.httpRequest
      );
      return async () => {
        try {
          owner(identity);
          await managementReady(identity);
          return await clear();
        } catch {
          throw fail();
        }
      };
    },
    getHostAckClient(input) {
      const identity = owner(input);
      if (hostAck) return hostAck.facade;
      const resource = (dependencies.createHostAckClient ?? createN09HostAckClient)({
        runtimeDir: identity.runtimeDir,
        pid: identity.pid,
        manifestSha256: identity.manifestSha256,
        token,
      });
      if (types.isPromise(resource)) {
        discardN09PromiseRejection(resource);
        throw fail();
      }
      const methods = fields(resource, ['submit', 'readArmed', 'readReceipt', 'close']);
      for (const method of Object.values(methods))
        if (typeof method !== 'function' || types.isProxy(method) || types.isAsyncFunction(method))
          throw fail();
      let resourceClosed = false,
        resourceCloseFailed = false;
      function invoke(name, args) {
        const value = Reflect.apply(methods[name], resource, args);
        if (types.isPromise(value)) {
          discardN09PromiseRejection(value);
          throw fail();
        }
        return value;
      }
      function close() {
        if (resourceClosed) {
          if (resourceCloseFailed) throw fail();
          return;
        }
        resourceClosed = true;
        try {
          if (invoke('close', []) !== undefined) throw fail();
        } catch {
          resourceCloseFailed = true;
          throw fail();
        }
      }
      const facade = Object.freeze(
        Object.fromEntries(
          Object.keys(methods).map((name) => [
            name,
            (...args) => {
              try {
                owner(identity);
                if (resourceClosed || hostAck?.facade !== facade) throw fail();
                return name === 'close' ? close() : invoke(name, args);
              } catch {
                throw fail();
              }
            },
          ])
        )
      );
      hostAck = { facade, close };
      return facade;
    },
    async setCombination(input, combination) {
      const identity = owner(input);
      if (!['00', '01', '10', '11'].includes(combination)) throw fail();
      const deadline = Date.now() + 15000;
      await managementReady(identity, deadline);
      const request = management(identity);
      onPhase(116);
      const beforeReply = await request({ method: 'GET', route: '/v1/local/config' });
      const before = snapshot(beforeReply.body);
      const settings = snapshot(before.appSettings);
      if (
        beforeReply.status !== 200 ||
        typeof before._revision !== 'string' ||
        before._revision.length < 1 ||
        before._revision.length > 256
      )
        throw fail();
      const enabled = combination[0] === '1';
      const persistence = combination[1] === '1';
      onPhase(117);
      const saved = await request({
        method: 'POST',
        route: '/v1/local/config',
        body: {
          ...before,
          ...(syntheticBusiness
            ? {
                // loadConfig adds built-in routes for official profiles. This
                // save replaces those profiles with the single synthetic one.
                modelRoutes: [],
                profiles: [
                  {
                    id: 'n09-synthetic',
                    name: 'N09 synthetic',
                    protocol: 'openai',
                    targetUrl: 'https://api.openai.com/v1',
                    apiKey: syntheticBusiness.upstreamKey,
                    authMode: 'api-key',
                  },
                ],
                entryAuth: {
                  enabled: true,
                  keys: [
                    {
                      id: 'n09-synthetic',
                      key: syntheticBusiness.entryKey,
                      enabled: true,
                      allowedEntryProtocols: ['openai-responses'],
                      allowedEntryPorts: [identity.entryPort],
                      allowedProfileIds: ['n09-synthetic'],
                    },
                  ],
                },
              }
            : {}),
          appSettings: {
            ...settings,
            contextRecoveryEnabled: enabled,
            contextRecoveryPersistenceEnabled: persistence,
          },
        },
      });
      if (
        saved.status !== 200 ||
        saved.body?.ok !== true ||
        typeof saved.body.revision !== 'string' ||
        saved.body.revision.length < 1 ||
        saved.body.revision.length > 256
      )
        throw fail();
      onPhase(118);
      let afterReply;
      try {
        afterReply = await request({ method: 'GET', route: '/v1/local/config' });
      } catch (error) {
        const deadline =
          error &&
          typeof error === 'object' &&
          !types.isProxy(error) &&
          Object.getOwnPropertyDescriptor(error, 'code')?.value === 'HPM_DAEMON_HTTP_DEADLINE';
        onPhase(deadline ? 127 : 128);
        throw fail();
      }
      if (afterReply.status !== 200) {
        onPhase(129);
        throw fail();
      }
      const after = snapshot(afterReply.body);
      if (
        after._revision !== saved.body.revision ||
        after.appSettings?.contextRecoveryEnabled !== enabled ||
        after.appSettings?.contextRecoveryPersistenceEnabled !== persistence
      ) {
        onPhase(130);
        throw fail();
      }
      onPhase(119);
      try {
        await waitForAppliedRecovery(
          () => request({ method: 'GET', route: '/v1/local/health' }),
          async () =>
            (await getChannel().exchange({ op: 'status', leaseId: liveHandle() })).status.alive,
          identity.pid,
          deadline,
          {},
          { enabled, persistent: persistence },
          {
            enabled: settings.contextRecoveryEnabled,
            persistent: settings.contextRecoveryPersistenceEnabled,
          }
        );
      } catch (error) {
        reportAppliedFailure(error);
        throw fail();
      }
      return Object.freeze({
        enabled,
        persistence,
        savedConfigVerified: true,
        evidenceLevel: 'lifecycle-identity-only',
        liveDaemonProved: false,
      });
    },
    async close() {
      if (disposed) {
        if (closeFailed) throw fail();
        return;
      }
      let failed = false;
      try {
        await lease.close();
      } catch {
        failed = true;
      }
      try {
        if (channel && (await channel.close()) !== true) failed = true;
      } catch {
        failed = true;
      }
      try {
        closeHostAck();
      } catch {
        failed = true;
      }
      disposed = true;
      current = undefined;
      token = undefined;
      syntheticBusiness = undefined;
      closeFailed = failed;
      if (failed) throw fail();
    },
  };
  return implementation;
}
function createN09LifecycleClient(input, dependencies = {}) {
  try {
    const implementation = createClientUnsafe(input, dependencies);
    return Object.freeze(
      Object.fromEntries(
        Object.entries(implementation).map(([key, operation]) => [
          key,
          (...args) => {
            try {
              const value = operation(...args);
              return value && typeof value.then === 'function'
                ? value.catch(() => {
                    throw fail();
                  })
                : value;
            } catch {
              throw fail();
            }
          },
        ])
      )
    );
  } catch {
    throw fail();
  }
}
module.exports = { createN09LifecycleClient };
