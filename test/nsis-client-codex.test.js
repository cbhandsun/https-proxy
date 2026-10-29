'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
const {
  createCodexSyntheticSource,
  runInstalledCodexCase,
} = require('../scripts/lib/nsis-client-codex');
const nonce = 'a'.repeat(32);
const failure = { message: 'nsis_client_codex_failed', code: 'nsis_client_codex_failed' };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const {
  createOwnedStopFailure,
  ownedStopFailure,
} = require('../scripts/lib/nsis-client-owned-failure');

function fixture(t, fault, mode = 'enhanced') {
  const root = fs.mkdtempSync(path.join(resolvePhysicalTestTempDirectory(), 'codex-protocol-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let child = new EventEmitter();
  for (const name of ['stdin', 'stdout', 'stderr']) child[name] = new PassThrough();
  const sent = [],
    progress = [];
  let stops = 0,
    launches = 0,
    turns = 0,
    compacts = 0,
    launch;
  const emit = (value) => child.stdout.write(JSON.stringify(value) + '\n');
  const done = (turnId, items = []) =>
    emit({
      method: 'turn/completed',
      params: {
        threadId: fault === 'wrong-thread' ? 'foreign-thread' : 'thread-1',
        turn: { id: turnId, status: fault === 'failed-turn' ? 'failed' : 'completed', items },
      },
    });
  child.stdin.on('data', (bytes) => {
    const request = JSON.parse(bytes.toString());
    sent.push(request);
    if (fault === 'malformed-rpc') return child.stdout.write('PRIVATE malformed token\n');
    if (fault === 'process-exit') return child.emit('exit', 1);
    if (fault === 'stream-error')
      return child.stdout.emit('error', new Error('PRIVATE stream error'));
    if (request.method === 'initialize') return emit({ id: request.id, result: {} });
    if (request.method === 'thread/start')
      return emit({
        id: request.id,
        result: {
          thread: {
            id: 'thread-1',
            ephemeral: fault === 'restart-ephemeral' ? true : request.params.ephemeral,
          },
        },
      });
    if (request.method === 'thread/resume') {
      if (fault === 'resume-error')
        return emit({ id: request.id, error: { code: -1, message: 'PRIVATE' } });
      return emit({
        id: request.id,
        result: {
          thread: {
            id: fault === 'resume-wrong-id' ? 'foreign' : 'thread-1',
            ephemeral: fault === 'resume-ephemeral',
          },
        },
      });
    }
    if (request.method === 'turn/start') {
      const turnId = 'turn-' + ++turns;
      emit({
        id: request.id,
        result: { turn: { id: fault === 'wrong-turn' ? 'foreign-turn' : turnId } },
      });
      if (turns === 1) {
        if (fault === 'missing-source') return done(turnId);
        return emit({
          id: 1000,
          method: fault === 'unknown-request' ? 'unsafe/request' : 'item/tool/call',
          params: {
            threadId: 'thread-1',
            turnId,
            callId: 'source-call',
            namespace: null,
            tool: fault === 'wrong-tool' ? 'shell' : 'hpm_fixture_original',
            arguments: fault === 'nonempty-arguments' ? '{"path":"PRIVATE"}' : '{}',
          },
        });
      }
      const items = [
        {
          type: 'agentMessage',
          text:
            fault === 'wrong-answer'
              ? 'PRIVATE wrong answer'
              : mode === 'default'
                ? 'DONE'
                : createCodexSyntheticSource(nonce).marker,
        },
      ];
      if (fault === 'extra-answer') items.push({ type: 'agentMessage', text: 'WRONG EXTRA' });
      if (fault === 'extra-original')
        items.push({ type: 'agentMessage', text: createCodexSyntheticSource(nonce).text });
      if (fault === 'invalid-public-text') items.push({ type: 'agentMessage', text: null });
      if (fault === 'unknown-public-item') items.push({ type: 'plan', text: 'EXTRA PUBLIC' });
      if (fault === 'nonpublic-reasoning') items.push({ type: 'reasoning', summary: [] });
      return done(turnId, items);
    }
    if (request.id === 1000 && request.result) {
      if (fault === 'duplicate-source')
        return emit({
          id: 1001,
          method: 'item/tool/call',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            callId: 'source-call-again',
            tool: 'hpm_fixture_original',
            arguments: '{}',
          },
        });
      return done('turn-1');
    }
    if (request.method === 'thread/compact/start') {
      compacts++;
      const turnId = 'compact-turn-' + compacts;
      emit({ id: request.id, result: {} });
      const notification = {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          item: { type: 'contextCompaction', id: 'compact-' + compacts },
        },
      };
      if (fault !== 'missing-compaction') emit(notification);
      if (fault === 'duplicate-compaction') emit(notification);
      if (fault === 'private-leak')
        emit({
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            item: {
              type: 'agentMessage',
              text: 'private-thinking-sentinel hpm_read_retained_evidence',
            },
          },
        });
      return done(turnId);
    }
  });
  const options = {
    caseRoot: root,
    mode,
    entryUrl: 'http://127.0.0.1:49301/v1',
    model: 'gpt-6.1-sol',
    entryToken: 'synthetic_' + 't'.repeat(32),
    sourceTool: { nonce },
    onProgress(event) {
      progress.push(event);
    },
    spawnOwned(input) {
      launches++;
      launch = input;
      if (fault === 'spawn-failed' || (fault === 'restart-spawn-failed' && launches === 2))
        throw new Error('PRIVATE executable path');
      if (launches === 2) {
        assert.equal(stops, 1);
        const receive = child.stdin.listeners('data')[0];
        child = new EventEmitter();
        for (const name of ['stdin', 'stdout', 'stderr']) child[name] = new PassThrough();
        child.stdin.on('data', receive);
      }
      const launchIndex = launches;
      return {
        child,
        async stop() {
          stops++;
          if (
            fault === 'stop-throw' ||
            (fault === 'first-stop-failed' && launchIndex === 1) ||
            (fault === 'second-stop-failed' && launchIndex === 2)
          )
            throw new Error('PRIVATE stop path');
          return { terminal: fault !== 'stop-terminal', treeStopped: fault !== 'stop-tree' };
        },
      };
    },
  };
  return {
    options,
    root,
    child,
    sent,
    progress,
    stops: () => stops,
    launches: () => launches,
    launch: () => launch,
  };
}

