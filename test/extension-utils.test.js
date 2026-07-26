const assert = require('assert');
const {
  HOST,
  PORT,
  MAX_BODY_BYTES,
  createLogger,
  sendJson,
  sendSseEvent,
  readBody,
  delay,
  isBusyTraeError,
  normalizeResult,
  pickTraeCommand: pickTraeCommandPure,
  listTraeBridgeCommands: listTraeBridgeCommandsPure,
} = require('../tools/trae-openai-bridge-extension/extension-utils');

let pass = 0,
  fail = 0;
function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ok -', name);
  } catch (err) {
    fail += 1;
    console.error('  FAIL -', name, '\n   ', err.message);
  }
}

console.log('extension-utils golden tests');

// 1. Constants
t('constants are sensible', () => {
  assert.strictEqual(typeof HOST, 'string');
  assert.strictEqual(typeof PORT, 'number');
  assert.ok(MAX_BODY_BYTES > 0);
});

// 2. createLogger with no output is no-op
t('createLogger with null output is no-op', () => {
  const log = createLogger(null);
  log('test message');
  log('test 2');
});

// 3. createLogger with a channel writes lines
t('createLogger writes lines to output channel', () => {
  const lines = [];
  const fakeChannel = { appendLine: (line) => lines.push(line) };
  const log = createLogger(fakeChannel);
  log('hello world');
  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0].includes('hello world'));
  assert.ok(lines[0].includes('T'), 'should have ISO timestamp prefix');
});

// 4. sendJson sets correct headers
t('sendJson writes JSON response', () => {
  const headers = {};
  const res = {
    writeHead(status, h) {
      headers.status = status;
      Object.assign(headers, h);
    },
    end(body) {
      headers.body = body;
    },
  };
  sendJson(res, 200, { ok: true });
  assert.strictEqual(headers.status, 200);
  assert.strictEqual(headers['Content-Type'], 'application/json; charset=utf-8');
  assert.strictEqual(headers['Access-Control-Allow-Origin'], '*');
  assert.deepStrictEqual(JSON.parse(headers.body), { ok: true });
});

// 5. sendSseEvent emits proper SSE format
t('sendSseEvent formats as SSE', () => {
  const writes = [];
  const res = {
    write(s) {
      writes.push(s);
    },
  };
  sendSseEvent(res, 'progress', { phase: 'running' });
  assert.strictEqual(writes.length, 2);
  assert.strictEqual(writes[0], 'event: progress\n');
  assert.ok(writes[1].startsWith('data: '));
  assert.ok(writes[1].endsWith('\n\n'));
});

// 6. readBody parses JSON body
t('readBody aggregates and parses body', async () => {
  const req = new (require('events').EventEmitter)();
  process.nextTick(() => {
    req.emit('data', Buffer.from('{"a":'));
    req.emit('data', Buffer.from('1}'));
    req.emit('end');
  });
  const body = await readBody(req);
  assert.strictEqual(body, '{"a":1}');
});

// 7. readBody rejects on overflow
t('readBody rejects when body exceeds maxBytes', async () => {
  const EventEmitter = require('events');
  const req = new EventEmitter();
  req.destroy = () => {};
  process.nextTick(() => {
    req.emit('data', Buffer.alloc(100));
    req.emit('error', new Error('size exceeded'));
  });
  try {
    await readBody(req, 50);
    assert.fail('should reject');
  } catch (e) {
    assert.ok(e);
  }
});

// 8. isBusyTraeError matches busy-like errors
t('isBusyTraeError matches "not waiting input" / "busy" / "running"', () => {
  assert.strictEqual(isBusyTraeError('not waiting input'), true);
  assert.strictEqual(isBusyTraeError('Agent is busy'), true);
  assert.strictEqual(isBusyTraeError('still running'), true);
  assert.strictEqual(isBusyTraeError('unknown error'), false);
  assert.strictEqual(isBusyTraeError(null), false);
});

// 9. normalizeResult string
t('normalizeResult string passthrough', () => {
  assert.deepStrictEqual(normalizeResult('hello'), { text: 'hello' });
});
t('normalizeResult {text}', () => {
  assert.deepStrictEqual(normalizeResult({ text: 'x' }), { text: 'x' });
});
t('normalizeResult {response: {text}}', () => {
  const out = normalizeResult({ response: { text: 'y' } });
  assert.strictEqual(out.text, 'y');
  assert.deepStrictEqual(out.response, { text: 'y' });
});
t('normalizeResult unknown -> JSON', () => {
  const out = normalizeResult({ a: 1 });
  assert.strictEqual(out.text, '{"a":1}');
});
t('normalizeResult null -> empty', () => {
  assert.deepStrictEqual(normalizeResult(null), { text: '' });
});

// 10. pickTraeCommandPure picks the first available
t('pickTraeCommandPure picks first match', () => {
  assert.strictEqual(
    pickTraeCommandPure(['foo', 'feishu.bridge.sendAndWaitResponse', 'bar']),
    'feishu.bridge.sendAndWaitResponse'
  );
  assert.strictEqual(
    pickTraeCommandPure(['wx.bridge.sendAndWaitResponse']),
    'wx.bridge.sendAndWaitResponse'
  );
  assert.strictEqual(pickTraeCommandPure(['none.of.these']), null);
  assert.strictEqual(pickTraeCommandPure(null), null);
});

// 11. listTraeBridgeCommandsPure returns full inventory
t('listTraeBridgeCommandsPure returns inventory', () => {
  const info = listTraeBridgeCommandsPure([
    'wx.bridge.sendAndWaitResponse',
    'im.bridge.sendPromptStreaming',
    'im.bridge.subscribeRawStream',
    'agent.chat.something',
  ]);
  assert.strictEqual(info.waitCommand, 'wx.bridge.sendAndWaitResponse');
  assert.strictEqual(info.streamCommand, 'im.bridge.sendPromptStreaming');
  assert.strictEqual(info.rawStreamCommand, 'im.bridge.subscribeRawStream');
  assert.strictEqual(info.waitCommands.length, 2);
  assert.ok(info.discoveredCommands.includes('agent.chat.something'));
});

// 12. delay resolves
t('delay resolves after ms', async () => {
  const start = Date.now();
  await delay(20);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 15, 'should wait at least 15ms');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('extension-utils tests ok');
