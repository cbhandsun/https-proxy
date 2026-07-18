const assert = require('assert');

const {
  bufferFromResponseChunk,
  sendRequestTooLarge,
  appendAuditText,
  createConversationAuditData,
  installConversationAuditResponseCapture,
  populateAuditDataFromPrepared,
  extractPromptFromBuffer,
} = require('../lib/proxy/conversation-audit-utils');

function createWritableResponse() {
  return {
    statusCode: 200,
    writes: [],
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    write(chunk) {
      this.writes.push(String(chunk));
    },
    end(chunk) {
      if (chunk) this.writes.push(String(chunk));
      this.ended = true;
    },
  };
}

function createAuditCaptureDeps(records, usageLogs) {
  return {
    maxCaptureBytes: 4096,
    maxTextChars: 32,
    redactHeaders: (headers) => ({
      ...headers,
      authorization: headers.authorization ? '[redacted]' : undefined,
    }),
    mergeUsage: (left, right) => ({ ...(left || {}), ...(right || {}) }),
    usageFromSsePayload: (payload) => payload.usage || null,
    extractUsageFromJsonPayload: (payload) => payload.usage || null,
    estimateUsageForRecord: () => ({ input_tokens: 1, output_tokens: 2 }),
    logUsage: (usage) => usageLogs.push(usage),
    estimateCost: () => ({ total: 0.001 }),
    appendAuditRecord: (record) => records.push(record),
    config: {},
    log: { error: (message) => records.push({ error: message }) },
    captureContent: true,
  };
}

{
  const auditData = createConversationAuditData({
    id: 'metadata-only',
    captureContent: false,
  });
  const auditRes = { __auditData: auditData };
  populateAuditDataFromPrepared(
    auditRes,
    {
      profile: { id: 'p1', protocol: 'openai' },
      model: 'm1',
      buffer: Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'private' }] })),
    },
    Buffer.alloc(0),
    {
      isGeminiProfile: () => false,
      isClaudeProfile: () => false,
    }
  );
  assert.deepStrictEqual(auditData.messages, []);
  assert.strictEqual(auditData.system, '');
  assert.ok(auditData.request.bodyBytes > 0);
}

{
  const auditData = createConversationAuditData({
    id: 'req-1',
    startTime: 123,
    method: 'POST',
    path: '/v1/messages',
    clientIp: '127.0.0.1',
    entryPort: 4443,
    entryProtocol: 'claude',
    requestHeaders: { authorization: 'Bearer secret', accept: 'application/json' },
    redactHeaders: (headers) => ({
      ...headers,
      authorization: headers.authorization ? '[redacted]' : undefined,
    }),
  });

  assert.strictEqual(auditData.id, 'req-1');
  assert.strictEqual(auditData.startTime, 123);
  assert.strictEqual(auditData.method, 'POST');
  assert.strictEqual(auditData.path, '/v1/messages');
  assert.strictEqual(auditData.clientIp, '127.0.0.1');
  assert.strictEqual(auditData.entryPort, 4443);
  assert.strictEqual(auditData.entryProtocol, 'claude');
  assert.strictEqual(auditData.request.headers.authorization, '[redacted]');
  assert.strictEqual(auditData.request.headers.accept, 'application/json');
  assert.deepStrictEqual(auditData.messages, []);
  assert.deepStrictEqual(auditData.upstream, {});
  assert.deepStrictEqual(auditData.response, {
    role: 'assistant',
    content: '',
    tool_calls: [],
  });
  assert.strictEqual(auditData.usage, null);
  assert.strictEqual(auditData.cost, null);
}

{
  assert.strictEqual(bufferFromResponseChunk(Buffer.from('abc')).toString(), 'abc');
  assert.strictEqual(bufferFromResponseChunk(new Uint8Array([97, 98])).toString(), 'ab');
  assert.strictEqual(bufferFromResponseChunk('caf\xe9', 'latin1').toString('latin1'), 'caf\xe9');
}

{
  assert.deepStrictEqual(appendAuditText('abc', '', 5), { value: 'abc', truncated: false });
  assert.deepStrictEqual(appendAuditText('abc', 'de', 5), { value: 'abcde', truncated: false });
  assert.deepStrictEqual(appendAuditText('abc', 'def', 5), { value: 'abcde', truncated: true });
  assert.deepStrictEqual(appendAuditText('abcde', 'x', 5), { value: 'abcde', truncated: true });
}

{
  const writes = [];
  const res = {
    headersSent: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      writes.push(body);
    },
  };
  sendRequestTooLarge({}, res, 123);
  assert.strictEqual(res.statusCode, 413);
  assert.strictEqual(res.headers['Content-Length'], Buffer.byteLength(writes[0]));
  assert.ok(JSON.parse(writes[0]).error.message.includes('123 bytes'));

  const sent = {
    headersSent: true,
    writeHead() {
      throw new Error('unexpected');
    },
    end() {},
  };
  sendRequestTooLarge({}, sent, 123);
}

