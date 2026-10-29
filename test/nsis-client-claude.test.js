'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runInstalledClaudeCase, loopbackUrl } = require('../scripts/lib/nsis-client-claude');
const {
  createSourceHandler,
  endpoint,
  fetchOriginal,
  boundedLines,
} = require('../scripts/lib/nsis-client-source.cjs');
const http = require('node:http');

function fixture(t, mode = 'default', mutation = () => {}) {
  const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-claude-unit-'));
  t.after(() => fs.rmSync(caseRoot, { recursive: true, force: true }));
  const marker = 'HPM_PRIVATE_0123456789abcdef';
  const phases = [],
    launches = [];
  let stops = 0,
    stopFailureAt;
  const sessionId = '12345678-1234-4234-9234-123456789abc';
  const witness = {
    sourceCalls: 1,
    classifiedCompactions: 3,
    allRequestsStreaming: true,
    fullCoreEntrypointVerified: true,
    defaultZeroRecovery: true,
    requestCount: 8,
    exactPrivateRead: true,
    independentPublicGeneration: true,
    exactAuthorizedEvidenceInPublicRequest: true,
  };
  const options = {
    caseRoot,
    mode,
    entryUrl: 'http://127.0.0.1:5555',
    sourceUrl: 'http://127.0.0.1:5556/source',
    model: 'synthetic-claude',
    entryToken: 'hpm-synthetic-0123456789abcdef',
    marker,
    cliPath: path.join(caseRoot, 'claude.exe'),
    nodePath: process.execPath,
    sourceTool: path.resolve(__dirname, '../scripts/lib/nsis-client-source.cjs'),
    onProgress: ({ phase }) => phases.push(phase),
    inspectWitness: () => witness,
    spawnOwned: (launch) => {
      const { args } = launch;
      launches.push(launch);
      const launchIndex = launches.length;
      if (launchIndex === 2) {
        assert.equal(stops, 1);
        assert.equal(args.at(-2), '--resume');
        assert.equal(args.at(-1), sessionId);
      }
      let initialized = false;
      assert.ok(args.includes('--bare'));
      assert.equal(args[args.indexOf('--setting-sources') + 1], '');
      assert.ok(args.includes('--strict-mcp-config'));
      assert.equal(args.includes('--no-session-persistence'), !options.restartClient);
      assert.equal(launch.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(launch.env.CLAUDE_CONFIG_DIR, path.join(caseRoot, 'home', 'claude'));
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({
        write(chunk, _encoding, done) {
          const request = JSON.parse(chunk.toString());
          assert.equal(request.session_id, '');
          const phase = phases.at(-1);
          const events = [];
          if (options.restartClient && !initialized) {
            initialized = true;
            events.push({ type: 'system', subtype: 'init', session_id: sessionId });
          }
          if (request.message.content === '/compact')
            events.push({ type: 'system', subtype: 'compact_boundary' });
          events.push({
            type: 'result',
            is_error: false,
            ...(options.restartClient ? { session_id: sessionId } : {}),
            result: phase === 'final' ? (mode === 'default' ? 'DONE' : marker) : 'READY',
          });
          mutation(events, phase, witness, launchIndex);
          queueMicrotask(() => {
            for (const event of events) child.stdout.write(JSON.stringify(event) + '\n');
          });
          done();
        },
      });
      return {
        child,
        stop: async () => {
          stops++;
          if (stops === stopFailureAt) throw Error('PRIVATE');
          return { terminal: true, treeStopped: true };
        },
      };
    },
  };
  return {
    options,
    phases,
    witness,
    launches,
    sessionId,
    stops: () => stops,
    failStopAt: (index) => {
      stopFailureAt = index;
    },
  };
}

for (const mode of ['default', 'enhanced'])
  test('Claude isolated stream protocol ' + mode, async (t) => {
    const { options, phases } = fixture(t, mode);
    const result = await runInstalledClaudeCase(options);
    assert.equal(result.protocolPassed, true);
    assert.equal(result.installedClientQualified, false);
    assert.deepEqual(phases, [
      'seed',
      'compact-1',
      'between-1',
      'compact-2',
      'between-2',
      'compact-3',
      'final',
    ]);
    assert.equal(JSON.stringify(result).includes(options.marker), false);
  });

for (const [name, mutate, code] of [
  [
    'missing boundary',
    (events, phase) => {
      if (phase === 'compact-1') events.shift();
    },
    'claude_compaction_invalid',
  ],
  [
    'duplicate boundary',
    (events, phase) => {
      if (phase === 'compact-1') events.unshift(events[0]);
    },
    'claude_compaction_invalid',
  ],
  [
    'private wire',
    (events) => {
      events.push({ type: 'assistant', content: 'hpm_read_retained_evidence' });
    },
    'claude_private_wire_leak',
  ],
  [
    'error result',
    (events) => {
      events.at(-1).is_error = true;
    },
    'claude_result_invalid',
  ],
  [
    'wrong final',
    (events, phase) => {
      if (phase === 'final') events.at(-1).result = 'wrong';
    },
    'claude_final_mismatch',
  ],
  [
    'bad witness',
    (_events, _phase, witness) => {
      witness.allRequestsStreaming = false;
    },
    'claude_witness_invalid',
  ],
])
  test('Claude rejects ' + name, async (t) => {
    const { options } = fixture(t, 'enhanced', mutate);
    await assert.rejects(runInstalledClaudeCase(options), { message: code });
  });

test('Claude rejects unsafe options before spawn', async (t) => {
  const { options } = fixture(t);
  for (const value of [
    '',
    'https://127.0.0.1:80',
    'http://localhost:80',
    'http://127.0.0.1',
    'http://u:p@127.0.0.1:80',
    'http://127.0.0.1:80/?x=1',
    'http://127.0.0.1:80/#x',
  ]) {
    assert.throws(() => loopbackUrl(value), { message: 'claude_case_invalid' });
    assert.throws(() => endpoint(value), { message: 'source_config_invalid' });
  }
  await assert.rejects(runInstalledClaudeCase({ ...options, entryToken: 'real-secret' }), {
    message: 'claude_case_invalid',
  });
  await assert.rejects(
    runInstalledClaudeCase({
      ...options,
      get marker() {
        throw new Error('must_not_read');
      },
    }),
    { message: 'claude_case_invalid' }
  );
});

test('synthetic source protocol validates arguments and consumes at most once', async () => {
  let calls = 0;
  const handler = createSourceHandler('http://127.0.0.1:1234/source', async () => {
    calls++;
    return 'synthetic';
  });
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'original', arguments: {} },
  };
  for (const args of [null, [], '', { injected: true }]) {
    await assert.rejects(handler({ ...request, params: { name: 'original', arguments: args } }), {
      message: 'source_request_invalid',
    });
  }
  assert.equal((await handler({ ...request, method: 'tools/list' })).tools[0].name, 'original');
  assert.equal((await handler(request)).content[0].text, 'synthetic');
  await assert.rejects(handler(request), { message: 'source_request_invalid' });
  assert.equal(calls, 1);
});