test('Codex restart distinguishes invalid stop proof, case mutation and unexpected RPC during stop without accepting any', async (t) => {
  for (const kind of ['receipt', 'case_identity', 'rpc']) {
    const f = fixture(t);
    const spawn = f.options.spawnOwned;
    await assert.rejects(
      runInstalledCodexCase({
        ...f.options,
        restartClient: true,
        async spawnOwned(input) {
          const handle = await spawn(input);
          return {
            child: handle.child,
            async stop() {
              const stopped = await handle.stop();
              if (kind === 'rpc') handle.child.stdout.write('PRIVATE malformed RPC\n');
              if (kind === 'case_identity') fs.rmSync(f.root, { recursive: true, force: true });
              return kind === 'receipt' ? { terminal: true, treeStopped: false } : stopped;
            },
          };
        },
      }),
      (error) => {
        assert.equal(ownedStopFailure(error), 'nsis_owned_stop_' + kind);
        return true;
      }
    );
    assert.equal(f.launches(), 1);
    assert.equal(f.stops(), 1);
    assert.equal(f.progress.at(-1).phase, 'restart-stop');
  }
});

test('Codex restart preserves attested stop failures without launching a successor or disclosing exception fields', async (t) => {
  for (const attested of [true, false]) {
    const f = fixture(t);
    const spawn = f.options.spawnOwned;
    const code = 'nsis_owned_stop_controller_natural_exit_timeout';
    const cause = attested
      ? createOwnedStopFailure(code)
      : Object.assign(new Error('PRIVATE'), { code });
    await assert.rejects(
      runInstalledCodexCase({
        ...f.options,
        restartClient: true,
        async spawnOwned(input) {
          const handle = await spawn(input);
          return {
            child: handle.child,
            async stop() {
              await handle.stop();
              throw cause;
            },
          };
        },
      }),
      (error) => {
        assert.equal(error.message, failure.message);
        assert.equal(error.code, failure.code);
        assert.equal(ownedStopFailure(error), attested ? code : null);
        return true;
      }
    );
    assert.equal(f.launches(), 1);
    assert.equal(f.stops(), 1);
    assert.equal(f.progress.at(-1).phase, 'restart-stop');
  }
});

