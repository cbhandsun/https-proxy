'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const http = require('node:http');
const { AbortController } = globalThis;
const { AgyError, MODELS, parseChatRequest } = require('../lib/proxy/agy-chat-request');
const { createEventParser } = require('../lib/proxy/agy-events');
const { childEnvironment, createAgyRuntime, DENY_RULES } = require('../lib/proxy/agy-runtime');
const { createAgyBridgeServer } = require('../lib/proxy/agy-bridge-server');

const model = MODELS[0];
const body = (extra = {}) => ({ model, messages: [{ role: 'user', content: 'hi' }], ...extra });
const init = { event: 'init', init: { permission_mode: 'request-review' } };
const delta = (text) => ({
  event: 'step_update',
  step_update: { step_type: 'agent_response', text_delta: text },
});
const result = (text = 'hello', extra = {}) => ({
  event: 'result',
  result: { status: 'SUCCESS', response: text, ...extra },
});
const emit = (parser, events) =>
  parser.push(Buffer.from(events.map((event) => JSON.stringify(event)).join('\n') + '\n'));

test('validates text, role history, stream flags; preserves untrusted content as data', () => {
  const request = parseChatRequest(
    body({
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Remember apple' },
        { role: 'assistant', content: 'OK' },
        { role: 'user', content: [{ type: 'text', text: '/skill $(whoami) `cmd` 中文' }] },
      ],
      stream: true,
      stream_options: { include_usage: true },
    })
  );
  assert.equal(request.cliModel, 'gemini-3.7-flash-high');
  assert.equal(request.stream, true);
  assert.equal(request.includeUsage, true);
  assert.ok(request.prompt.includes('Remember apple'));
  assert.ok(request.prompt.includes('/skill $(whoami) `cmd` 中文'));
});

test('rejects empty, malformed, extreme, unsupported and dangerous request fields', () => {
  const bad = [
    null,
    [],
    {},
    body({ model: '--dangerously-skip-permissions' }),
    body({ stream: 'true' }),
    body({ tools: [] }),
    body({ temperature: 0.5 }),
    body({ messages: [] }),
    body({ messages: Array(65).fill({ role: 'user', content: 'x' }) }),
    body({ messages: [{ role: 'tool', content: 'x' }] }),
    body({ messages: [{ role: 'assistant', content: 'x' }] }),
    body({ messages: [{ role: 'user', content: '' }] }),
    body({ messages: [{ role: 'user', content: 'x\0y' }] }),
    body({ messages: [{ role: 'user', content: 'x'.repeat(32769) }] }),
    body({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'secret' }] }] }),
    body({ messages: [{ role: 'user', content: 'x', tool_calls: [] }] }),
    body({
      messages: [
        { role: 'user', content: 'x' },
        { role: 'system', content: 'x' },
        { role: 'user', content: 'x' },
      ],
    }),
    body({ stream_options: { include_usage: true } }),
    body({ stream: true, stream_options: { include_usage: 'true' } }),
    body({ messages: Array(64).fill({ role: 'user', content: '你'.repeat(3000) }) }),
  ];
  for (const input of bad) assert.throws(() => parseChatRequest(input), AgyError);
});

test('parses split UTF-8 NDJSON and usage, requires complete consistent results', () => {
  const chunks = [];
  const parser = createEventParser({ onDelta: (text) => chunks.push(text) });
  const data = Buffer.from(
    [
      init,
      delta('你好'),
      result('你好', { usage: { input_tokens: 2, output_tokens: 3, thinking_tokens: 4 } }),
    ]
      .map(JSON.stringify)
      .join('\n')
  );
  for (const byte of data) parser.push(Buffer.from([byte]));
  assert.deepEqual(parser.finish(), {
    text: '你好',
    usage: { prompt_tokens: 2, completion_tokens: 7, total_tokens: 9 },
  });
  assert.deepEqual(chunks, ['你好']);
  const fallback = createEventParser({ onDelta: (text) => chunks.push(text) });
  emit(fallback, [init, result('final')]);
  assert.equal(fallback.finish().text, 'final');
  assert.equal(chunks.at(-1), 'final');
});