test('synthetic source failure does not permit a second fetch', async () => {
  const handler = createSourceHandler('http://127.0.0.1:1234', async () => {
    throw new Error('source_failed');
  });
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'original', arguments: {} },
  };
  await assert.rejects(handler(request), { message: 'source_failed' });
  await assert.rejects(handler(request), { message: 'source_request_invalid' });
});

test('synthetic HTTP source accepts fixed original and rejects unsafe payloads and status', async (t) => {
  let body =
    'Synthetic original Unicode 中文🙂\r\nonly synthetic content\r\nREQUIRED_MARKER=HPM_PRIVATE_0123456789abcdef';
  let status = 200;
  const server = http.createServer((request, response) => {
    assert.equal(request.method, 'POST');
    let input = '';
    request.on('data', (chunk) => {
      input += chunk;
    });
    request.on('end', () => {
      assert.equal(input, '{}');
      response.writeHead(status);
      response.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = endpoint('http://127.0.0.1:' + server.address().port + '/source');
  assert.equal(await fetchOriginal(url), body);
  for (const invalid of [
    '',
    'unexpected original',
    'x'.repeat(128 * 1024 + 1),
    Buffer.concat([
      Buffer.from('Synthetic original Unicode 中文🙂\r\n'),
      Buffer.from([255]),
      Buffer.from('\r\nREQUIRED_MARKER=HPM_PRIVATE_0123456789abcdef'),
    ]),
  ]) {
    body = invalid;
    await assert.rejects(fetchOriginal(url), { message: 'source_failed' });
  }
  status = 302;
  await assert.rejects(fetchOriginal(url), { message: 'source_failed' });
});

test('Claude awaits owned termination on success and protocol failure', async (t) => {
  for (const broken of [false, true]) {
    const { options } = fixture(t, 'default', (events) => {
      if (broken) events.at(-1).is_error = true;
    });
    const launch = options.spawnOwned;
    let stopped = false;
    options.spawnOwned = async (request) => {
      const owned = launch(request);
      return {
        child: owned.child,
        stop: async () => {
          await new Promise((resolve) => setImmediate(resolve));
          stopped = true;
          return { terminal: true, treeStopped: true };
        },
      };
    };
    if (broken)
      await assert.rejects(runInstalledClaudeCase(options), { message: 'claude_result_invalid' });
    else await runInstalledClaudeCase(options);
    assert.equal(stopped, true);
  }
});

for (const outcome of ['throws', 'terminal', 'tree'])
  test('Claude rejects owned cleanup ' + outcome, async (t) => {
    const { options } = fixture(t);
    const launch = options.spawnOwned;
    options.spawnOwned = async (request) => ({
      child: launch(request).child,
      stop: async () => {
        if (outcome === 'throws') throw new Error('secret must not escape');
        return { terminal: outcome !== 'terminal', treeStopped: outcome !== 'tree' };
      },
    });
    await assert.rejects(runInstalledClaudeCase(options), {
      message: 'claude_owned_cleanup_failed',
    });
  });

test('Claude stops owned process after early exit', async (t) => {
  const { options } = fixture(t);
  let stopped = false;
  options.spawnOwned = async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(_chunk, _encoding, done) {
        queueMicrotask(() => child.emit('close', 1));
        done();
      },
    });
    return {
      child,
      stop: async () => {
        stopped = true;
        return { terminal: true, treeStopped: true };
      },
    };
  };
  await assert.rejects(runInstalledClaudeCase(options), { message: 'claude_early_exit' });
  assert.equal(stopped, true);
});

test('Claude launch failure is sanitized and never retried', async (t) => {
  const { options } = fixture(t);
  let calls = 0;
  options.spawnOwned = async () => {
    calls++;
    throw new Error('secret must not escape');
  };
  await assert.rejects(runInstalledClaudeCase(options), { message: 'claude_case_failed' });
  assert.equal(calls, 1);
});

test('source parser bounds incomplete lines before buffering more input', async () => {
  let consumed = 0;
  async function* oversized() {
    consumed++;
    yield Buffer.alloc(16384, 120);
    consumed++;
    yield Buffer.from('x');
    consumed++;
    yield Buffer.from('\n');
  }
  await assert.rejects(
    async () => {
      for await (const line of boundedLines(oversized())) assert.fail(line);
    },
    { message: 'source_request_invalid' }
  );
  assert.equal(consumed, 2);
  async function* split() {
    const bytes = Buffer.from('中文\r\n{}\n');
    for (const byte of bytes) yield Buffer.from([byte]);
  }
  const lines = [];
  for await (const line of boundedLines(split())) lines.push(line);
  assert.deepEqual(lines, ['中文', '{}']);
  async function* unterminated() {
    yield Buffer.from('{}');
  }
  await assert.rejects(
    async () => {
      for await (const line of boundedLines(unterminated())) assert.fail(line);
    },
    { message: 'source_request_invalid' }
  );
});

test('Claude contains owned stdin transport errors and still stops the tree', async (t) => {
  const { options } = fixture(t);
  let stopped = false;
  options.spawnOwned = async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(_chunk, _encoding, done) {
        done(new Error('secret transport detail'));
      },
    });
    return {
      child,
      stop: async () => {
        stopped = true;
        return { terminal: true, treeStopped: true };
      },
    };
  };
  await assert.rejects(runInstalledClaudeCase(options), { message: 'claude_transport_failed' });
  assert.equal(stopped, true);
});

