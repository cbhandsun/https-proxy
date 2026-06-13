const assert = require('assert');
const { Readable } = require('stream');

const { createTraeStatusHandlers } = require('../lib/proxy/trae-status-handlers');

function invokeJsonManagementHandler(handler, body) {
  return new Promise((resolve) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    const res = {
      statusCode: 0,
      headers: null,
      writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers;
      },
      end(payload) {
        resolve({
          statusCode: this.statusCode,
          headers: this.headers,
          body: payload ? JSON.parse(payload) : null,
        });
      },
    };
    handler(req, res);
  });
}

function invokeRawManagementHandler(handler, chunks) {
  return new Promise((resolve) => {
    const req = Readable.from(chunks);
    const res = {
      statusCode: 0,
      headers: null,
      writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers;
      },
      end(payload) {
        resolve({
          statusCode: this.statusCode,
          headers: this.headers,
          body: payload ? JSON.parse(payload) : null,
        });
      },
    };
    handler(req, res);
  });
}

(async () => {
  const nativeHandlers = createTraeStatusHandlers({});
  const oversizedResponse = await invokeRawManagementHandler(
    nativeHandlers.handleLocalTraeDebugNativeDeepStartRequest,
    [Buffer.alloc(1024 * 1024 + 1)]
  );
  assert.strictEqual(oversizedResponse.statusCode, 400);
  assert.strictEqual(oversizedResponse.body.ok, false);
  assert.match(oversizedResponse.body.error, /Request body too large/);

  const calls = [];
  const selfTestHandlers = createTraeStatusHandlers({
    makeRequest: async () => {
      throw new Error('regular request should not be used for local Desktop gateway self-test');
    },
    makeClaudeSelfTestRequest: async (url, options, body) => {
      calls.push({ url, options, body: JSON.parse(body) });
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: [
          'event: message_start',
          'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[]}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"[Trae plan_item] 查看 git 状态\\n"}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"OK"}}',
          '',
          'event: message_stop',
          'data: {"type":"message_stop"}',
          '',
        ].join('\n'),
      };
    },
    getClaudeMessagesBaseUrl: () => 'https://localhost:3443/v1',
    getClaudeSelfTestTarget: () => ({
      source: 'claude-desktop-gateway',
      endpoint: 'https://localhost:3443/claude-desktop/v1/messages',
      headers: {
        Authorization: 'Bearer desktop-token',
        'anthropic-version': '2023-06-01',
      },
      model: 'claude-opus-4-8',
      expectedStyle: 'text',
    }),
  });

  const selfTestResponse = await invokeJsonManagementHandler(
    selfTestHandlers.handleLocalTraeDebugClaudeProcessSelfTestRequest,
    { prompt: '请只回复 OK。', max_tokens: '999999', timeoutMs: 'not-a-number' }
  );

  assert.strictEqual(selfTestResponse.statusCode, 200);
  assert.strictEqual(selfTestResponse.body.pass, true);
  assert.strictEqual(selfTestResponse.body.source, 'claude-desktop-gateway');
  assert.strictEqual(selfTestResponse.body.expectedStyle, 'text');
  assert.strictEqual(selfTestResponse.body.request.model, 'claude-opus-4-8');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://localhost:3443/claude-desktop/v1/messages');
  assert.strictEqual(calls[0].options.headers.Authorization, 'Bearer desktop-token');
  assert.strictEqual(calls[0].options.headers['anthropic-version'], '2023-06-01');
  assert.strictEqual(calls[0].options.timeout, 90000);
  assert.strictEqual(calls[0].body.model, 'claude-opus-4-8');
  assert.strictEqual(calls[0].body.max_tokens, 2000);
  assert.strictEqual(calls[0].body.stream, true);

  console.log('[trae-status-handlers.test] ok');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
