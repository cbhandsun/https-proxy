'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const {
  createOpenAIResponsesToChatHandler,
} = require('../lib/proxy/handlers/responses-to-chat-handler');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const { safeWbipcStatus } = require('../lib/proxy/handlers/workbuddy-responses-flow');
for (const value of [null, undefined, 'SECRET', {}, [], NaN, Infinity, 999])
  assert.equal(safeWbipcStatus(value), 'unavailable');
assert.equal(safeWbipcStatus(200), 200);
assert.equal(safeWbipcStatus('E_PAYLOAD_TOO_LARGE'), 'E_PAYLOAD_TOO_LARGE');
const frame = (value) => 'data: ' + JSON.stringify(value) + '\n\n';
const wire = (text = 'ok') =>
  frame({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) +
  frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
  'data: [DONE]\n\n';
function fixture({ slow = false, options = {}, body = wire(), status = 200 } = {}) {
  const protocol = createOpenAIProtocol({
    cleanToolArgs: (_name, args) => args,
    fallbackId: (prefix) => prefix + '_fixture',
    stableCreated: () => 1,
    protocolOptions: options,
  });
  const client = new EventEmitter(),
    req = new EventEmitter(),
    writes = [],
    logs = [],
    errors = [],
    events = [];
  let hostOptions,
    deliver,
    rejectHost,
    ended = false,
    remembered = 0;
  req.method = 'POST';
  client.writableLength = 0;
  client.accepted = !slow;
  client.writeHead = () => {
    client.headersSent = true;
  };
  client.write = (value) => {
    writes.push(String(value));
    if (!client.accepted) client.writableLength += Buffer.byteLength(value);
    return client.accepted;
  };
  client.end = () => {
    ended = true;
    client.writableEnded = true;
    client.emit('finish');
  };
  client.destroy = () => {
    client.destroyed = true;
    client.emit('close');
  };
  const ctx = {
    ...protocol,
    CORS_HEADERS: {},
    protocolOptions: { contextWindowPolicy: 'disabled', ...options },
    parseProxyBody: () => ({ model: 'deepseek-v4-flash', input: 'ping', stream: true }),
    responsesToChatWithHistory: () => ({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
    }),
    rejectUnsupportedResponsesConversion: () => false,
    workBuddyWbipcClient: {
      request(_params, signalOptions) {
        hostOptions = signalOptions;
        return new Promise((resolve, reject) => {
          rejectHost = reject;
          deliver = () => resolve({ ok: true, status, headers: {}, body });
        });
      },
    },
    logRequestEnd: (...args) => logs.push(args),
    logProxyEvent: (...args) => events.push(args),
    createChatToResponsesBridge(sink) {
      const state = {
        id: 'resp_fixture',
        created_at: 1,
        model: 'fixture',
        buffer: '',
        outputIndex: 0,
        text: '',
        pendingToolCalls: [],
        toolCalls: [],
        completedOutputItems: [],
        done: false,
      };
      return {
        responseState: state,
        flush: () => protocol.flushOpenAIChatSseToResponses(sink, state),
      };
    },
    rememberResponsesFromBridge: () => {
      remembered++;
    },
    sendJsonError: (_res, status, payload) => errors.push({ status, payload }),
  };
  const handler = createOpenAIResponsesToChatHandler(ctx, {
    handleConvertedJsonResponse: () => assert.fail('JSON path selected'),
  });
  handler(
    req,
    client,
    {
      authProvider: 'workbuddy',
      profile: { protocol: 'workbuddy' },
      workbuddyAuth: { accessTokenEncrypted: true },
      rewriteTo: '-',
      buffer: Buffer.from('{}'),
    },
    { path: '/v2' },
    '',
    '/v1/responses',
    1
  );
  return {
    client,
    req,
    writes,
    logs,
    errors,
    events,
    rejectHost: (error) => rejectHost(error),
    deliver: () => deliver(),
    hostOptions: () => hostOptions,
    ended: () => ended,
    remembered: () => remembered,
  };
}
async function main() {
  const rejection = fixture();
  await tick();
  const unsafe = new Error('SECRET');
  unsafe.code = 'SECRET';
  rejection.rejectHost(unsafe);
  await tick();
  assert.ok(
    !JSON.stringify([rejection.events, rejection.errors, rejection.logs]).includes('SECRET')
  );
  const early = fixture();
  early.req.emit('aborted');
  await tick();
  assert.equal(early.hostOptions(), undefined);
  assert.equal(early.logs.length, 1);
  assert.equal(early.logs[0][3], 499);
  const cancel = fixture();
  await tick();
  assert.ok(cancel.hostOptions()?.signal, 'WBIPC must receive cancellation signal');
  cancel.client.emit('close');
  assert.equal(cancel.hostOptions().signal.aborted, true);
  cancel.deliver();
  await tick();
  assert.equal(cancel.writes.length, 0);
  assert.equal(cancel.errors.length, 0);
  assert.equal(cancel.logs.length, 1);
  assert.equal(cancel.logs[0][3], 499);
  assert.equal(cancel.client.listenerCount('close'), 0);
  assert.equal(cancel.req.listenerCount('aborted'), 0);
  const requestAbort = fixture();
  await tick();
  requestAbort.req.emit('aborted');
  requestAbort.deliver();
  await tick();
  assert.equal(requestAbort.hostOptions().signal.aborted, true);
  assert.equal(requestAbort.logs.length, 1);
  assert.equal(requestAbort.errors.length, 0);
  const downstreamError = fixture();
  await tick();
  downstreamError.client.emit('error', new Error('SECRET'));
  downstreamError.deliver();
  await tick();
  assert.equal(downstreamError.logs[0][3], 502);
  assert.ok(!JSON.stringify(downstreamError.logs).includes('SECRET'));
  const slow = fixture({ slow: true });
  await tick();
  slow.deliver();
  await tick();
  await tick();
  assert.equal(slow.ended(), false, 'must wait for drain');
  assert.equal(slow.logs.length, 0, 'success must wait for finish');
  assert.equal(
    slow.events.filter((event) => event[0] === 'workbuddy_context_outcome').length,
    0,
    'context success must also wait for finish'
  );
  assert.equal(slow.writes.length, 1);
  slow.client.accepted = true;
  slow.client.writableLength = 0;
  slow.client.emit('drain');
  await tick();
  assert.equal(slow.ended(), true);
  assert.equal(slow.logs.length, 1);
  assert.equal(slow.logs[0][3], 200);
  assert.equal(slow.remembered(), 1);
  assert.equal(slow.hostOptions().signal.aborted, false);
  assert.equal(slow.client.listenerCount('drain'), 0);
  assert.equal(slow.client.listenerCount('close'), 0);
  assert.ok(slow.writes.join('').includes('event: response.completed'));
  const overflow = fixture({ options: { maxConversionOutputBufferBytes: 64 } });
  await tick();
  overflow.deliver();
  await tick();
  await tick();
  assert.equal(overflow.client.destroyed, true);
  assert.equal(overflow.logs.length, 1);
  assert.equal(overflow.logs[0][3], 502);
  assert.equal(overflow.remembered(), 0);
  const pending = fixture({ slow: true });
  await tick();
  pending.deliver();
  await tick();
  pending.client.emit('close');
  await tick();
  assert.equal(pending.logs.length, 1);
  assert.equal(pending.logs[0][3], 499);
  assert.equal(pending.ended(), false);
  const unicode = fixture({ body: wire('中文 😀'.repeat(5000)) });
  await tick();
  unicode.deliver();
  await tick();
  await tick();
  assert.equal(unicode.logs[0][3], 200);
  assert.ok(unicode.writes.join('').includes('中文 😀'));
  assert.ok(!unicode.writes.join('').includes('�'));
  const malformed = fixture({ body: 'data: SECRET\n\n' });
  await tick();
  malformed.deliver();
  await tick();
  assert.equal(malformed.errors[0].status, 502);
  assert.ok(!JSON.stringify(malformed.errors).includes('SECRET'));
  for (const body of [null, {}, 1, 'x'.repeat(1024 * 1024 + 1)]) {
    const invalid = fixture({ body });
    await tick();
    invalid.deliver();
    await tick();
    assert.equal(invalid.errors[0].status, 502);
    assert.equal(invalid.writes.length, 0);
    assert.equal(invalid.remembered(), 0);
  }
  for (const status of [199, 600, NaN, 'SECRET']) {
    const invalid = fixture({ status });
    await tick();
    invalid.deliver();
    await tick();
    assert.equal(invalid.errors[0].status, 502);
    assert.ok(!JSON.stringify(invalid.errors).includes('SECRET'));
  }
  const empty = fixture({ body: '' });
  await tick();
  empty.deliver();
  await tick();
  assert.equal(empty.logs[0][3], 502);
  assert.ok(!empty.writes.join('').includes('event: response.completed'));
  const timeout = fixture({ slow: true, options: { conversionDrainTimeoutMs: 5 } });
  await tick();
  timeout.deliver();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(timeout.logs.length, 1);
  assert.equal(timeout.logs[0][3], 502);
  assert.equal(timeout.logs[0][4].errorCode, 'downstream_stream_drain_timeout');
  const truncated = fixture({
    body:
      frame({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_fixture',
                  function: { name: 'probe', arguments: '{"ok":true}' },
                },
              ],
            },
            finish_reason: 'length',
          },
        ],
      }) + 'data: [DONE]\n\n',
  });
  await tick();
  truncated.deliver();
  await tick();
  assert.equal(truncated.logs[0][3], 200);
  assert.ok(truncated.writes.join('').includes('event: response.incomplete'));
  assert.ok(!truncated.writes.join('').includes('response.function_call_arguments.done'));
  const toolItems = truncated.writes
    .flatMap((event) => event.split(/\r?\n/))
    .filter((line) => line.startsWith('data:') && line.slice(5).trim() !== '[DONE]')
    .map((line) => JSON.parse(line.slice(5)))
    .filter(
      (event) => event.type === 'response.output_item.done' && event.item.type === 'function_call'
    );
  assert.equal(toolItems.length, 1);
  assert.equal(toolItems[0].item.status, 'incomplete');
  for (const item of [
    rejection,
    early,
    cancel,
    requestAbort,
    downstreamError,
    slow,
    overflow,
    empty,
    timeout,
    truncated,
  ]) {
    const outcomes = item.events.filter((event) => event[0] === 'workbuddy_context_outcome');
    assert.equal(outcomes.length, 1, 'exactly one context terminal per request');
    assert.equal(outcomes[0][1].finalStatus, item.logs[0][3]);
    if (item.logs[0][3] >= 400) assert.equal(outcomes[0][1].finalOk, false);
  }
  process.stdout.write('workbuddy-responses-flow.test.js passed\n');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
