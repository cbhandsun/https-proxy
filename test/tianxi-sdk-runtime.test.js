'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { AbortController } = globalThis;
const { runSdkProcess, createTianxiSdkRuntime } = require('../lib/proxy/tianxi-sdk-runtime');
const { createTianxiBridgeRuntime } = require('../lib/proxy/tianxi-bridge-runtime');
const header = { user_id: 'user', app_id: 'app', device_id: 'device' };
const input = { modelId: 'qfmodel', prompt: 'PRIVATE_PROMPT', instructions: '' };
const token = 'sat-YQ.Yg.Yw';
function fake(mode = 'success') {
  let cleaned = 0,
    terminated = 0,
    spawnOptions;
  const writes = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 123;
  const send = (frame) => child.stdout.emit('data', Buffer.from(JSON.stringify(frame) + '\n'));
  child.stdin.on('data', (chunk) => {
    const frame = JSON.parse(chunk.toString());
    writes.push(frame);
    setImmediate(() => {
      if (mode === 'hang') return;
      if (frame.type === 'control_request') {
        const response = {
          type: 'control_response',
          response: { request_id: frame.request_id, subtype: 'success' },
        };
        if (frame.request.type === 'daemon.open_session') response.session_id = 'session';
        if (frame.session_id) response.session_id = frame.session_id;
        send(response);
      } else if (frame.type === 'user') {
        if (mode === 'malformed') {
          child.stdout.emit('data', Buffer.from('not-json\n'));
          return;
        }
        if (mode === 'close') {
          child.emit('close', 1);
          return;
        }
        if (mode === 'stderr') {
          child.stderr.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1));
          return;
        }
        if (mode === 'stdin') {
          child.stdin.emit('error', new Error('PRIVATE'));
          return;
        }
        if (mode === 'failure') {
          send({ type: 'result', subtype: 'success', is_error: true });
          return;
        }
        send({
          type: 'control_request',
          session_id: 'session',
          request_id: 'auth',
          request: { type: 'fetch_service_account_token' },
        });
        const bytes = Buffer.from(
          JSON.stringify({
            type: 'assistant',
            session_id: 'session',
            message: { model: 'qfmodel', content: [{ type: 'text', text: '成功' }] },
          }) + '\n'
        );
        const offset = bytes.indexOf(Buffer.from('成')) + 1;
        child.stdout.emit('data', bytes.subarray(0, offset));
        child.stdout.emit('data', bytes.subarray(offset));
        send({ type: 'result', subtype: 'success', is_error: false, modelUsage: { qfmodel: {} } });
      }
    });
  });
  const options = {
    prepare: () => ({
      cli: 'pinned.exe',
      root: 'owned',
      args: ['--sdk'],
      workerArgs: ['--tools', ''],
      env: { QODER_AGENT_SDK_ENTRYPOINT: 'sdk-ts' },
      cleanup() {
        cleaned++;
      },
    }),
    spawnChild(_cli, args, options) {
      spawnOptions = { args, ...options };
      setImmediate(() => child.emit('spawn'));
      return child;
    },
    readHeader: () => header,
    terminate() {
      terminated++;
      setImmediate(() => child.emit('close', 0));
    },
  };
  return { options, child, writes, stats: () => ({ cleaned, terminated, spawnOptions }) };
}
test('SDK subprocess keeps auth and prompt in pipes, handles split UTF8 and cleans owned process', async () => {
  const f = fake(),
    frames = [];
  const result = await runSdkProcess(
    input,
    header,
    token,
    { onFrame: (frame) => frames.push(frame) },
    f.options
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.frames[0].data.content, '成功');
  assert.deepEqual(frames, result.frames);
  assert.equal(f.stats().cleaned, 1);
  assert.equal(f.stats().terminated, 1);
  const launch = JSON.stringify(f.stats().spawnOptions);
  assert.ok(!launch.includes(token));
  assert.ok(!launch.includes(input.prompt));
  assert.equal(f.stats().spawnOptions.windowsHide, true);
  // The callback response is scheduled asynchronously after user query delivery.
  assert.ok(f.writes.some((frame) => frame.message?.content[0].text === input.prompt));
});
test('SDK process failure paths reject safely and terminate only owned child', async () => {
  for (const mode of ['malformed', 'stderr', 'stdin', 'failure', 'close']) {
    const f = fake(mode);
    await assert.rejects(runSdkProcess(input, header, token, {}, f.options), /tianxi_sdk_/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.stats().cleaned, 1);
    assert.equal(f.stats().terminated, mode === 'close' ? 0 : 1);
  }
  const f = fake();
  await assert.rejects(
    runSdkProcess(
      input,
      header,
      token,
      {},
      {
        ...f.options,
        spawnChild() {
          throw new Error('PRIVATE');
        },
      }
    ),
    /launch_failed/
  );
  assert.equal(f.stats().cleaned, 1);
});
test('SDK cancellation before and during launch cleans resources and prevents generation', async () => {
  const f = fake('hang'),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runSdkProcess(input, header, token, { signal: controller.signal }, f.options),
    /aborted/
  );
  assert.equal(f.stats().cleaned, 0);
  const next = fake('hang'),
    c = new AbortController();
  const pending = runSdkProcess(input, header, token, { signal: c.signal }, next.options);
  c.abort();
  await assert.rejects(pending, /aborted/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(next.stats().cleaned, 1);
  assert.equal(next.stats().terminated, 1);
});
test('SDK factory validates before refresh, enforces deadline and limits concurrent processes', async () => {
  let refreshes = 0;
  const f = fake();
  const runtime = createTianxiSdkRuntime({
    ...f.options,
    refresh: async () => {
      refreshes++;
      return { token };
    },
  });
  await assert.rejects(runtime.sendResponses({}), /tianxi_native_runtime_failed/);
  assert.equal(refreshes, 0);
  const payload = { input: 'hello', metadata: { tianxi: { sdk_model: 'qfmodel' } } };
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const hanging = controllers.map((c) => {
    const fixture = fake('hang');
    return createTianxiSdkRuntime({
      ...fixture.options,
      refresh: async () => ({ token }),
    }).sendResponses(payload, { signal: c.signal });
  });
  const rejected = hanging.map((p) => assert.rejects(p));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    runtime.sendResponses(payload),
    (e) =>
      e.details?.cause_message === 'tianxi_sdk_busy' || e.code === 'tianxi_native_runtime_failed'
  );
  controllers.forEach((c) => c.abort());
  await Promise.all(rejected);
  const timed = fake('hang');
  await assert.rejects(
    createTianxiSdkRuntime({
      ...timed.options,
      refresh: async () => ({ token }),
      timeoutMs: 10,
    }).sendResponses(payload),
    { code: 'tianxi_native_runtime_timeout' }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timed.stats().terminated, 1);
});
test('Specific model marker chooses SDK while existing chat remains native', async () => {
  const selected = [];
  const factory = (name) => () => ({
    sendResponses: async (payload) => {
      selected.push([name, payload]);
      return { frames: [{ type: 'task_status', data: { status: 'COMPLETED' } }] };
    },
  });
  const bridge = createTianxiBridgeRuntime({
    env: {},
    makeRequest: async () => {
      throw new Error('unexpected');
    },
    getTianxiOfficialBridgeUrl: () => '',
    createSdkRuntime: factory('sdk'),
    createDirectRuntime: factory('native'),
  });
  const profile = { id: 'tianxi-official', protocol: 'tianxi', authMode: 'official-login' };
  assert.equal(
    (
      await bridge.callTianxiOfficialBridge(
        { metadata: { tianxi: { sdk_model: 'qfmodel' } } },
        profile
      )
    ).bridgeUrl,
    'tianxi://sdk'
  );
  assert.equal(
    (await bridge.callTianxiOfficialBridge({ model: 'chat' }, profile)).bridgeUrl,
    'tianxi://tac-server'
  );
  assert.deepEqual(
    selected.map((s) => s[0]),
    ['sdk', 'native']
  );
});