for (const mode of ['default', 'enhanced'])
  test(
    'Codex ' + mode + ' uses real RPC framing, three compactions and owned terminal cleanup',
    async (t) => {
      const f = fixture(t, null, mode),
        result = await runInstalledCodexCase(f.options);
      assert.equal(result.sourceCalls, 1);
      assert.equal(result.compactions, 3);
      assert.equal(result.compactionItems, 3);
      assert.equal(result.completedTurns, 5);
      assert.equal(result.processTerminal, true);
      assert.equal(result.ownedTreeStopped, true);
      assert.equal(result.installedRuntimeQualified, false);
      assert.equal(result.upstreamRecoveryQualified, false);
      assert.equal(result.directModelRequests, 0);
      assert.equal(Object.hasOwn(result, 'modelRequests'), false);
      assert.equal(f.stops(), 1);
      assert.deepEqual(
        f.progress,
        ['seed', 'compact-1', 'compact-2', 'compact-3', 'final'].map((phase) => ({ phase }))
      );
      const wire = f.sent.find((item) => item.id === 1000 && item.result).result;
      assert.equal(wire.contentItems[0].text, createCodexSyntheticSource(nonce).text);
      const launch = f.launch();
      assert.equal(Object.hasOwn(launch, 'executable'), false);
      assert.equal(launch.cwd, f.root);
      assert.equal(launch.env.CODEX_HOME, path.join(f.root, 'home'));
      for (const name of [
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
        'NODE_OPTIONS',
        'NODE_PATH',
        'PROXY_CONFIG_DIR',
      ])
        assert.equal(Object.hasOwn(launch.env, name), false);
      const configuration = Object.fromEntries(
        launch.args
          .slice(3)
          .filter((_, index) => index % 2 === 1)
          .map((item) => {
            const split = item.indexOf('=');
            return [item.slice(0, split), JSON.parse(item.slice(split + 1))];
          })
      );
      assert.equal(configuration['model_providers.hpm-nsis-synthetic.request_max_retries'], 0);
      assert.equal(configuration['model_providers.hpm-nsis-synthetic.stream_max_retries'], 0);
      assert.equal(configuration['model_providers.hpm-nsis-synthetic.requires_openai_auth'], false);
      assert.deepEqual(configuration.mcp_servers, {});
      const json = JSON.stringify(result);
      for (const value of [
        f.options.entryToken,
        f.root,
        createCodexSyntheticSource(nonce).text,
        nonce,
      ])
        assert.equal(json.includes(value), false);
    }
  );

test('Codex malformed or disallowed input fails before filesystem writes or process creation', async (t) => {
  for (const change of [
    { mode: 'real' },
    { entryUrl: 'https://127.0.0.1:49301/v1' },
    { entryUrl: 'http://api.openai.com:49301/v1' },
    { entryUrl: 'http://127.0.0.1/v1' },
    { entryUrl: 'http://localhost:80/v1' },
    { entryUrl: 'http://localhost:65536/v1' },
    { entryUrl: 'http://user@127.0.0.1:49301/v1' },
    { entryUrl: 'http://127.0.0.1:49301/v1?x=1' },
    { entryUrl: 'http://127.0.0.1:49301/v1#x' },
    { entryUrl: 'http://127.0.0.1:49301/../v1' },
    { model: '' },
    { model: 'x'.repeat(129) },
    { entryToken: 'PRIVATE\n' },
    { sourceTool: { nonce: 'x'.repeat(32) } },
    { sourceTool: { nonce, text: 'private' } },
    { unknown: true },
  ]) {
    const f = fixture(t);
    await assert.rejects(runInstalledCodexCase({ ...f.options, ...change }), failure);
    assert.equal(f.launches(), 0);
    assert.deepEqual(fs.readdirSync(f.root), []);
  }
  let getters = 0;
  const f = fixture(t),
    input = { ...f.options };
  Object.defineProperty(input, 'entryToken', {
    enumerable: true,
    get() {
      getters++;
      return 'PRIVATE';
    },
  });
  await assert.rejects(runInstalledCodexCase(input), failure);
  await assert.rejects(
    runInstalledCodexCase(
      new Proxy(
        {},
        {
          get() {
            getters++;
            throw new Error('private');
          },
        }
      )
    ),
    failure
  );
  assert.equal(getters, 0);
});