test('rejects tools, bad output, permission failures, incomplete and oversized streams without echoing diagnostics', () => {
  const cases = [
    [[result()], 'agy_invalid_output'],
    [[init, init], 'agy_invalid_output'],
    [
      [
        init,
        { event: 'step_update', step_update: { step_type: 'tool', tool_name: 'run_command' } },
      ],
      'agy_tools_not_allowed',
    ],
    [[init, result('')], 'agy_empty_response'],
    [[init, delta('x'), result('y')], 'agy_inconsistent_stream'],
    [
      [init, result('x', { status: 'ERROR', error: 'SECRET The caller does not have permission' })],
      'agy_permission_denied',
    ],
    [
      [init, result('x', { status: 'ERROR', error: 'authentication required SECRET' })],
      'agy_authentication_required',
    ],
    [[init, result('x', { status: 'CANCELED', error: 'SECRET' })], 'agy_generation_failed'],
    [[init, result(), result()], 'agy_invalid_output'],
    [[init, { event: 'unexpected' }], 'agy_invalid_output'],
  ];
  for (const [events, code] of cases)
    assert.throws(
      () => emit(createEventParser(), events),
      (e) => e.code === code && !e.message.includes('SECRET')
    );
  assert.throws(() => createEventParser().push(Buffer.from('invalid\n')), /agy_invalid_output/);
  assert.throws(() => createEventParser().finish(), /agy_incomplete_output/);
  assert.throws(
    () => createEventParser({ maxBytes: 5 }).push(Buffer.alloc(6)),
    /agy_output_too_large/
  );
});

function fakeRuntime(behavior, options = {}) {
  const state = { cleaned: 0, terminated: 0, spawned: 0 };
  const runtime = createAgyRuntime({
    executable: path.resolve('fake-agy.exe'),
    timeoutMs: 100,
    prepare: () => ({
      root: path.resolve('fake-root'),
      cwd: path.resolve('empty-workspace'),
      env: { USERPROFILE: 'isolated' },
    }),
    cleanup: () => state.cleaned++,
    terminate: (child) => {
      state.terminated++;
      queueMicrotask(() => child.emit('close', 1));
    },
    spawnProcess: (executable, args, config) => {
      state.spawned++;
      state.args = args;
      state.config = config;
      const child = new EventEmitter();
      child.pid = 123;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      let input = '';
      child.stdin.on('data', (b) => (input += b.toString()));
      child.stdin.on('finish', () => {
        state.input = input;
        behavior(child);
      });
      return child;
    },
    ...options,
  });
  return { runtime, state };
}

test('runtime sends prompt only over stdin, isolates environment and cleans up after exit', async () => {
  const { runtime, state } = fakeRuntime((child) => {
    child.stdout.write([init, result()].map(JSON.stringify).join('\n') + '\n');
    queueMicrotask(() => child.emit('close', 0));
  });
  assert.equal((await runtime.generate(parseChatRequest(body()))).text, 'hello');
  assert.equal(state.cleaned, 1);
  assert.equal(state.config.shell, false);
  assert.equal(state.config.windowsHide, true);
  assert.ok(state.args.includes('--disable-slash-commands'));
  assert.ok(!state.args.includes('--dangerously-skip-permissions'));
  assert.ok(state.input.includes('hi'));
  assert.ok(!state.args.includes(parseChatRequest(body()).prompt));
  const env = childEnvironment('private', {
    APPDATA: 'app',
    PATH: 'bin',
    OPENAI_API_KEY: 'secret',
    GEMINI_API_KEY: 'secret',
    GOOGLE_GEMINI_BASE_URL: 'bad',
    USERPROFILE: 'real',
  });
  assert.deepEqual(env, { APPDATA: 'app', PATH: 'bin', USERPROFILE: 'private' });
  for (const rule of ['read_file(*)', 'write_file(*)', 'command(*)', 'mcp(*)'])
    assert.ok(DENY_RULES.includes(rule));
});