{
  const gemini = extractPromptFromBuffer(
    Buffer.from(
      JSON.stringify({
        systemInstruction: { parts: [{ text: 'sys' }] },
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hello' }, { functionCall: { name: 'lookup', args: { q: 'x' } } }],
          },
          {
            role: 'model',
            parts: [{ functionResponse: { name: 'lookup', response: { ok: true } } }],
          },
        ],
      })
    ),
    'gemini'
  );
  assert.strictEqual(gemini.system, 'sys');
  assert.deepStrictEqual(gemini.messages[0], {
    role: 'user',
    content: 'hello',
    toolUses: [{ id: 'lookup', name: 'lookup', args: { q: 'x' } }],
    toolResults: [],
  });
  assert.deepStrictEqual(gemini.messages[1].toolResults, [
    { name: 'lookup', content: { ok: true } },
  ]);
}

{
  const openai = extractPromptFromBuffer(
    Buffer.from(
      JSON.stringify({
        messages: [
          { role: 'system', content: 'sys' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
            ],
          },
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_1',
                function: { name: 'lookup', arguments: '{"q":"x"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '42' },
        ],
      })
    ),
    'openai'
  );
  assert.strictEqual(openai.system, 'sys');
  assert.strictEqual(openai.messages[0].content, 'look[图片]');
  assert.deepStrictEqual(openai.messages[1].toolUses, [
    { id: 'call_1', name: 'lookup', args: { q: 'x' } },
  ]);
  assert.deepStrictEqual(openai.messages[2].toolResults, [{ id: 'call_1', content: '42' }]);
}

{
  const auditRes = { __auditData: { system: '', messages: [] } };
  populateAuditDataFromPrepared(
    auditRes,
    {
      model: 'client-model',
      rewriteTo: 'target-model',
      profile: { id: 'p1', name: 'Profile', protocol: 'gemini' },
      buffer: Buffer.from(
        JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
      ),
    },
    Buffer.alloc(0),
    {
      isGeminiProfile: (profile) => profile.protocol === 'gemini',
      isClaudeProfile: () => false,
    }
  );
  assert.strictEqual(auditRes.__auditData.originalModel, 'client-model');
  assert.strictEqual(auditRes.__auditData.rewriteModel, 'target-model');
  assert.strictEqual(auditRes.__auditData.profileId, 'p1');
  assert.strictEqual(auditRes.__auditData.profileName, 'Profile');
  assert.strictEqual(auditRes.__auditData.protocol, 'gemini');
  assert.strictEqual(auditRes.__auditData.messages[0].content, 'hi');
}

{
  const records = [];
  const usageLogs = [];
  const res = createWritableResponse();
  res.__auditData = {
    startTime: Date.now(),
    profileId: 'p1',
    originalModel: 'gpt-client',
    rewriteModel: 'gpt-target',
    response: { role: 'assistant', content: '', tool_calls: [] },
  };
  installConversationAuditResponseCapture(res, createAuditCaptureDeps(records, usageLogs));
  res.writeHead(200, { 'Content-Type': 'application/json', authorization: 'secret' });
  res.end(
    JSON.stringify({
      choices: [
        {
          message: {
            content: 'hello',
            tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
          },
        },
      ],
      usage: { input_tokens: 3, output_tokens: 4 },
    })
  );
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].response.content, 'hello');
  assert.deepStrictEqual(records[0].response.tool_calls, [
    { id: 'call_1', name: 'lookup', args: { q: 'x' } },
  ]);
  assert.strictEqual(records[0].usage.input_tokens, 3);
  assert.strictEqual(records[0].responseHeaders.authorization, '[redacted]');
  assert.deepStrictEqual(usageLogs[0], {
    profileId: 'p1',
    model: 'gpt-target',
    inputTokens: 3,
    outputTokens: 4,
  });
}

{
  const records = [];
  const usageLogs = [];
  const res = createWritableResponse();
  res.__auditData = {
    startTime: Date.now(),
    profileId: 'p1',
    originalModel: 'claude-client',
    rewriteModel: 'claude-target',
    response: { role: 'assistant', content: '', tool_calls: [] },
  };
  installConversationAuditResponseCapture(res, createAuditCaptureDeps(records, usageLogs));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(
    [
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup"}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"text":"hello"}}',
      '',
      'data: {"type":"content_block_delta","index":1,"delta":{"partial_json":"{\\"q\\":\\"x\\"}"}}',
      '',
      'data: {"usage":{"input_tokens":5,"output_tokens":6}}',
      '',
    ].join('\n')
  );
  res.end('data: [DONE]\n\n');
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].response.content, 'hello');
  assert.deepStrictEqual(records[0].response.tool_calls, [
    { id: 'toolu_1', name: 'lookup', args: { q: 'x' }, truncated: false },
  ]);
  assert.strictEqual(records[0].usage.input_tokens, 5);
  assert.strictEqual(usageLogs[0].outputTokens, 6);
}

console.log('[conversation-audit-utils.test] ok');