test('Codex protocol failures stop the owned process exactly once with no retries or raw error data', async (t) => {
  for (const fault of [
    'malformed-rpc',
    'process-exit',
    'stream-error',
    'wrong-thread',
    'wrong-turn',
    'failed-turn',
    'missing-source',
    'unknown-request',
    'wrong-tool',
    'nonempty-arguments',
    'duplicate-source',
    'missing-compaction',
    'duplicate-compaction',
    'private-leak',
    'wrong-answer',
    'extra-answer',
    'extra-original',
    'invalid-public-text',
    'unknown-public-item',
    'stop-throw',
    'stop-terminal',
    'stop-tree',
  ]) {
    const f = fixture(t, fault);
    await assert.rejects(runInstalledCodexCase(f.options), failure, fault);
    assert.equal(f.launches(), 1, fault);
    assert.equal(f.stops(), 1, fault);
  }
  const f = fixture(t, 'spawn-failed');
  await assert.rejects(runInstalledCodexCase(f.options), failure);
  assert.equal(f.launches(), 1);
  assert.equal(f.stops(), 0); // spawnOwned owns cleanup before returning a handle.
});

test('Codex awaits tree cleanup and does not accept an asynchronous progress observer', async (t) => {
  const f = fixture(t),
    spawn = f.options.spawnOwned;
  let release,
    settled = false;
  f.options.spawnOwned = (input) => {
    const handle = spawn(input);
    return {
      child: handle.child,
      stop: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    };
  };
  const result = runInstalledCodexCase(f.options).then((receipt) => {
    settled = true;
    return receipt;
  });
  await tick();
  assert.equal(typeof release, 'function');
  assert.equal(settled, false);
  release({ terminal: true, treeStopped: true });
  assert.equal((await result).processTerminal, true);
  const invalid = fixture(t);
  invalid.options.onProgress = async () => {};
  await assert.rejects(runInstalledCodexCase(invalid.options), failure);
  assert.equal(invalid.stops(), 1);
  assert.equal(invalid.sent.filter((item) => item.method === 'turn/start').length, 0);
});

test('synthetic source is bounded and deterministic with exact Unicode/CRLF and no caller supplied payload', () => {
  const first = createCodexSyntheticSource(nonce);
  assert.deepEqual(first, createCodexSyntheticSource(nonce));
  assert.ok(first.text.includes('中文🙂\r\n'));
  assert.ok(first.text.endsWith('REQUIRED_MARKER=' + first.marker));
  assert.ok(Buffer.byteLength(first.text) < 10000);
  for (const value of [null, {}, '', 'f'.repeat(31), 'f'.repeat(33), 'A'.repeat(32)])
    assert.throws(() => createCodexSyntheticSource(value), failure);
});

test('Codex loopback aliases stay explicit and preexisting or replaced case roots fail closed', async (t) => {
  const alias = fixture(t);
  alias.options.entryUrl = 'http://localhost:49301/v1/';
  await runInstalledCodexCase(alias.options);
  const occupied = fixture(t);
  fs.writeFileSync(path.join(occupied.root, 'sentinel'), 'unchanged');
  await assert.rejects(runInstalledCodexCase(occupied.options), failure);
  assert.equal(occupied.launches(), 0);
  assert.equal(fs.readFileSync(path.join(occupied.root, 'sentinel'), 'utf8'), 'unchanged');
  const replaced = fixture(t),
    spawn = replaced.options.spawnOwned;
  replaced.options.spawnOwned = (input) => {
    const handle = spawn(input);
    return {
      child: handle.child,
      async stop() {
        fs.renameSync(path.join(replaced.root, 'home'), path.join(replaced.root, 'old-home'));
        fs.mkdirSync(path.join(replaced.root, 'home'));
        return handle.stop();
      },
    };
  };
  await assert.rejects(runInstalledCodexCase(replaced.options), failure);
  assert.equal(replaced.stops(), 1);
});

test('Codex continues inspecting private wire and framing until the owned tree is actually stopped', async (t) => {
  for (const fault of ['late-private', 'late-malformed', 'clean-exit']) {
    const f = fixture(t),
      spawn = f.options.spawnOwned;
    f.options.spawnOwned = (input) => {
      const handle = spawn(input);
      return {
        child: handle.child,
        async stop() {
          if (fault === 'late-private')
            f.child.stdout.write(
              JSON.stringify({
                method: 'item/completed',
                params: {
                  threadId: 'thread-1',
                  item: { type: 'agentMessage', text: 'hpm_list_retained_evidence PRIVATE' },
                },
              }) + '\n'
            );
          if (fault === 'late-malformed') f.child.stdout.write('PRIVATE malformed\n');
          if (fault === 'clean-exit') f.child.emit('exit', 0);
          return handle.stop();
        },
      };
    };
    if (fault === 'clean-exit')
      assert.equal((await runInstalledCodexCase(f.options)).processTerminal, true);
    else await assert.rejects(runInstalledCodexCase(f.options), failure);
    assert.equal(f.stops(), 1);
  }
});

