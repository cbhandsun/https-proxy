'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const {
  createDaemonManagementHttpClient,
} = require('../scripts/lib/context-recovery-daemon-http-client');
const {
  runDaemonHttpSettingsMatrix,
} = require('../scripts/lib/context-recovery-daemon-http-matrix');
const { discoverTestFiles, selectUnitTestFiles } = require('../lib/test-discovery');

function fixture(change = () => {}) {
  const calls = [];
  let time = 0;
  const adapter = {
    now: () => time,
    wait: async (ms) => {
      time += ms;
    },
    verifyOwnedIdentity: async () => true,
    launch: async ({ label, initialEnabled, initialPersistence }) => {
      calls.push(['launch', label]);
      assert.equal(initialEnabled, false);
      assert.equal(initialPersistence, false);
      const root = path.resolve('synthetic-sensitive-directory', label);
      const identity = {
        pid: 1234,
        cwd: path.join(root, 'repo'),
        entrypoint: path.join(root, 'repo', 'openai-proxy.js'),
        configDir: path.join(root, 'config'),
        runtimeDir: path.join(root, 'runtime'),
        managementPort: 15001,
        entryPort: 15002,
      };
      let enabled = false;
      let persistence = false;
      let saved = false;
      let pending = true;
      let revision = 'before';
      const config = () => ({
        _revision: revision,
        unrelatedField: 'preserve-me',
        profiles: [{ apiKey: 'redacted-sensitive-placeholder' }],
        appSettings: {
          unrelatedSetting: true,
          contextRecoveryEnabled: enabled,
          contextRecoveryPersistenceEnabled: persistence,
        },
      });
      const owner = {
        identity,
        isAlive: async () => true,
        stop: async () => {
          calls.push(['stop', label]);
          return true;
        },
        inspectStorage: async () => {
          const durable = enabled && persistence;
          return {
            allWithinRoot: true,
            directoryPresent: durable,
            checkpointPresent: durable,
            writerDatabasePresent: durable,
            wrappedKeyPresent: durable,
          };
        },
        request: async (input) => {
          calls.push([input.method, input.route, label]);
          if (input.route === '/v1/local/config') {
            if (input.method === 'GET') return { status: 200, body: config() };
            assert.equal(input.body.unrelatedField, 'preserve-me');
            assert.equal(input.body.profiles[0].apiKey, 'redacted-sensitive-placeholder');
            assert.equal(input.body.appSettings.unrelatedSetting, true);
            assert.equal(input.body._revision, 'before');
            enabled = input.body.appSettings.contextRecoveryEnabled;
            persistence = input.body.appSettings.contextRecoveryPersistenceEnabled;
            saved = true;
            revision = 'after';
            return { status: 200, body: { ok: true, revision } };
          }
          const state = saved && pending ? 'pending_application' : null;
          pending = false;
          return {
            status: 200,
            body: {
              ok: true,
              appId: 'https-proxy-manager',
              status: 'running',
              pid: identity.pid,
              runtime: {
                ...identity,
                contextRecoveryDirectory: path.join(identity.runtimeDir, 'context-recovery-v1'),
              },
              ports: {
                management: identity.managementPort,
                entries: [
                  {
                    protocol: 'openai-responses',
                    host: '127.0.0.1',
                    listenPort: identity.entryPort,
                    tls: false,
                  },
                ],
              },
              contextRecovery: {
                configValid: true,
                restartRetention: false,
                requestedEnabled: enabled,
                appliedEnabled: enabled,
                state: state ?? (enabled ? 'enabled_restricted' : 'disabled'),
                storage: enabled && persistence ? 'persistent' : 'memory',
              },
            },
          };
        },
      };
      change(owner, adapter, label);
      return owner;
    },
  };
  return { adapter, calls };
}