test('runtime times out, cancels, limits concurrency and releases its slot', async () => {
  const { runtime, state } = fakeRuntime(() => {});
  const first = runtime.generate(parseChatRequest(body()));
  await assert.rejects(runtime.generate(parseChatRequest(body())), /agy_busy/);
  await assert.rejects(first, /agy_timeout/);
  assert.equal(state.terminated, 1);
  const controller = new AbortController();
  const second = runtime.generate(parseChatRequest(body()), { signal: controller.signal });
  controller.abort();
  await assert.rejects(second, /agy_canceled/);
  assert.equal(state.cleaned, 2);
  await assert.rejects(
    runtime.generate(parseChatRequest(body()), { signal: controller.signal }),
    /agy_canceled/
  );
  assert.equal(state.spawned, 2);
});

test('runtime handles spawn failure, nonzero exit, stderr overflow and malformed output safely', async () => {
  for (const [behavior, code] of [
    [(p) => p.emit('error', new Error('SECRET')), 'agy_start_failed'],
    [
      (p) => {
        p.stdout.write([init, result()].map(JSON.stringify).join('\n'));
        p.emit('close', 1);
      },
      'agy_process_failed',
    ],
    [
      (p) => {
        p.stdout.write('SECRET\n');
      },
      'agy_invalid_output',
    ],
    [
      (p) => {
        p.stderr.write(Buffer.alloc(1024 * 1024 + 1));
      },
      'agy_output_too_large',
    ],
  ]) {
    const { runtime, state } = fakeRuntime(behavior);
    await assert.rejects(
      runtime.generate(parseChatRequest(body())),
      (e) => e.code === code && !e.message.includes('SECRET')
    );
    assert.equal(state.cleaned, 1);
  }
});

async function withServer(runtime, action) {
  const token = 'test-local-token-'.repeat(4);
  const records = [];
  const bridge = createAgyBridgeServer({ runtime, token, onRequest: (o) => records.push(o) });
  await new Promise((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${bridge.server.address().port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  try {
    await action({ url, headers, records });
  } finally {
    await bridge.close();
  }
}

test('HTTP bridge authenticates, validates, advertises only supported models, returns chat and SSE', async () => {
  let calls = 0;
  await withServer(
    {
      generate: async (request, { onDelta }) => {
        calls++;
        onDelta?.('hello');
        return {
          text: 'hello',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      },
    },
    async ({ url, headers, records }) => {
      assert.equal((await fetch(url + '/v1/models')).status, 401);
      assert.equal(
        (
          await fetch(url + '/v1/models', {
            headers: { ...headers, origin: 'https://evil.example' },
          })
        ).status,
        403
      );
      const models = await (await fetch(url + '/v1/models', { headers })).json();
      assert.deepEqual(
        models.data.map((m) => m.id),
        MODELS
      );
      for (const stream of [false, true]) {
        const r = await fetch(url + '/v1/chat/completions', {
          method: 'POST',
          headers,
          body: JSON.stringify(
            body(stream ? { stream, stream_options: { include_usage: true } } : {})
          ),
        });
        assert.equal(r.status, 200);
        const text = await r.text();
        if (stream) {
          assert.ok(text.includes('[DONE]'));
          assert.ok(text.includes('chat.completion.chunk'));
          assert.ok(text.includes('"total_tokens":2'));
        } else assert.equal(JSON.parse(text).choices[0].message.content, 'hello');
      }
      assert.equal(
        (await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: '{' })).status,
        400
      );
      assert.equal(
        (
          await fetch(url + '/v1/chat/completions', {
            method: 'POST',
            headers,
            body: JSON.stringify(body({ tools: [] })),
          })
        ).status,
        400
      );
      assert.equal(calls, 2);
      assert.ok(!JSON.stringify(records).includes('hello'));
    }
  );
});

test('HTTP bridge preserves failures before headers and emits error without successful finish after SSE starts', async () => {
  await withServer(
    {
      generate: async (request, { onDelta }) => {
        onDelta?.('partial');
        throw new AgyError('agy_permission_denied', 403);
      },
    },
    async ({ url, headers }) => {
      for (const stream of [false, true]) {
        const r = await fetch(url + '/v1/chat/completions', {
          method: 'POST',
          headers,
          body: JSON.stringify(body({ stream })),
        });
        assert.equal(r.status, stream ? 200 : 403);
        const text = await r.text();
        assert.ok(text.includes('agy_permission_denied'));
        assert.ok(!text.includes('"finish_reason":"stop"'));
      }
    }
  );
});

test('HTTP client disconnect aborts the running generation', async () => {
  let aborted = false;
  await withServer(
    {
      generate: (request, { signal, onDelta }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new AgyError('agy_canceled', 499));
            },
            { once: true }
          );
          onDelta('first');
        }),
    },
    async ({ url, headers }) => {
      const r = await fetch(url + '/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify(body({ stream: true })),
      });
      await r.body.cancel();
      for (let i = 0; i < 20 && !aborted; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(aborted, true);
    }
  );
});