test('Codex final output ignores only explicitly nonpublic reasoning items', async (t) => {
  const f = fixture(t, 'nonpublic-reasoning');
  assert.equal((await runInstalledCodexCase(f.options)).exactFinalAnswer, true);
});

test('Codex restart resumes only a disk-backed thread ID after stopping the first process, retaining the original workload', async (t) => {
  for (const mode of ['default', 'enhanced']) {
    const f = fixture(t, undefined, mode);
    const result = await runInstalledCodexCase({ ...f.options, restartClient: true });
    assert.equal(f.launches(), 2);
    assert.equal(f.stops(), 2);
    assert.equal(result.clientRestarted, true);
    assert.equal(result.persistedThreadResumed, true);
    assert.equal(result.ownedLaunches, 2);
    assert.equal(result.compactions, 3);
    assert.equal(result.sourceCalls, 1);
    assert.equal(result.completedTurns, 5);
    const starts = f.sent.filter((x) => x.method === 'thread/start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].params.ephemeral, false);
    assert.deepEqual(
      f.sent.filter((x) => x.method === 'thread/resume').map((x) => x.params),
      [{ threadId: 'thread-1' }]
    );
    assert.equal(f.sent.filter((x) => x.method === 'initialize').length, 2);
    assert.deepEqual(
      f.progress.map((event) => event.phase),
      [
        'seed',
        'compact-1',
        'compact-2',
        'compact-3',
        'restart-stop',
        'restart-initialize',
        'restart-resume',
        'final',
      ]
    );
  }
});

test('Codex restart progress identifies the failing owned lifecycle boundary', async (t) => {
  for (const [fault, phase] of [
    ['first-stop-failed', 'restart-stop'],
    ['restart-spawn-failed', 'restart-initialize'],
    ['resume-error', 'restart-resume'],
  ]) {
    await t.test(fault, async (t) => {
      const f = fixture(t, fault);
      await assert.rejects(runInstalledCodexCase({ ...f.options, restartClient: true }), failure);
      assert.equal(f.progress.at(-1).phase, phase);
      assert.equal(
        f.progress.some((event) => event.phase === 'final'),
        false
      );
      assert.ok(f.launches() <= 2);
      assert.ok(f.stops() <= 2);
    });
  }
});

test('Codex restart progress failure retains ownership of every live CLI for cleanup', async (t) => {
  for (const [phase, launches] of [
    ['restart-stop', 1],
    ['restart-initialize', 1],
    ['restart-resume', 2],
  ]) {
    const f = fixture(t);
    const observed = f.options.onProgress;
    f.options.onProgress = (event) => {
      observed(event);
      if (event.phase === phase) throw Error('PRIVATE_PROGRESS_FAILURE');
    };
    await assert.rejects(runInstalledCodexCase({ ...f.options, restartClient: true }), failure);
    assert.equal(f.launches(), launches);
    assert.equal(f.stops(), launches);
    assert.equal(f.sent.filter((message) => message.method === 'turn/start').length, 1);
  }
});

test('Codex restart refuses invalid opt-in values and failed, ephemeral or substituted resume state without retry', async (t) => {
  for (const restartClient of [false, null, 0, '', 'true', {}, []]) {
    const f = fixture(t);
    await assert.rejects(runInstalledCodexCase({ ...f.options, restartClient }), failure);
    assert.equal(f.launches(), 0);
  }
  for (const fault of [
    'restart-ephemeral',
    'first-stop-failed',
    'restart-spawn-failed',
    'resume-wrong-id',
    'resume-ephemeral',
    'resume-error',
    'second-stop-failed',
  ]) {
    const f = fixture(t, fault);
    await assert.rejects(runInstalledCodexCase({ ...f.options, restartClient: true }), failure);
    assert.ok(f.launches() <= 2);
    assert.ok(f.stops() <= 2);
    assert.ok(f.sent.filter((x) => x.method === 'thread/resume').length <= 1);
    assert.equal(f.sent.filter((x) => x.method === 'thread/start').length, 1);
  }
});