test('daemon HTTP matrix is dry-run by default and CLI refuses live arguments', async () => {
  const poison = new Proxy({}, { get: () => assert.fail('dry-run accessed adapter') });
  const report = await runDaemonHttpSettingsMatrix(poison);
  assert.deepEqual(report.cases, ['00', '01', '10', '11']);
  assert.equal(report.mode, 'dry-run');
  const cli = path.resolve(__dirname, '../scripts/qualify-context-recovery-daemon-http.js');
  const dry = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(dry.status, 0);
  assert.equal(JSON.parse(dry.stdout).mode, 'dry-run');
  const refused = spawnSync(process.execPath, [cli, '--execute'], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, '');
  assert.equal(refused.stderr.trim(), 'daemon_http_matrix_refused');
});

test('synthetic matrix preserves config, checks application, storage and owned cleanup', async () => {
  const { adapter, calls } = fixture();
  const report = await runDaemonHttpSettingsMatrix(adapter, { mode: 'execute' });
  assert.equal(report.passed, true);
  assert.equal(report.retentionQualified, false);
  assert.equal(report.clientQualified, false);
  assert.equal(report.gracefulDrainQualified, false);
  assert.equal(report.modelRequests, 0);
  for (const item of report.cases) {
    assert.equal(item.configSaved, true);
    assert.equal(item.applicationObserved, true);
    assert.equal(item.storageVerified, true);
    assert.equal(item.ownedStopAcknowledged, true);
    assert.equal(item.cleanupSemantics, 'forced_cleanup');
  }
  assert.deepEqual(
    calls.filter(([name]) => name === 'launch' || name === 'stop'),
    ['00', '01', '10', '11'].flatMap((label) => [
      ['launch', label],
      ['stop', label],
    ])
  );
  const encoded = JSON.stringify(report);
  for (const forbidden of ['sensitive', 'apiKey', 'profiles', 'pid', 'runtimeDir', 'token'])
    assert.equal(encoded.includes(forbidden), false);
});

test('save success does not satisfy a pending runtime application barrier', async () => {
  const { adapter } = fixture((owner) => {
    const original = owner.request;
    let saved = false;
    owner.request = async (input) => {
      const response = await original(input);
      if (input.method === 'POST') saved = true;
      if (saved && input.route.endsWith('/health'))
        response.body.contextRecovery.state = 'pending_application';
      return response;
    };
  });
  const report = await runDaemonHttpSettingsMatrix(adapter, {
    mode: 'execute',
    timeoutMs: 2,
    pollMs: 1,
    maxPolls: 10,
  });
  assert.equal(report.passed, false);
  assert.equal(report.cases[0].failure, 'application_timeout');
  assert.equal(report.cases[0].configSaved, true);
  assert.equal(report.cases[0].applicationObserved, false);
  assert.equal(report.cases[0].ownedStopAcknowledged, true);
});

test('invalid options and adapters fail before launching', async () => {
  const { adapter, calls } = fixture();
  for (const options of [
    null,
    [],
    { mode: 'live' },
    { mode: 'execute', timeoutMs: 0 },
    { mode: 'execute', timeoutMs: Infinity },
    { mode: 'execute', pollMs: '1' },
    { mode: 'execute', maxPolls: 2001 },
  ])
    await assert.rejects(runDaemonHttpSettingsMatrix(adapter, options), /invalid_options/);
  await assert.rejects(runDaemonHttpSettingsMatrix({}, { mode: 'execute' }), /invalid_adapter/);
  assert.deepEqual(calls, []);
});