test('HTTP rejects oversized bodies, invalid UTF-8, wrong MIME and unknown endpoints before generation', async () => {
  await withServer(
    { generate: () => assert.fail('must not generate') },
    async ({ url, headers }) => {
      assert.equal(
        (
          await fetch(url + '/v1/chat/completions', {
            method: 'POST',
            headers,
            body: 'x'.repeat(128 * 1024 + 1),
          })
        ).status,
        413
      );
      const invalidUtf8 = Buffer.concat([
        Buffer.from('{"model":"'),
        Buffer.from([0xff]),
        Buffer.from('"}'),
      ]);
      assert.equal(
        (await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: invalidUtf8 }))
          .status,
        400
      );
      assert.equal(
        (
          await fetch(url + '/v1/chat/completions', {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/jsonBAD' },
            body: '{}',
          })
        ).status,
        415
      );
      assert.equal((await fetch(url + '/v1/responses', { headers })).status, 404);
    }
  );
});

test('cleanup failures surface and do not erase the original generation error', async () => {
  const cleanup = () => {
    throw new Error('private path SECRET');
  };
  const success = fakeRuntime(
    (p) => {
      p.stdout.write([init, result()].map(JSON.stringify).join('\n'));
      p.emit('close', 0);
    },
    { cleanup }
  );
  await assert.rejects(success.runtime.generate(parseChatRequest(body())), /agy_cleanup_failed/);
  const failure = fakeRuntime((p) => p.emit('error', new Error('SECRET')), { cleanup });
  await assert.rejects(failure.runtime.generate(parseChatRequest(body())), /agy_start_failed/);
});

test('rejects inherited-only payloads and survives an aborted partial HTTP upload', async () => {
  assert.throws(() => parseChatRequest(Object.create(body())), AgyError);
  assert.throws(
    () => parseChatRequest(body({ messages: [Object.create({ role: 'user', content: 'hi' })] })),
    AgyError
  );
  await withServer(
    { generate: () => assert.fail('must not generate') },
    async ({ url, headers }) => {
      await new Promise((resolve) => {
        const req = http.request(url + '/v1/chat/completions', {
          method: 'POST',
          headers: { ...headers, 'content-length': '100' },
        });
        req.on('error', () => {});
        req.on('close', resolve);
        req.write('{');
        setTimeout(() => req.destroy(), 30);
      });
      assert.equal((await fetch(url + '/v1/models', { headers })).status, 200);
    }
  );
});

test('waits for descendant termination before cleanup and keeps the concurrency slot until cleanup ends', async () => {
  let treeStopped = false;
  let cleanupFinished = false;
  const { runtime } = fakeRuntime(() => {}, {
    terminate(child) {
      queueMicrotask(() => child.emit('close', 1));
      return new Promise((resolve) =>
        setTimeout(() => {
          treeStopped = true;
          resolve();
        }, 40)
      );
    },
    async cleanup() {
      assert.equal(treeStopped, true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      cleanupFinished = true;
    },
  });
  const controller = new AbortController();
  const pending = runtime.generate(parseChatRequest(body()), { signal: controller.signal });
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(runtime.generate(parseChatRequest(body())), /agy_busy/);
  await assert.rejects(pending, /agy_canceled/);
  assert.equal(cleanupFinished, true);
});
