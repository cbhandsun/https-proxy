'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createTianxiExternalToolChannel } = require('../lib/proxy/tianxi-external-tool-channel');
const { createTacServerTransport } = require('../lib/proxy/tianxi-agentcore-local');
const { createTacServerTianxiNativeRuntime } = require('../lib/proxy/tianxi-native-runtime');
const { discoverTestFiles, selectUnitTestFiles } = require('../lib/test-discovery');
const path = require('node:path');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function command() {
  return {
    type: 'query',
    header: { session_id: 'session', request_id: 'request' },
    data: {
      options: {
        customMcpServers: {
          client: {
            exec_mode: 'local',
            tools: [{ name: 'read', inputSchema: { type: 'object' } }],
          },
        },
      },
    },
  };
}
function frame() {
  return {
    type: 'act_exec',
    header: command().header,
    source: { type: 'agent', id: 'agent' },
    target: { type: 'user', id: 'user' },
    data: {
      exec_mode: 'local',
      task_id: 'task',
      execution_id: 'execution',
      actions: [{ id: 'action', mcpServerName: 'client', name: 'read', parameters: {} }],
    },
  };
}
function channel(onCall) {
  const sent = [],
    errors = [];
  const instance = createTianxiExternalToolChannel(command(), {
    onCall,
    send: (value) => sent.push(value),
    onError: (error) => errors.push(error),
  });
  return { ...instance, sent, errors };
}
test('external reply preserves routing and actions without trusting consumer mutation', async () => {
  const c = channel((request, reply) => {
    request.header.session_id = 'other';
    request.data.actions[0].id = 'other';
    assert.equal(reply(['']), true);
    assert.equal(reply(['duplicate']), false);
  });
  assert.equal(c.accept(frame()), true);
  await tick();
  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].type, 'act_resp');
  assert.deepEqual(c.sent[0].header, command().header);
  assert.deepEqual(c.sent[0].source, frame().target);
  assert.deepEqual(c.sent[0].target, frame().source);
  assert.equal(c.sent[0].data.actions[0].id, 'action');
  assert.equal(c.sent[0].data.actions[0].response, '');
});
test('duplicate pending and completed frames never dispatch a second call', async () => {
  let calls = 0;
  const c = channel((_, reply) => {
    calls++;
    reply(['ok']);
  });
  c.accept(frame());
  c.accept(frame());
  await tick();
  c.accept({ ...frame(), id: 'different-envelope' });
  await tick();
  assert.equal(calls, 1);
  assert.equal(c.sent.length, 1);
  const changed = frame();
  changed.data.actions[0].parameters = { path: 'changed' };
  assert.throws(() => c.accept(changed), /tianxi_external_tool_invalid/);
});
test('unregistered, malformed, oversized and cross-session calls fail before dispatch', async () => {
  let calls = 0;
  for (const mutate of [
    (f) => {
      f.header.session_id = 'other';
    },
    (f) => {
      f.header.request_id = 'other';
    },
    (f) => {
      f.header = null;
    },
    (f) => {
      f.data.task_id = '';
    },
    (f) => {
      f.data.actions[0].id = '';
    },
    (f) => {
      f.data.actions[0].id = 'unsafe\nidentity';
    },
    (f) => {
      f.data.execution_id = null;
    },
    (f) => {
      f.data.actions = [];
    },
    (f) => {
      f.data.actions = Array(17).fill(f.data.actions[0]);
    },
    (f) => {
      f.data.actions[0].mcpServerName = '__proto__';
    },
    (f) => {
      f.data.actions[0].name = 'write';
    },
    (f) => {
      f.data.actions[0].parameters = [];
    },
    (f) => {
      f.data.actions[0].parameters = { value: 'x'.repeat(131073) };
    },
    (f) => {
      f.data.actions[0].response = 'already executed';
    },
  ]) {
    const c = channel(() => calls++),
      f = frame();
    mutate(f);
    assert.throws(() => c.accept(f), /tianxi_external_tool_invalid/);
  }
  await tick();
  assert.equal(calls, 0);
});
test('task changes and reused action identities are rejected', async () => {
  const c = channel(() => {});
  c.accept(frame());
  const next = frame();
  next.data.execution_id = 'next';
  next.data.task_id = 'other';
  assert.throws(() => c.accept(next), /tianxi_external_tool_invalid/);
  next.data.task_id = 'task';
  assert.throws(() => c.accept(next), /tianxi_external_tool_invalid/);
  c.close();
  await tick();
});
test('one execution may contain sequential batches with distinct action IDs', async () => {
  let calls = 0;
  const c = channel((_, reply) => {
    calls++;
    reply(['ok']);
  });
  c.accept(frame());
  await tick();
  const next = frame();
  next.data.actions[0].id = 'next-action';
  c.accept(next);
  await tick();
  assert.equal(calls, 2);
  assert.equal(c.sent.length, 2);
});
test('unsafe parameter keys, excessive nesting and node counts are rejected', () => {
  for (const parameters of [
    JSON.parse('{"__proto__":{"polluted":true}}'),
    { nested: { constructor: 'unsafe' } },
    { entries: Array(4097).fill(0) },
    Array.from({ length: 18 }).reduce((value) => ({ nested: value }), {}),
  ]) {
    const c = channel(() => {}),
      f = frame();
    f.data.actions[0].parameters = parameters;
    assert.throws(() => c.accept(f), /tianxi_external_tool_invalid/);
  }
  assert.equal({}.polluted, undefined);
});
test('qualified names and multiple outputs keep action order', async () => {
  const c = channel((_, reply) => reply(['first', 'second']));
  const f = frame();
  f.data.actions[0].name = 'mcp__client__read';
  f.data.actions[0].id = 'opaque:tool/read#1';
  f.data.actions.push({ ...f.data.actions[0], id: 'action2' });
  c.accept(f);
  await tick();
  assert.deepEqual(
    c.sent[0].data.actions.map((action) => action.response),
    ['first', 'second']
  );
});
test('invalid outputs fail safely without leaking callback errors', async () => {
  for (const output of [[], [null], ['x'.repeat(65537)], ['é'.repeat(32769)]]) {
    const c = channel((_, reply) => reply(output));
    c.accept(frame());
    await tick();
    assert.equal(c.sent.length, 0);
    assert.equal(c.errors[0].message, 'tianxi_external_tool_callback_failed');
  }
  const c = channel(() => Promise.reject(new Error('SECRET token user-content')));
  c.accept(frame());
  await tick();
  assert.equal(c.errors[0].message, 'tianxi_external_tool_callback_failed');
});
test('close suppresses pending dispatch and late replies', async () => {
  let calls = 0,
    reply;
  const c = channel((_, value) => {
    calls++;
    reply = value;
  });
  c.accept(frame());
  c.close();
  await tick();
  assert.equal(calls, 0);
  const other = channel((_, value) => {
    reply = value;
  });
  other.accept(frame());
  await tick();
  other.close();
  assert.equal(reply(['late']), false);
  assert.equal(other.sent.length, 0);
});
test('channel is opt-in and ignores internally executed frames', () => {
  assert.equal(createTianxiExternalToolChannel({}, {}), null);
  const c = channel(() => {});
  assert.equal(c.accept({ type: 'act_resp' }), false);
  const f = frame();
  f.data.exec_mode = 'remote';
  assert.equal(c.accept(f), false);
  assert.throws(
    () => createTianxiExternalToolChannel({}, { onCall() {} }),
    /tianxi_external_tool_invalid/
  );
});
test('per-query call retention is bounded', async () => {
  const c = channel(() => {});
  for (let i = 0; i < 128; i++) {
    const f = frame();
    f.data.execution_id = `exec-${i}`;
    f.data.actions[0].id = `action-${i}`;
    c.accept(f);
  }
  const f = frame();
  f.data.execution_id = 'overflow';
  assert.throws(() => c.accept(f), /tianxi_external_tool_invalid/);
  c.close();
  await tick();
});
test('transport returns results on the original socket and closes it on terminal status', async () => {
  let socket;
  class Socket {
    constructor() {
      socket = this;
      this.listeners = {};
      this.sent = [];
      setImmediate(() => this.listeners.open());
    }
    addEventListener(name, listener) {
      this.listeners[name] = listener;
    }
    send(text) {
      const value = JSON.parse(text);
      this.sent.push(value);
      if (value.type === 'query') this.listeners.message({ data: JSON.stringify(frame()) });
      else
        this.listeners.message({
          data: JSON.stringify({ type: 'task_status', data: { status: 'COMPLETED' } }),
        });
    }
    close() {
      this.closed = true;
    }
  }
  const transport = createTacServerTransport({
    WebSocketImpl: Socket,
    autoStart: false,
    discoverWsUrls: () => [],
  });
  await transport.sendQuery(command(), {
    onExternalToolCall(_, reply) {
      reply(['ok']);
    },
  });
  assert.deepEqual(
    socket.sent.map((value) => value.type),
    ['query', 'act_resp']
  );
  assert.equal(socket.closed, true);
});
test('new regression file is discovered by the unified unit entry', () => {
  const files = selectUnitTestFiles(discoverTestFiles(path.resolve(__dirname, '..')));
  assert.ok(files.includes('test/tianxi-external-tool-channel.test.js'));
});
test('native runtime never retries auth after external dispatch without a frame observer', async () => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `sat-${encode({ alg: 'none' })}.${encode({ exp: 300 })}.signature`;
  let queries = 0,
    calls = 0,
    refreshes = 0;
  const runtime = createTacServerTianxiNativeRuntime({
    header: {
      app_id: 'app',
      credentials: { qoder_token: token },
      device_id: 'device',
      user_id: 'user',
    },
    readTianxiRegistryCredentialCache: () => ({
      available: true,
      credentialExpiry: { qoder_token: { expired: false } },
    }),
    refreshQoderToken() {
      refreshes++;
      throw new Error('must not replay');
    },
    transport: {
      async sendQuery(_, context) {
        queries++;
        await context.onExternalToolCall(frame(), () => true);
        return [
          {
            type: 'task_status',
            data: {
              status: 'FAILED',
              error_code: 'INVALID_CREDENTIALS',
              error_detail: 'authentication failed',
            },
          },
        ];
      },
    },
  });
  const result = await runtime.sendResponses(
    { model: 'super' },
    {
      now: () => 150000,
      onExternalToolCall() {
        calls++;
      },
    }
  );
  assert.equal(queries, 1);
  assert.equal(calls, 1);
  assert.equal(refreshes, 0);
  assert.equal(result.frames[0].data.status, 'FAILED');
});
test('transport contains reply send failures and drops replies after cancellation', async () => {
  for (const scenario of ['send_failure', 'cancel']) {
    let socket, reply;
    class Socket {
      constructor() {
        socket = this;
        this.listeners = {};
        this.sent = [];
        setImmediate(() => this.listeners.open());
      }
      addEventListener(name, listener) {
        this.listeners[name] = listener;
      }
      send(text) {
        const value = JSON.parse(text);
        this.sent.push(value);
        if (value.type === 'query') this.listeners.message({ data: JSON.stringify(frame()) });
        else throw new Error('SECRET send failure');
      }
      close() {
        this.closed = true;
      }
    }
    const abort = new globalThis.AbortController();
    const transport = createTacServerTransport({
      WebSocketImpl: Socket,
      autoStart: false,
      discoverWsUrls: () => [],
    });
    const pending = transport.sendQuery(command(), {
      signal: abort.signal,
      onExternalToolCall(_, value) {
        reply = value;
        if (scenario === 'cancel') abort.abort();
        else value(['ok']);
      },
    });
    await assert.rejects(
      pending,
      scenario === 'cancel' ? /tianxi_tac_server_aborted/ : /^Error: tianxi_tac_server_send_failed$/
    );
    assert.equal(socket.closed, true);
    assert.equal(reply(['late']), false);
    assert.equal(socket.sent.length, scenario === 'cancel' ? 1 : 2);
  }
});