test('identity, authentication, malformed, conflict and exit failures remain safe', async () => {
  const changes = [
    [
      'identity_mismatch',
      (owner) => {
        owner.identity.pid = 0;
      },
    ],
    [
      'process_exited',
      (owner) => {
        owner.isAlive = async () => false;
      },
    ],
    [
      'http_failed',
      (owner) => {
        owner.request = async () => {
          throw new Error('token-sensitive');
        };
      },
    ],
    [
      'invalid_response',
      (owner) => {
        owner.request = async () => null;
      },
    ],
    [
      'identity_mismatch',
      (owner) => {
        const original = owner.request;
        owner.request = async (input) => {
          const response = await original(input);
          if (input.route.endsWith('/health')) response.body.pid++;
          return response;
        };
      },
    ],
    ...[401, 409, 400].map((status) => [
      'save_failed',
      (owner) => {
        const original = owner.request;
        owner.request = async (input) =>
          input.method === 'POST' ? { status, body: { error: 'sensitive-body' } } : original(input);
      },
    ]),
    [
      'storage_mismatch',
      (owner) => {
        owner.inspectStorage = async () => ({ allWithinRoot: false });
      },
    ],
    [
      'saved_config_mismatch',
      (owner) => {
        const original = owner.request;
        let reads = 0;
        owner.request = async (input) => {
          const response = await original(input);
          if (input.route.endsWith('/config') && input.method === 'GET' && ++reads > 1)
            response.body._revision = 'wrong';
          return response;
        };
      },
    ],
  ];
  for (const [failure, change] of changes) {
    const { adapter, calls } = fixture(change);
    const report = await runDaemonHttpSettingsMatrix(adapter, { mode: 'execute' });
    assert.equal(report.passed, false);
    assert.equal(report.cases.length, 1);
    assert.equal(report.cases[0].failure, failure);
    assert.equal(report.cases[0].ownedStopAcknowledged, true);
    assert.equal(JSON.stringify(report).includes('sensitive'), false);
    assert.equal(calls.filter(([name]) => name === 'stop').length, 1);
  }
});

test('cleanup failure prevents another launch and is never swallowed', async () => {
  for (const stop of [
    async () => false,
    async () => {
      throw new Error('sensitive');
    },
  ]) {
    const { adapter, calls } = fixture((owner) => {
      owner.stop = stop;
    });
    const report = await runDaemonHttpSettingsMatrix(adapter, { mode: 'execute' });
    assert.equal(report.cases.length, 1);
    assert.equal(report.cases[0].failure, 'cleanup_failed');
    assert.equal(report.passed, false);
    assert.equal(calls.filter(([name]) => name === 'launch').length, 1);
  }
});

test('new regression file is discovered by the unified unit-test selector', () => {
  const repo = path.resolve(__dirname, '..');
  assert.ok(
    selectUnitTestFiles(discoverTestFiles(repo)).includes(
      'test/context-recovery-daemon-http-matrix.test.js'
    )
  );
});

test('fresh matrix cases reject directory reuse before saving another config', async () => {
  let first;
  const { adapter } = fixture((owner) => {
    first ??= owner.identity.configDir;
    owner.identity.configDir = first;
  });
  const report = await runDaemonHttpSettingsMatrix(adapter, { mode: 'execute' });
  assert.equal(report.cases.length, 2);
  assert.equal(report.cases[0].passed, true);
  assert.equal(report.cases[1].failure, 'identity_mismatch');
  assert.equal(report.cases[1].configSaved, false);
});

function wireMock(action) {
  const calls = [];
  const wire = (options, callback) => {
    const request = new EventEmitter();
    request.destroy = () => {
      calls.push('destroy');
    };
    request.end = (body) => {
      calls.push({ options, body });
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        callback(response);
        action(response, request);
      });
    };
    return request;
  };
  return { calls, wire };
}