for (const [name, chunks, code] of [
  [
    'private tool',
    ['{"type":"assistant","content":"hpm_read_retained_evidence"}\n'],
    'claude_private_wire_leak',
  ],
  [
    'thinking sentinel',
    ['{"type":"assistant","content":"private-thinking-sentinel"}\n'],
    'claude_private_wire_leak',
  ],
  [
    'signature sentinel',
    ['{"type":"assistant","content":"private-signature-sentinel"}\n'],
    'claude_private_wire_leak',
  ],
  ['invalid JSON', ['not-json\n'], 'claude_json_invalid'],
  [
    'fragment without newline',
    ['{"type":"assistant",', '"content":"unfinished"}'],
    'claude_json_invalid',
  ],
])
  test('Claude observes late cleanup ' + name, async (t) => {
    const { options } = fixture(t);
    const launch = options.spawnOwned;
    let stopped = false;
    options.spawnOwned = async (request) => {
      const owned = launch(request);
      return {
        child: owned.child,
        stop: async () => {
          for (const chunk of chunks) {
            await new Promise((resolve) => setImmediate(resolve));
            owned.child.stdout.write(chunk);
          }
          stopped = true;
          return { terminal: true, treeStopped: true };
        },
      };
    };
    await assert.rejects(runInstalledClaudeCase(options), { message: code });
    assert.equal(stopped, true);
  });

