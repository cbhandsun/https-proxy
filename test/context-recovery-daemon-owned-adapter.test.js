'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
const testTempRoot = resolvePhysicalTestTempDirectory();
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { response } = require('../scripts/lib/context-recovery-daemon-owned-protocol');
const {
  CAUSES,
  PRELOAD_PHASES,
  ownedFailure,
  ownedDiagnostic,
} = require('../scripts/lib/context-recovery-daemon-owned-failure');
const {
  createDaemonOwnedAdapter,
} = require('../scripts/lib/context-recovery-daemon-owned-adapter');
const {
  startDaemonOwnedController,
} = require('../scripts/lib/context-recovery-daemon-owned-transport');
const {
  runDaemonHttpSettingsMatrix,
} = require('../scripts/lib/context-recovery-daemon-http-matrix');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(testTempRoot, 'hpm-daemon-owned-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const install = path.join(root, 'install');
  fs.mkdirSync(install);
  let current;
  let now = 0;
  const requests = [];
  const f = {
    root,
    install,
    requests,
    closed: false,
    alive: true,
    ready: true,
    statusFailure: false,
    stopFailure: false,
  };
  f.channel = {
    async exchange(request) {
      requests.push(request);
      if (request.op === 'start') {
        f.saved = { contextRecoveryEnabled: false, contextRecoveryPersistenceEnabled: false };
        f.revision = 'synthetic';
        const caseRoot = path.join(root, 'case-' + request.case);
        for (const name of ['config', 'runtime'])
          fs.mkdirSync(path.join(caseRoot, name), { recursive: true });
        current = {
          pid: 10,
          entrypoint: path.join(install, 'openai-proxy.js'),
          cwd: install,
          configDir: path.join(caseRoot, 'config'),
          runtimeDir: path.join(caseRoot, 'runtime'),
          managementPort: 15000 + requests.length,
          entryPort: 25000 + requests.length,
        };
        if (f.mutateIdentity) f.mutateIdentity(current);
        return {
          v: 1,
          id: requests.length,
          op: 'start',
          case: request.case,
          ok: true,
          identity: current,
        };
      }
      if (request.op === 'status') {
        if (f.statusFailure) throw new Error('PRIVATE_STATUS_ERROR');
        return {
          v: 1,
          id: requests.length,
          op: 'status',
          case: request.case,
          ok: true,
          alive: f.alive,
          credentialsPrivate: f.privateCredentials !== false,
          ...(f.preloadPhase === undefined ? {} : { preloadPhase: f.preloadPhase }),
        };
      }
      if (f.stopFailure) throw new Error('PRIVATE_STOP_ERROR');
      return {
        v: 1,
        id: requests.length,
        op: 'stop',
        case: request.case,
        ok: true,
        treeEmpty: true,
        cleanupSemantics: 'forced_cleanup',
      };
    },
    async close() {
      f.closed = true;
      return true;
    },
  };
  f.io = {
    now: () => now,
    wait: (ms) => {
      now += ms;
    },
    token: () => 'x'.repeat(32),
    client(options) {
      assert.equal(options.token, 'x'.repeat(32));
      return async (request) => {
        if (request.method === 'POST') {
          f.saved = request.body.appSettings;
          f.revision = 'saved';
          if (f.saved.contextRecoveryEnabled && f.saved.contextRecoveryPersistenceEnabled) {
            const storage = path.join(current.runtimeDir, 'context-recovery-v1');
            fs.mkdirSync(storage);
            for (const name of ['checkpoint.sqlite', '.writer.sqlite', '.data-key'])
              fs.writeFileSync(path.join(storage, name), '');
          }
          return { status: 200, body: { ok: true, revision: f.revision } };
        }
        if (request.route === '/v1/local/config')
          return {
            status: 200,
            body: {
              _revision: f.revision,
              appSettings: {
                ...f.saved,
                ...f.config,
              },
            },
          };
        if (!f.ready) throw new Error('PRIVATE_NOT_READY');
        const body = {
          ok: true,
          appId: 'https-proxy-manager',
          status: 'running',
          pid: current.pid,
          runtime: {
            ...current,
            contextRecoveryDirectory: path.join(current.runtimeDir, 'context-recovery-v1'),
          },
          ports: {
            management: current.managementPort,
            entries: [
              {
                host: '127.0.0.1',
                listenPort: current.entryPort,
                protocol: 'openai-responses',
                tls: false,
              },
            ],
          },
          contextRecovery: {
            configValid: true,
            requestedEnabled: f.saved.contextRecoveryEnabled,
            appliedEnabled: f.saved.contextRecoveryEnabled,
            state: f.saved.contextRecoveryEnabled ? 'enabled_restricted' : 'disabled',
            storage:
              f.saved.contextRecoveryEnabled && f.saved.contextRecoveryPersistenceEnabled
                ? 'persistent'
                : 'memory',
            restartRetention: false,
          },
        };
        if (f.mutateHealth) f.mutateHealth(body);
        return { status: 200, body };
      };
    },
  };
  f.adapter = createDaemonOwnedAdapter({ install, ownedRoot: root }, f.channel, f.io);
  f.launch = (label = '00') =>
    f.adapter.launch({ label, initialEnabled: false, initialPersistence: false });
  return f;
}