test('bounded HTTP client uses only explicit loopback management routes and private token', async () => {
  const { calls, wire } = wireMock((response) => {
    response.emit('data', Buffer.from('{"ok":true}'));
    response.emit('end');
  });
  const client = createDaemonManagementHttpClient({ port: 15000, token: 'x'.repeat(32) }, wire);
  assert.deepEqual(await client({ method: 'GET', route: '/v1/local/health' }), {
    status: 200,
    body: { ok: true },
  });
  const sent = calls[0];
  assert.equal(sent.options.hostname, '127.0.0.1');
  assert.equal(sent.options.agent, false);
  assert.equal(sent.options.headers['x-mgmt-token'], 'x'.repeat(32));
  assert.equal(sent.body, '');
  for (const input of [
    null,
    {},
    { method: 'GET', route: 'https://evil.example/' },
    { method: 'GET', route: '/v1/local/config?token=secret' },
    { method: 'POST', route: '/v1/local/config' },
    { method: 'POST', route: '/v1/local/config', body: 'x'.repeat(300000) },
  ])
    await assert.rejects(client(input), /invalid_http_request/);
  assert.equal(calls.length, 1);
  for (const options of [
    null,
    {},
    { port: 80, token: 'x'.repeat(32) },
    { port: 15000, token: 'x\r\nsecret' },
    { port: 15000, token: '' },
  ])
    assert.throws(() => createDaemonManagementHttpClient(options, wire), /invalid_http_client/);
});

test('HTTP errors, oversized bodies, malformed JSON and premature close fail safely', async () => {
  const actions = [
    (response) => {
      response.emit('data', '{bad-sensitive');
      response.emit('end');
    },
    (response) => {
      response.emit('data', '[]');
      response.emit('end');
    },
    (response) => {
      response.emit('data', Buffer.alloc(300000));
      response.emit('end');
    },
    (response) => {
      response.emit('aborted');
    },
    (response) => {
      response.emit('error', new Error('sensitive-error'));
    },
    (_, request) => {
      request.emit('error', new Error('sensitive-error'));
    },
  ];
  for (const action of actions) {
    const { wire } = wireMock(action);
    const client = createDaemonManagementHttpClient({ port: 15000, token: 'x'.repeat(32) }, wire);
    await assert.rejects(client({ method: 'GET', route: '/v1/local/config' }), {
      message: 'daemon_http_request_failed',
    });
  }
});

test('HTTP client has an absolute timeout even when the peer never sends headers', async () => {
  let destroyed = false;
  const client = createDaemonManagementHttpClient({ port: 15000, token: 'x'.repeat(32) }, () => {
    const request = new EventEmitter();
    request.end = () => {};
    request.destroy = () => {
      destroyed = true;
    };
    return request;
  });
  await assert.rejects(
    client({ method: 'GET', route: '/v1/local/health' }),
    /daemon_http_request_failed/
  );
  assert.equal(destroyed, true);
});

test('matrix boundary refuses getter and Proxy options/adapters without executing hooks', async () => {
  let hooks = 0;
  const hostileProxy = new Proxy(
    {},
    {
      get() {
        hooks++;
        throw new Error('sensitive');
      },
      getPrototypeOf() {
        hooks++;
        throw new Error('sensitive');
      },
      ownKeys() {
        hooks++;
        throw new Error('sensitive');
      },
    }
  );
  const getterOptions = Object.defineProperty({}, 'mode', {
    enumerable: true,
    get() {
      hooks++;
      throw new Error('sensitive');
    },
  });
  for (const options of [hostileProxy, getterOptions])
    await assert.rejects(runDaemonHttpSettingsMatrix({}, options), /invalid_options/);
  const getterAdapter = Object.defineProperty({}, 'launch', {
    get() {
      hooks++;
      throw new Error('sensitive');
    },
  });
  for (const adapter of [hostileProxy, getterAdapter])
    await assert.rejects(
      runDaemonHttpSettingsMatrix(adapter, { mode: 'execute' }),
      /invalid_adapter/
    );
  const { adapter } = fixture();
  adapter.launch = hostileProxy;
  await assert.rejects(
    runDaemonHttpSettingsMatrix(adapter, { mode: 'execute' }),
    /invalid_adapter/
  );
  assert.equal(hooks, 0);
});

