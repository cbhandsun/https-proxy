'use strict';
const assert = require('node:assert/strict');
const {
  describeTraeBridgeFailure,
  sanitizeTraeBridgeUrl,
} = require('../lib/proxy/trae-error-contract');
const { createTraeOfficialHandlers } = require('../lib/proxy/trae-official-handlers');
const sensitive = 'sensitive-token-cookie-user-content';
const configured = 'https://username:password@localhost:1234/custom?token=' + sensitive;
assert.equal(sanitizeTraeBridgeUrl(configured), 'https://localhost:1234/v1/chat');
assert.equal(
  sanitizeTraeBridgeUrl(configured, { stream: true }),
  'https://localhost:1234/v1/chat/stream'
);
for (const value of [
  null,
  {},
  [],
  {
    toString() {
      throw new Error(sensitive);
    },
  },
  'invalid',
  'file:///sensitive',
  'x'.repeat(10000),
])
  assert.equal(sanitizeTraeBridgeUrl(value), '');
for (const error of [
  null,
  undefined,
  sensitive,
  { message: sensitive },
  new Error(sensitive),
  {
    toString() {
      throw new Error(sensitive);
    },
  },
]) {
  const result = describeTraeBridgeFailure(error, configured);
  assert.equal(result.statusCode, 502);
  assert.equal(result.type, 'api_error');
  assert.ok(!JSON.stringify(result).includes(sensitive));
}
for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'])
  assert.equal(describeTraeBridgeFailure({ code, message: sensitive }, configured).statusCode, 503);
assert.equal(
  describeTraeBridgeFailure({ message: 'connect ECONNREFUSED' }, configured).statusCode,
  503
);
for (const statusCode of [400, 429, 500, 599])
  assert.equal(describeTraeBridgeFailure({ statusCode }, configured).statusCode, statusCode);
for (const statusCode of [200, 600, NaN, '429', true])
  assert.equal(describeTraeBridgeFailure({ statusCode }, configured).statusCode, 502);

async function main() {
  let failure = new Error(sensitive);
  let succeed = false;
  const logs = [];
  let captured;
  const writer = async () => {
    throw failure;
  };
  const api = createTraeOfficialHandlers({
    sendJsonError: (_res, status, payload) => {
      captured = { status, payload };
    },
    logRequestEnd: (...args) => logs.push(args),
    normalizeTraeOfficialModelName: () => 'fixture',
    buildTraeBridgePromptFromOpenAIChat: () => ({ prompt: 'fixture', images: [] }),
    openAIResponsesToChat: (body) => body,
    claudeMessagesToOpenAIChat: (body) => body,
    getTraeOfficialBridgeUrl: () => configured,
    callTraeOfficialBridge: async () => {
      if (succeed) return { text: 'ok', bridgeUrl: configured };
      throw failure;
    },
    writeTraeBridgeOpenAILiveStream: writer,
    writeTraeBridgeOpenAIResponsesLiveStream: writer,
    writeTraeBridgeClaudeLiveStream: writer,
    buildTraeBridgeOpenAIChatCompletion: () => ({ ok: true }),
  });
  const prepared = { model: 'fixture', rewriteTo: 'fixture', profile: { id: 'fixture' } };
  const clientReq = { method: 'POST', headers: {} };
  const malformed = { headersSent: false };
  assert.equal(
    api.parseTraeOfficialJsonBody(
      clientReq,
      malformed,
      Buffer.from('{"' + sensitive + '":oops}'),
      1,
      '/fixture',
      'fixture'
    ),
    null
  );
  assert.equal(captured.status, 400);
  assert.equal(captured.payload.error.message, 'Invalid JSON request body');
  for (const handler of [
    'handleTraeOfficialChatCompletion',
    'handleTraeOfficialResponses',
    'handleTraeOfficialClaudeMessages',
  ]) {
    for (const stream of [false, true]) {
      for (const headersSent of stream ? [false, true] : [false]) {
        captured = undefined;
        logs.length = 0;
        let wire = '',
          ended = false;
        const response = {
          headersSent,
          write: (data) => {
            wire += data;
            return true;
          },
          end: () => {
            ended = true;
          },
        };
        await api[handler](
          clientReq,
          response,
          Buffer.from(JSON.stringify({ model: 'fixture', messages: [], input: 'fixture', stream })),
          prepared,
          1,
          '/fixture'
        );
        assert.equal(logs.length, 1);
        assert.equal(logs[0][3], 502);
        assert.ok(!JSON.stringify({ captured, logs, wire }).includes(sensitive));
        assert.ok(!JSON.stringify({ captured, logs, wire }).includes('password'));
        if (headersSent) {
          assert.equal(ended, true);
          assert.ok(wire.includes('event: error'));
        } else assert.equal(captured.status, 502);
      }
    }
  }
  failure = Object.assign(new Error(sensitive), {
    code: 'ECONNREFUSED',
    bridgeUrl: 'https://evil.invalid/?token=' + sensitive,
  });
  await api.handleTraeOfficialChatCompletion(
    clientReq,
    {},
    Buffer.from('{"messages":[]}'),
    prepared,
    1,
    '/fixture'
  );
  assert.equal(captured.status, 503);
  assert.equal(captured.payload.error.bridge_url, 'https://localhost:1234/v1/chat');
  let destroyed = 0;
  await api.handleTraeOfficialChatCompletion(
    clientReq,
    {
      headersSent: true,
      write() {
        throw new Error(sensitive);
      },
      destroy() {
        destroyed++;
      },
    },
    Buffer.from('{"stream":true}'),
    prepared,
    1,
    '/fixture'
  );
  assert.equal(destroyed, 1);
  succeed = true;
  const response = { writeHead() {}, end() {} };
  await api.handleTraeOfficialChatCompletion(
    clientReq,
    response,
    Buffer.from('{"messages":[]}'),
    prepared,
    1,
    '/fixture'
  );
  assert.equal(response.__diagnostics.bridgeUrl, 'https://localhost:1234/v1/chat');
}
main().catch((error) => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