test('owned adapter connects four fresh identities and private tokens with only forced tree-empty stop acknowledgements', async (t) => {
  const f = fixture(t);
  for (const label of ['00', '01', '10', '11']) {
    const owner = await f.launch(label);
    assert.equal(f.adapter.verifyOwnedIdentity(owner), true);
    assert.equal(f.adapter.verifyOwnedIdentity({ ...owner }), false);
    assert.equal(await owner.isAlive(), true);
    assert.deepEqual(await owner.inspectStorage(), {
      allWithinRoot: true,
      directoryPresent: false,
      checkpointPresent: false,
      writerDatabasePresent: false,
      wrappedKeyPresent: false,
    });
    assert.equal(await owner.stop(), true);
    assert.equal(f.adapter.verifyOwnedIdentity(owner), false);
    assert.equal(await owner.isAlive(), false);
  }
  assert.equal(await f.adapter.close(), true);
  assert.equal(f.closed, true);
  assert.deepEqual(
    f.requests.filter((r) => r.op === 'start').map((r) => r.case),
    ['00', '01', '10', '11']
  );
  assert.equal(
    f.requests.some((r) => Object.keys(r).some((key) => ['command', 'path', 'pid'].includes(key))),
    false
  );
});

test('reviewed adapter composes with the unmodified matrix for all four offline HTTP and storage cases', async (t) => {
  const f = fixture(t);
  const result = await runDaemonHttpSettingsMatrix(f.adapter, { mode: 'execute' });
  assert.equal(result.passed, true);
  assert.equal(
    result.cases.every(
      (item) => !Object.hasOwn(item, 'cause') && !Object.hasOwn(item, 'cleanupCause')
    ),
    true
  );
  assert.deepEqual(
    result.cases.map((item) => item.label),
    ['00', '01', '10', '11']
  );
  assert.equal(
    result.cases.every(
      (item) =>
        item.ownedStopAcknowledged &&
        item.storageVerified &&
        item.cleanupSemantics === 'forced_cleanup'
    ),
    true
  );
  assert.equal(await f.adapter.close(), true);
});

test('readiness rejects wrong daemon identity, ports, baseline policy and saved config, and cleans the owner', async (t) => {
  const cases = [
    (f) => {
      f.mutateHealth = (body) => {
        body.pid++;
      };
    },
    (f) => {
      f.mutateHealth = (body) => {
        body.runtime.entrypoint += '.wrong';
      };
    },
    (f) => {
      f.mutateHealth = (body) => {
        body.ports.entries[0].listenPort++;
      };
    },
    (f) => {
      f.mutateHealth = (body) => {
        body.contextRecovery.appliedEnabled = true;
      };
    },
    (f) => {
      f.config = { contextRecoveryPersistenceEnabled: true };
    },
    (f) => {
      f.ready = false;
    },
    (f) => {
      f.alive = false;
    },
    (f) => {
      f.statusFailure = true;
    },
    (f) => {
      f.privateCredentials = false;
    },
    (f) => {
      f.mutateIdentity = (value) => {
        value.cwd = f.root;
      };
    },
    (f) => {
      f.mutateIdentity = (value) => {
        value.configDir = value.runtimeDir;
      };
    },
  ];
  for (const configure of cases) {
    const f = fixture(t);
    configure(f);
    await assert.rejects(f.launch(), /^Error: daemon_owned_adapter_failed$/);
    assert.equal(f.requests.at(-1).op, 'stop');
    const starts = f.requests.filter((r) => r.op === 'start').length;
    await assert.rejects(f.launch('01'));
    assert.equal(f.requests.filter((r) => r.op === 'start').length, starts);
    await f.adapter.close();
  }
});