test('owner, identity, response and storage accessors fail closed with safe owned cleanup', async () => {
  let hooks = 0;
  const getter = () => {
    hooks++;
    throw new Error('sensitive-private');
  };
  const changes = [
    (owner) => {
      Object.defineProperty(owner, 'request', { get: getter });
    },
    (owner) => {
      Object.defineProperty(owner.identity, 'pid', { get: getter });
    },
    (owner) => {
      owner.identity = new Proxy({}, { get: getter, getPrototypeOf: getter });
    },
    (owner) => {
      owner.request = async () =>
        Object.defineProperty({}, 'status', { enumerable: true, get: getter });
    },
    (owner) => {
      owner.inspectStorage = async () =>
        Object.defineProperty({}, 'allWithinRoot', { enumerable: true, get: getter });
    },
  ];
  for (const change of changes) {
    const { adapter } = fixture(change);
    const report = await runDaemonHttpSettingsMatrix(adapter, { mode: 'execute' });
    assert.equal(report.passed, false);
    assert.equal(report.cases[0].ownedStopAcknowledged, true);
    assert.equal(JSON.stringify(report).includes('sensitive'), false);
  }
  const { adapter } = fixture();
  adapter.launch = () => new Proxy({}, { get: getter, getPrototypeOf: getter });
  const report = await runDaemonHttpSettingsMatrix(adapter, { mode: 'execute' });
  assert.equal(report.cases[0].failure, 'identity_mismatch');
  assert.equal(hooks, 0);
});

test('thrown values cannot invoke code getters or Proxy traps during error reporting', async () => {
  let hooks = 0;
  const getter = () => {
    hooks++;
    throw 'sensitive-thrown-value';
  };
  const errors = [
    Object.defineProperty({}, 'code', { get: getter }),
    new Proxy({}, { get: getter, getPrototypeOf: getter }),
  ];
  for (const error of errors) {
    const { adapter } = fixture((owner) => {
      owner.inspectStorage = async () => {
        throw error;
      };
    });
    const report = await runDaemonHttpSettingsMatrix(adapter, { mode: 'execute' });
    assert.equal(report.cases[0].failure, 'launch_failed');
    assert.equal(report.cases[0].ownedStopAcknowledged, true);
    adapter.launch = async () => {
      throw error;
    };
    const launch = await runDaemonHttpSettingsMatrix(adapter, { mode: 'execute' });
    assert.equal(launch.cases[0].failure, 'launch_failed');
    assert.equal(JSON.stringify(launch).includes('sensitive'), false);
  }
  assert.equal(hooks, 0);
});

test('HTTP client refuses input hooks, Proxy functions and nested toJSON without wire I/O', async () => {
  let hooks = 0;
  const getter = () => {
    hooks++;
    throw new Error('sensitive');
  };
  const proxy = new Proxy({}, { get: getter, getPrototypeOf: getter, ownKeys: getter });
  const { wire, calls } = wireMock(() => assert.fail('must not reach wire'));
  for (const options of [proxy, Object.defineProperty({}, 'port', { get: getter })])
    assert.throws(() => createDaemonManagementHttpClient(options, wire), /invalid_http_client/);
  const client = createDaemonManagementHttpClient({ port: 15000, token: 'x'.repeat(32) }, wire);
  for (const input of [
    proxy,
    Object.defineProperty({}, 'method', { enumerable: true, get: getter }),
    { method: 'POST', route: '/v1/local/config', body: proxy },
    { method: 'POST', route: '/v1/local/config', body: { toJSON: getter } },
    { method: { toString: getter }, route: '/v1/local/config' },
  ])
    await assert.rejects(client(input), /invalid_http_request/);
  const proxiedFunction = new Proxy(() => {}, { apply: getter });
  assert.throws(
    () => createDaemonManagementHttpClient({ port: 15000, token: 'x'.repeat(32) }, proxiedFunction),
    /invalid_http_client/
  );
  assert.equal(hooks, 0);
  assert.equal(calls.length, 0);
});