test('Claude refuses an existing nonempty case directory before launch', async (t) => {
  const { options } = fixture(t);
  fs.writeFileSync(path.join(options.caseRoot, 'daily-settings.json'), 'must remain untouched');
  let launched = false;
  options.spawnOwned = async () => {
    launched = true;
    throw new Error('unexpected');
  };
  await assert.rejects(runInstalledClaudeCase(options), { message: 'claude_case_invalid' });
  assert.equal(launched, false);
  assert.equal(
    fs.readFileSync(path.join(options.caseRoot, 'daily-settings.json'), 'utf8'),
    'must remain untouched'
  );
});

test('Claude refuses a symlink case directory', async (t) => {
  const { options } = fixture(t);
  const target = options.caseRoot + '-target';
  fs.mkdirSync(target);
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  fs.rmdirSync(options.caseRoot);
  fs.symlinkSync(target, options.caseRoot, 'junction');
  await assert.rejects(runInstalledClaudeCase(options), { message: 'claude_case_invalid' });
  assert.deepEqual(fs.readdirSync(target), []);
});

for (const replacement of ['root', 'home', 'symlink'])
  test('Claude detects physical directory replacement ' + replacement, async (t) => {
    const { options } = fixture(t);
    const launch = options.spawnOwned;
    let stopped = false;
    options.spawnOwned = async (request) => {
      const owned = launch(request);
      return {
        child: owned.child,
        stop: async () => {
          stopped = true;
          return { terminal: true, treeStopped: true };
        },
      };
    };
    options.onProgress = ({ phase }) => {
      if (phase !== 'between-1') return;
      const directory =
        replacement === 'root' ? options.caseRoot : path.join(options.caseRoot, 'home');
      const previous = directory + '-previous';
      fs.renameSync(directory, previous);
      t.after(() => fs.rmSync(previous, { recursive: true, force: true }));
      if (replacement === 'symlink') fs.symlinkSync(previous, directory, 'junction');
      else fs.mkdirSync(directory);
    };
    await assert.rejects(runInstalledClaudeCase(options), {
      message: 'claude_case_identity_changed',
    });
    assert.equal(stopped, true);
  });