test('cleanup failure closes controller, rejects launch, and prevents any subsequent start', async (t) => {
  const f = fixture(t);
  f.ready = false;
  f.stopFailure = true;
  await assert.rejects(f.launch());
  assert.equal(f.closed, true);
  const count = f.requests.length;
  await assert.rejects(f.launch('01'));
  assert.equal(f.requests.length, count);
});

test('close still closes controller stdin after stop rejection and reports cleanup failure', async (t) => {
  const f = fixture(t);
  const owner = await f.launch();
  f.stopFailure = true;
  await assert.rejects(owner.stop());
  await assert.rejects(f.adapter.close(), /^Error: daemon_owned_adapter_failed$/);
  assert.equal(f.closed, true);
  const starts = f.requests.filter((request) => request.op === 'start').length;
  await assert.rejects(f.launch('01'));
  assert.equal(f.requests.filter((request) => request.op === 'start').length, starts);
});

test('runtime storage inspection accepts only fixed ordinary files and detects moved owned directories', async (t) => {
  const f = fixture(t);
  const owner = await f.launch();
  const directory = path.join(owner.identity.runtimeDir, 'context-recovery-v1');
  fs.mkdirSync(directory);
  for (const name of ['checkpoint.sqlite', '.writer.sqlite', '.data-key'])
    fs.writeFileSync(path.join(directory, name), '');
  const storage = await owner.inspectStorage();
  assert.equal(
    Object.values(storage).every((value) => value === true),
    true
  );
  fs.writeFileSync(path.join(directory, 'unexpected'), 'PRIVATE_FILE');
  assert.throws(() => owner.inspectStorage());
  fs.unlinkSync(path.join(directory, 'unexpected'));
  const external = path.join(f.root, 'outside-recovery');
  fs.writeFileSync(external, 'PRIVATE_HARDLINK');
  fs.unlinkSync(path.join(directory, '.data-key'));
  fs.linkSync(external, path.join(directory, '.data-key'));
  assert.throws(() => owner.inspectStorage());
  fs.renameSync(owner.identity.runtimeDir, owner.identity.runtimeDir + '-moved');
  fs.mkdirSync(owner.identity.runtimeDir);
  assert.equal(f.adapter.verifyOwnedIdentity(owner), false);
  assert.throws(() => owner.inspectStorage());
  await f.adapter.close();
});

test('hostile input descriptors are never evaluated and invalid initial settings cause no start', async (t) => {
  const f = fixture(t);
  let accesses = 0;
  const input = { initialEnabled: false, initialPersistence: false };
  Object.defineProperty(input, 'label', {
    enumerable: true,
    get() {
      accesses++;
      throw new Error('PRIVATE_GETTER');
    },
  });
  await assert.rejects(f.adapter.launch(input));
  assert.equal(accesses, 0);
  assert.equal(f.requests.length, 0);
  await f.adapter.close();
  const g = fixture(t);
  await assert.rejects(
    g.adapter.launch({ label: '00', initialEnabled: true, initialPersistence: false })
  );
  assert.equal(g.requests.length, 0);
  await g.adapter.close();
});

test('strict response parser rejects duplicate/unknown keys, malformed UTF JSON, failed cleanup and oversized frames', () => {
  const request = { v: 1, id: 1, op: 'stop', case: '00' };
  const good = JSON.stringify({
    ...request,
    ok: true,
    treeEmpty: true,
    cleanupSemantics: 'forced_cleanup',
  });
  assert.equal(response(good, request).treeEmpty, true);
  for (const bad of [
    '',
    'null',
    '[]',
    good + '{}',
    good.replace('"id":1', '"id":1,"id":1'),
    good.replace('"ok":true', '"ok":true,"token":"PRIVATE_TOKEN"'),
    good.replace('"treeEmpty":true', '"treeEmpty":false'),
    good.replace('forced_cleanup', 'graceful'),
    ' '.repeat(16385),
    '\u00a0' + good,
    good.replace('"id":1', '"id":1e99'),
  ])
    assert.throws(() => response(bad, request), /^Error: daemon_protocol_rejected$/);
});