test('successful health responses arriving at or after the deadline cannot pass', async () => {
  for (const elapsed of [2, 3]) {
    let time = 0;
    const { adapter } = fixture((owner) => {
      const original = owner.request;
      let saved = false;
      owner.request = async (input) => {
        const response = await original(input);
        if (input.method === 'POST') saved = true;
        if (saved && input.route.endsWith('/health')) time += elapsed;
        return response;
      };
    });
    adapter.now = () => time;
    const report = await runDaemonHttpSettingsMatrix(adapter, {
      mode: 'execute',
      timeoutMs: 2,
      pollMs: 1,
      maxPolls: 10,
    });
    assert.equal(report.cases[0].configSaved, true);
    assert.equal(report.cases[0].failure, 'application_timeout');
    assert.equal(report.cases[0].applicationObserved, false);
    assert.equal(report.cases[0].ownedStopAcknowledged, true);
  }
});

test('directory overlap is rejected and Windows casing cannot bypass health identity or reuse checks', async () => {
  for (const relationship of ['same', 'child', 'parent']) {
    const { adapter } = fixture((owner) => {
      if (relationship === 'same') owner.identity.runtimeDir = owner.identity.configDir;
      if (relationship === 'child')
        owner.identity.runtimeDir = path.join(owner.identity.configDir, 'nested');
      if (relationship === 'parent')
        owner.identity.runtimeDir = path.dirname(owner.identity.configDir);
    });
    const report = await runDaemonHttpSettingsMatrix(adapter, { mode: 'execute' });
    assert.equal(report.cases[0].failure, 'identity_mismatch');
    assert.equal(report.cases[0].configSaved, false);
  }
  if (process.platform === 'win32') {
    const { adapter } = fixture((owner) => {
      const original = owner.request;
      owner.request = async (input) => {
        const response = await original(input);
        if (input.route.endsWith('/health')) {
          for (const key of [
            'entrypoint',
            'cwd',
            'configDir',
            'runtimeDir',
            'contextRecoveryDirectory',
          ])
            response.body.runtime[key] = response.body.runtime[key].toUpperCase();
        }
        return response;
      };
    });
    assert.equal((await runDaemonHttpSettingsMatrix(adapter, { mode: 'execute' })).passed, true);
    let first;
    const reused = fixture((owner) => {
      first ??= owner.identity.configDir;
      owner.identity.configDir = first.toUpperCase();
    });
    const report = await runDaemonHttpSettingsMatrix(reused.adapter, { mode: 'execute' });
    assert.equal(report.cases[0].passed, true);
    assert.equal(report.cases[1].failure, 'identity_mismatch');
  }
});

test('restart retention claims cannot be promoted by a settings-only matrix', async () => {
  const { adapter } = fixture((owner) => {
    const original = owner.request;
    owner.request = async (input) => {
      const response = await original(input);
      if (input.route.endsWith('/health')) response.body.contextRecovery.restartRetention = true;
      return response;
    };
  });
  const report = await runDaemonHttpSettingsMatrix(adapter, { mode: 'execute' });
  assert.equal(report.cases[0].failure, 'identity_mismatch');
  assert.equal(report.cases[0].configSaved, false);
});

test('owned attestation receives the exact launched capability and refuses matching PID clones', async () => {
  for (const forge of [false, true]) {
    const owned = new WeakMap();
    let attestations = 0;
    const { adapter } = fixture();
    const launch = adapter.launch;
    adapter.launch = async (input) => {
      const rawOwner = await launch(input);
      owned.set(rawOwner, rawOwner.identity.pid);
      return forge ? { ...rawOwner, identity: { ...rawOwner.identity } } : rawOwner;
    };
    adapter.verifyOwnedIdentity = (owner) => {
      attestations++;
      return owned.has(owner) && owned.get(owner) === owner.identity.pid;
    };
    const report = await runDaemonHttpSettingsMatrix(adapter, { mode: 'execute' });
    assert.equal(report.passed, !forge);
    assert.equal(attestations, forge ? 1 : 4);
    if (forge) {
      assert.equal(report.cases[0].failure, 'identity_mismatch');
      assert.equal(report.cases[0].configSaved, false);
      assert.equal(report.cases[0].ownedStopAcknowledged, true);
    }
  }
});