test('Claude rechecks directory identity after owned stop', async (t) => {
  const { options } = fixture(t);
  const launch = options.spawnOwned;
  options.spawnOwned = async (request) => {
    const owned = launch(request);
    return {
      child: owned.child,
      stop: async () => {
        const home = path.join(options.caseRoot, 'home');
        fs.renameSync(home, home + '-previous');
        fs.mkdirSync(home);
        return { terminal: true, treeStopped: true };
      },
    };
  };
  await assert.rejects(runInstalledClaudeCase(options), {
    message: 'claude_case_identity_changed',
  });
});

test(
  'synthetic source keeps its five-second whole-request deadline during active streaming',
  { timeout: 30000 },
  async (t) => {
    let calls = 0;
    const server = http.createServer((_request, response) => {
      calls++;
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('Synthetic original Unicode 中文🙂\r\n');
      const interval = setInterval(() => response.write('x'), 25);
      response.once('close', () => clearInterval(interval));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    await assert.rejects(fetchOriginal('http://127.0.0.1:' + server.address().port + '/source'), {
      message: 'source_failed',
    });
    assert.equal(calls, 1);
  }
);

test('synthetic source rejects invalid transport setup without leaving a request deadline', async () => {
  for (const url of [
    'not a URL',
    'http://192.0.2.1:4455/source',
    'http://u:p@127.0.0.1:4455/source',
  ])
    await assert.rejects(fetchOriginal(url), { message: 'source_failed' });
});

test('Claude persisted session resumes in a second owned process without replaying original work or adding turns', async (t) => {
  for (const mode of ['default', 'enhanced']) {
    const f = fixture(t, mode);
    const result = await runInstalledClaudeCase(Object.assign(f.options, { restartClient: true }));
    assert.equal(result.clientRestarted, true);
    assert.equal(result.persistedSessionResumed, true);
    assert.equal(result.schemaVersion, 2);
    assert.equal(result.ownedLaunches, 2);
    assert.equal(result.processTerminal, true);
    assert.equal(result.ownedTreeStopped, true);
    assert.equal(result.compactions, 3);
    assert.equal(f.stops(), 2);
    assert.equal(f.launches.length, 2);
    assert.deepEqual(f.launches[1].args, [...f.launches[0].args, '--resume', f.sessionId]);
    assert.deepEqual(f.launches[1].env, f.launches[0].env);
    assert.equal(f.launches[0].args.includes('--no-session-persistence'), false);
    assert.deepEqual(f.phases, [
      'seed',
      'compact-1',
      'between-1',
      'compact-2',
      'between-2',
      'compact-3',
      'final',
    ]);
    for (const privateValue of [
      f.sessionId,
      f.options.caseRoot,
      f.options.marker,
      f.options.entryToken,
    ])
      assert.equal(JSON.stringify(result).includes(privateValue), false);
  }
});

test('Claude restart requires a canonical unchanged native session identity and a fresh init from each process', async (t) => {
  for (const fault of [
    'missing',
    'invalid',
    'path',
    'changed',
    'missing-init',
    'changed-after-restart',
    'result-after-restart',
    'newline',
    'nil',
  ]) {
    const f = fixture(t, 'enhanced', (events, phase, _witness, launch) => {
      if (fault === 'missing-init') {
        const index = events.findIndex((event) => event.subtype === 'init');
        if (index >= 0) events.splice(index, 1);
      }
      for (const event of events) {
        if (!['system', 'result'].includes(event.type) || event.subtype === 'compact_boundary')
          continue;
        if (fault === 'missing') delete event.session_id;
        if (fault === 'newline') event.session_id += '\n';
        if (fault === 'nil') event.session_id = '00000000-0000-0000-0000-000000000000';
        if (fault === 'invalid') event.session_id = 'x'.repeat(4096);
        if (fault === 'path') event.session_id = '/private/other/session.jsonl';
        if (fault === 'changed' && phase === 'compact-1')
          event.session_id = '87654321-1234-4234-9234-123456789abc';
        if (fault === 'changed-after-restart' && launch === 2)
          event.session_id = '87654321-1234-4234-9234-123456789abc';
        if (fault === 'result-after-restart' && launch === 2 && event.type === 'result')
          delete event.session_id;
      }
    });
    await assert.rejects(
      runInstalledClaudeCase(Object.assign(f.options, { restartClient: true })),
      {
        message: 'claude_session_invalid',
      }
    );
    assert.ok(f.launches.length <= 2);
    assert.ok(f.stops() <= 2);
  }
});

test('Claude restart refuses a failed first or second tree exit without another launch', async (t) => {
  for (const index of [1, 2]) {
    const f = fixture(t, 'enhanced');
    f.failStopAt(index);
    await assert.rejects(
      runInstalledClaudeCase(Object.assign(f.options, { restartClient: true })),
      {
        message: 'claude_owned_cleanup_failed',
      }
    );
    assert.equal(f.launches.length, index);
    assert.equal(f.stops(), index);
  }
});

test('Claude options reject unknown, inherited, non-enumerable and executable restart inputs before touching the home', async (t) => {
  for (const value of [false, null, 0, Number.MAX_SAFE_INTEGER, '', 'true', {}, []]) {
    const f = fixture(t, 'default');
    await assert.rejects(runInstalledClaudeCase({ ...f.options, restartClient: value }), {
      message: 'claude_case_invalid',
    });
    assert.deepEqual(fs.readdirSync(f.options.caseRoot), []);
    assert.equal(f.launches.length, 0);
  }
  const f = fixture(t, 'default');
  let touched = 0;
  const getter = Object.defineProperty({ ...f.options }, 'restartClient', {
    enumerable: true,
    get() {
      touched++;
      return true;
    },
  });
  const inherited = Object.create({
    get entryUrl() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  const hidden = Object.defineProperty({ ...f.options }, 'restartClient', {
    enumerable: false,
    value: true,
  });
  for (const input of [
    getter,
    inherited,
    hidden,
    { ...f.options, extra: true },
    new Proxy(f.options, {
      get() {
        touched++;
        throw Error('PRIVATE');
      },
    }),
  ])
    await assert.rejects(runInstalledClaudeCase(input), { message: 'claude_case_invalid' });
  assert.equal(touched, 0);
  assert.equal(f.launches.length, 0);
});

test('Claude restart refuses a partial frame at first EOF rather than joining it with another process', async (t) => {
  const f = fixture(t, 'default'),
    start = f.options.spawnOwned;
  f.options.restartClient = true;
  f.options.spawnOwned = (launch) => {
    const handle = start(launch),
      write = handle.child.stdout.write.bind(handle.child.stdout);
    handle.child.stdout.write = (chunk, ...args) => {
      const result = write(chunk, ...args);
      if (f.phases.at(-1) === 'compact-3' && String(chunk).includes('"type":"result"'))
        write('{"unfinished"');
      return result;
    };
    return handle;
  };
  await assert.rejects(runInstalledClaudeCase(f.options), { message: 'claude_json_invalid' });
  assert.equal(f.launches.length, 1);
  assert.equal(f.stops(), 1);
});

test('Claude restart retains the combined stdout bound across two separately valid streams', async (t) => {
  const padding = 'x'.repeat(1100000);
  const f = fixture(t, 'default', (events, phase) => {
    if (phase === 'seed' || phase === 'final')
      events.unshift({ type: 'system', subtype: 'status', padding });
  });
  f.options.restartClient = true;
  await assert.rejects(runInstalledClaudeCase(f.options), { message: 'claude_output_limit' });
  assert.equal(f.launches.length, 2);
  assert.equal(f.stops(), 2);
});