function fakeController() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const writes = [];
  child.stdin.on('data', (bytes) => writes.push(bytes.toString('utf8')));
  child.stdin.on('finish', () => {
    child.emit('close', 0, null);
  });
  return { child, writes };
}

function controllerOptions(t) {
  const directory = fs.mkdtempSync(path.join(testTempRoot, 'hpm-controller-wire-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'pwsh.exe');
  fs.writeFileSync(executable, '');
  const install = path.join(directory, 'install');
  fs.mkdirSync(install);
  return {
    ownedRoot: directory,
    install,
    powershellExecutable: executable,
    manifestSha256: 'a'.repeat(64),
  };
}

test('transport serializes fixed operations without argv secrets and validates fragmented stop ACK', async (t) => {
  const options = controllerOptions(t),
    f = fakeController();
  const channel = startDaemonOwnedController(options, (executable, args, settings) => {
    assert.equal(executable, options.powershellExecutable);
    assert.equal(args.includes('x'.repeat(32)), false);
    assert.equal(settings.shell, false);
    assert.equal(settings.env.NODE_OPTIONS, undefined);
    return f.child;
  });
  const pending = channel.exchange({ op: 'stop', case: '00' });
  const request = JSON.parse(f.writes[0]);
  const reply =
    JSON.stringify({ ...request, ok: true, treeEmpty: true, cleanupSemantics: 'forced_cleanup' }) +
    '\n';
  f.child.stdout.write(reply.slice(0, 7));
  f.child.stdout.write(reply.slice(7));
  assert.equal((await pending).treeEmpty, true);
  await assert.rejects(channel.exchange({ op: 'start', case: '00', token: 'bad' }));
  assert.equal(await channel.close(), true);
});

test('transport fails on unsolicited, oversized, duplicate, invalid UTF-8 and early controller-exit output', async (t) => {
  for (const mode of ['unsolicited', 'oversized', 'duplicate', 'utf8', 'exit', 'stderr']) {
    const f = fakeController();
    const channel = startDaemonOwnedController(controllerOptions(t), () => f.child);
    let pending;
    if (mode !== 'unsolicited') pending = channel.exchange({ op: 'status', case: '00' });
    const rejected = pending ? assert.rejects(pending, /^Error: daemon_controller_failed$/) : null;
    if (mode === 'exit') f.child.emit('close', 1, null);
    else if (mode === 'stderr') f.child.stderr.write(Buffer.alloc(4097));
    else if (mode === 'utf8') f.child.stdout.write(Buffer.from([255, 10]));
    else if (mode === 'oversized') f.child.stdout.write(Buffer.alloc(16386));
    else if (mode === 'duplicate') f.child.stdout.write('{"v":1,"v":1}\n');
    else f.child.stdout.write('{}\n');
    if (rejected) await rejected;
    await assert.rejects(channel.close(), /^Error: daemon_controller_failed$/);
  }
});

test('transport RPC deadline closes controller stdin and cannot return a false success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fakeController();
  const channel = startDaemonOwnedController(controllerOptions(t), () => f.child);
  const pending = channel.exchange({ op: 'status', case: '00' });
  const rejected = assert.rejects(pending, /^Error: daemon_controller_failed$/);
  t.mock.timers.tick(15000);
  await rejected;
  await assert.rejects(channel.close(), /^Error: daemon_controller_failed$/);
});

test('a controller that ignores stdin EOF cannot satisfy close acknowledgement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fakeController();
  f.child.stdin.removeAllListeners('finish');
  const channel = startDaemonOwnedController(controllerOptions(t), () => f.child);
  const pending = channel.close();
  const rejected = assert.rejects(pending, /^Error: daemon_controller_failed$/);
  t.mock.timers.tick(20000);
  await rejected;
  f.child.emit('close', 0, null);
});

test('failure diagnostics accept only closed enums and never inspect untrusted errors', () => {
  for (const cause of CAUSES) {
    const diagnostic = ownedDiagnostic(ownedFailure('daemon_controller_failed', cause));
    assert.deepEqual(diagnostic, { cause, cleanupCause: null });
    assert.equal(Object.isFrozen(diagnostic), true);
  }
  for (const bad of ['', null, undefined, 'PRIVATE_NATIVE_ERROR', {}, 'SETUP']) {
    assert.throws(() => ownedFailure('daemon_controller_failed', bad));
    if (bad !== undefined)
      assert.throws(() =>
        ownedFailure('daemon_controller_failed', 'setup', bad === null ? '' : bad)
      );
  }
  assert.throws(() => ownedFailure('PRIVATE_NATIVE_ERROR', 'setup'));
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('PRIVATE_GETTER');
      },
    }
  );
  for (const error of [hostile, { cause: 'setup' }, new Error('setup'), null, undefined])
    assert.equal(ownedDiagnostic(error), null);
});

test('failure response schema accepts only operation-specific causes and no native details', () => {
  for (const op of ['start', 'stop', 'status']) {
    const request = { v: 1, id: 1, op, case: '00' };
    for (const cause of [
      'setup',
      'process_start',
      'job_assign',
      'gate_release',
      'controller_cleanup',
      '',
      null,
      'PRIVATE_ERROR',
    ]) {
      const frame = { ...request, ok: false, cause };
      const valid =
        op === 'start'
          ? ['setup', 'process_start', 'job_assign', 'gate_release'].includes(cause)
          : op === 'stop' && cause === 'controller_cleanup';
      if (valid) assert.equal(response(JSON.stringify(frame), request).cause, cause);
      else assert.throws(() => response(JSON.stringify(frame), request));
      for (const extra of [{ error: 'PRIVATE_ERROR' }, { identity: {} }, { cleanupCause: null }])
        assert.throws(() => response(JSON.stringify({ ...frame, ...extra }), request));
      assert.throws(() =>
        response(JSON.stringify(frame).replace('"cause":', '"cause":"setup","cause":'), request)
      );
    }
  }
});

test('transport preserves verified controller stages while still allowing owned cleanup', async (t) => {
  for (const cause of ['setup', 'process_start', 'job_assign', 'gate_release']) {
    const f = fakeController();
    const channel = startDaemonOwnedController(controllerOptions(t), () => f.child);
    const pending = channel.exchange({ op: 'start', case: '00', token: 'x'.repeat(32) });
    const request = JSON.parse(f.writes[0]);
    delete request.token;
    f.child.stdout.write(JSON.stringify({ ...request, ok: false, cause }) + '\n');
    await assert.rejects(pending, (error) => ownedDiagnostic(error)?.cause === cause);
    const stopping = channel.exchange({ op: 'stop', case: '00' });
    f.child.stdout.write(
      JSON.stringify({
        ...JSON.parse(f.writes[1]),
        ok: true,
        treeEmpty: true,
        cleanupSemantics: 'forced_cleanup',
      }) + '\n'
    );
    assert.equal((await stopping).treeEmpty, true);
    assert.equal(await channel.close(), true);
  }
});

test('transport distinguishes protocol, pipe, exit and RPC deadline without raw error access', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const cause of [
    'controller_protocol',
    'controller_pipe',
    'controller_exit',
    'rpc_deadline',
  ]) {
    const f = fakeController();
    const channel = startDaemonOwnedController(controllerOptions(t), () => f.child);
    const pending = channel.exchange({ op: 'status', case: '00' });
    const rejected = assert.rejects(pending, (error) => {
      assert.deepEqual(ownedDiagnostic(error), { cause, cleanupCause: null });
      assert.equal(error.message, 'daemon_controller_failed');
      return true;
    });
    if (cause === 'controller_protocol') f.child.stdout.write('{}\n');
    else if (cause === 'controller_pipe')
      f.child.stdout.emit('error', new Error('PRIVATE_PIPE_ERROR'));
    else if (cause === 'controller_exit') f.child.emit('close', 1, null);
    else t.mock.timers.tick(15000);
    await rejected;
    await assert.rejects(channel.close(), (error) => ownedDiagnostic(error)?.cause === cause);
  }
});

test('matrix exposes attested launch cause, keeps cleanup separate and preserves legacy failure', async (t) => {
  const cases = [
    [
      'daemon_exited',
      (f) => {
        f.alive = false;
      },
    ],
    [
      'ready_health_rejected',
      (f) => {
        f.mutateHealth = (body) => {
          body.pid++;
        };
      },
    ],
    [
      'health_request_failed',
      (f) => {
        f.ready = false;
      },
    ],
    [
      'config_rejected',
      (f) => {
        f.config = { contextRecoveryPersistenceEnabled: true };
      },
    ],
    [
      'credentials_rejected',
      (f) => {
        f.privateCredentials = false;
      },
    ],
    [
      'status_rpc',
      (f) => {
        f.statusFailure = true;
      },
    ],
    [
      'identity_rejected',
      (f) => {
        f.mutateIdentity = (body) => {
          body.cwd = f.root;
        };
      },
    ],
  ];
  for (const [cause, configure] of cases) {
    for (const cleanupFailed of [false, true]) {
      const f = fixture(t);
      configure(f);
      f.stopFailure = cleanupFailed;
      const result = await runDaemonHttpSettingsMatrix(f.adapter, { mode: 'execute' });
      assert.equal(result.cases.length, 1);
      const item = result.cases[0];
      assert.equal(item.failure, 'launch_failed');
      assert.equal(item.cause, cause);
      assert.equal(item.cleanupCause, cleanupFailed ? 'stop_failed' : null);
      assert.deepEqual(Object.keys(item).sort(), [
        'applicationObserved',
        'cause',
        'cleanupCause',
        'cleanupSemantics',
        'configSaved',
        'failure',
        'label',
        'ownedStopAcknowledged',
        'passed',
        'storageVerified',
      ]);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|x{32}/);
      if (cleanupFailed) assert.equal(f.closed, true);
      else assert.equal(await f.adapter.close(), true);
    }
  }
});

test('adapter preserves signed RPC cause over cleanup cause and ignores forged error fields', async (t) => {
  for (const signed of [false, true]) {
    const f = fixture(t);
    const original = f.channel.exchange;
    f.channel.exchange = async (request) => {
      if (request.op === 'start')
        throw signed
          ? ownedFailure('daemon_controller_failed', 'job_assign')
          : { cause: 'job_assign', message: 'PRIVATE_ERROR' };
      return original(request);
    };
    f.adapter = createDaemonOwnedAdapter(
      { install: f.install, ownedRoot: f.root },
      f.channel,
      f.io
    );
    f.stopFailure = true;
    const result = await runDaemonHttpSettingsMatrix(f.adapter, { mode: 'execute' });
    assert.equal(result.cases[0].cause, signed ? 'job_assign' : 'start_rpc');
    assert.equal(result.cases[0].cleanupCause, 'stop_failed');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ERROR/);
  }
});

test('optional preload phase is a strict observed enum with legacy status compatibility', () => {
  const request = { v: 1, id: 1, op: 'status', case: '00' };
  const reply = { ...request, ok: true, alive: false, credentialsPrivate: false };
  assert.equal(Object.hasOwn(response(JSON.stringify(reply), request), 'preloadPhase'), false);
  for (const preloadPhase of PRELOAD_PHASES) {
    assert.equal(
      response(JSON.stringify({ ...reply, preloadPhase }), request).preloadPhase,
      preloadPhase
    );
    assert.equal(
      ownedDiagnostic(
        ownedFailure('daemon_owned_adapter_failed', 'daemon_exited', null, preloadPhase)
      ).preloadPhase,
      preloadPhase
    );
  }
  for (const preloadPhase of ['', null, {}, [], 0, 'not_entered', 'PRIVATE_STDERR']) {
    assert.throws(() => response(JSON.stringify({ ...reply, preloadPhase }), request));
    assert.throws(() =>
      ownedFailure('daemon_owned_adapter_failed', 'daemon_exited', null, preloadPhase)
    );
  }
  const good = JSON.stringify({ ...reply, preloadPhase: 'entered' });
  assert.throws(() =>
    response(good.replace('"preloadPhase":', '"preloadPhase":"passed","preloadPhase":'), request)
  );
  assert.throws(() =>
    response(
      JSON.stringify({ ...reply, preloadPhase: 'entered', stderr: 'PRIVATE_STDERR' }),
      request
    )
  );
});

test('daemon exit keeps its cause and exposes only the latest validated observed preload phase', async (t) => {
  for (const preloadPhase of PRELOAD_PHASES) {
    const f = fixture(t);
    f.alive = false;
    f.preloadPhase = preloadPhase;
    const result = await runDaemonHttpSettingsMatrix(f.adapter, { mode: 'execute' });
    const item = result.cases[0];
    assert.equal(item.failure, 'launch_failed');
    assert.equal(item.cause, 'daemon_exited');
    assert.equal(item.cleanupCause, null);
    assert.equal(item.preloadPhase, preloadPhase);
    assert.equal(await f.adapter.close(), true);
  }
  const f = fixture(t);
  f.preloadPhase = 'PRIVATE_STDERR';
  const result = await runDaemonHttpSettingsMatrix(f.adapter, { mode: 'execute' });
  assert.equal(result.cases[0].cause, 'status_rpc');
  assert.equal(Object.hasOwn(result.cases[0], 'preloadPhase'), false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_STDERR/);
  assert.equal(await f.adapter.close(), true);
});

test('startup protocols are snapshotted and the real health protocol must match each declared case', async (t) => {
  const f = fixture(t);
  const protocols = ['openai-responses', 'openai-responses', 'claude', 'claude'];
  const adapter = createDaemonOwnedAdapter(
    { install: f.install, ownedRoot: f.root, initialEntryProtocols: protocols },
    f.channel,
    f.io
  );
  protocols[2] = 'openai-responses';
  for (const [index, label] of ['00', '01', '10', '11'].entries()) {
    f.mutateHealth = (body) => {
      body.ports.entries[0].protocol = index < 2 ? 'openai-responses' : 'claude';
    };
    const owner = await adapter.launch({ label, initialEnabled: false, initialPersistence: false });
    assert.equal(adapter.verifyOwnedIdentity(owner), true);
    assert.equal(await owner.stop(), true);
  }
  assert.equal(await adapter.close(), true);
});

test('declared Claude startup cannot be acknowledged by a Responses listener or an invalid protocol plan', async (t) => {
  const f = fixture(t);
  const adapter = createDaemonOwnedAdapter(
    {
      install: f.install,
      ownedRoot: f.root,
      initialEntryProtocols: ['claude', 'claude', 'claude', 'claude'],
    },
    f.channel,
    f.io
  );
  await assert.rejects(
    adapter.launch({ label: '00', initialEnabled: false, initialPersistence: false })
  );
  assert.equal(f.requests.at(-1).op, 'stop');
  assert.equal(await adapter.close(), true);
  const {
    parseOwnedStartupProtocols,
  } = require('../scripts/lib/context-recovery-daemon-owned-startup');
  assert.deepEqual(parseOwnedStartupProtocols(undefined), Array(4).fill('openai-responses'));
  assert.equal(
    Object.isFrozen(parseOwnedStartupProtocols(['claude', 'claude', 'claude', 'claude'])),
    true
  );
  for (const value of [
    null,
    {},
    [],
    ['claude'],
    Array(5).fill('claude'),
    ['claude', 'claude', 'claude', 'invalid'],
    Array(20001).fill('claude'),
  ])
    assert.throws(() => parseOwnedStartupProtocols(value), {
      message: 'daemon_owned_adapter_failed',
    });
  let touched = false;
  const hostile = ['claude', 'claude', 'claude', 'claude'];
  Object.defineProperty(hostile, '0', {
    enumerable: true,
    get() {
      touched = true;
      return 'claude';
    },
  });
  assert.throws(() => parseOwnedStartupProtocols(hostile));
  assert.throws(() =>
    parseOwnedStartupProtocols(
      new Proxy([], {
        get() {
          touched = true;
          return 4;
        },
      })
    )
  );
  assert.equal(touched, false);
});
