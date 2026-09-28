const assert = require('assert');

const {
  bufferFromResponseChunk,
  sendRequestTooLarge,
  appendAuditText,
  createConversationAuditData,
  captureAuditBody,
  installConversationAuditResponseCapture,
  recordAuditUpstreamFailure,
  applyAuditUpstreamFailure,
  sanitizeContextDiagnostics,
  contextDiagnosticsUsageSummary,
  sanitizeDiagnosticsMissingReason,
  populateAuditDataFromPrepared,
  extractPromptFromBuffer,
} = require('../lib/proxy/conversation-audit-utils');
const { createRequestTiming, markRequestTiming } = require('../lib/proxy/request-timing');
const {
  mergeUsage,
  usageFromSsePayload,
  extractUsageFromJsonPayload,
} = require('../lib/proxy/usage-report');

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
    // Use the production usage normalizers so this fixture cannot drift from the
    // camelCase shape that logUsage()/estimateCost() consume.
    mergeUsage,
    usageFromSsePayload,
    extractUsageFromJsonPayload,
    estimateUsageForRecord: () => ({
      inputTokens: 1,
      outputTokens: 2,
      cachedInputTokens: 0,
      totalTokens: 3,
      source: 'estimated',
    }),
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
  const privateBody = Buffer.from('private request text');
  const shouldNeverCapture = () => {
    throw new Error('disabled capture was called');
  };
  assert.deepStrictEqual(captureAuditBody(auditData, privateBody, null, shouldNeverCapture), {
    body: '',
    truncated: false,
  });
  assert.ok(
    !JSON.stringify(captureAuditBody(auditData, privateBody, null, shouldNeverCapture)).includes(
      'private'
    )
  );
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
  const auditData = createConversationAuditData({ id: 'content-enabled', captureContent: true });
  const body = Buffer.from('allowed audit text');
  assert.deepStrictEqual(
    captureAuditBody(auditData, body, 'utf8', (buffer, encoding) => ({
      body: buffer.toString(encoding),
      truncated: false,
      originalLength: buffer.length,
    })),
    { body: 'allowed audit text', truncated: false, originalLength: body.length }
  );
  assert.deepStrictEqual(
    captureAuditBody(auditData, Buffer.alloc(0), null, () => ({ body: '' })),
    {
      body: '',
      truncated: false,
    }
  );
  assert.deepStrictEqual(
    captureAuditBody(auditData, 'invalid buffer', null, () => ({})),
    {
      body: '',
      truncated: false,
    }
  );
  assert.deepStrictEqual(
    captureAuditBody(auditData, Buffer.alloc(0), null, () => ({})),
    {
      body: '',
      truncated: false,
    }
  );
  assert.deepStrictEqual(
    captureAuditBody(auditData, Buffer.alloc(1024 * 1024), null, () => {
      throw new Error('capture failure');
    }),
    { body: '', truncated: false }
  );
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
  const startedAt = Date.now();
  res.__requestTiming = createRequestTiming(startedAt);
  markRequestTiming(res.__requestTiming, 'upstreamHeaders', startedAt + 1);
  markRequestTiming(res.__requestTiming, 'firstUpstreamChunk', startedAt + 2);
  res.__auditData = {
    startTime: startedAt,
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
  assert.strictEqual(records[0].usage.inputTokens, 3);
  assert.strictEqual(records[0].responseHeaders.authorization, '[redacted]');
  assert.deepStrictEqual(usageLogs[0], {
    profileId: 'p1',
    model: 'gpt-target',
    inputTokens: 3,
    outputTokens: 4,
    cachedInputTokens: 0,
  });
  assert.strictEqual(records[0].timings.upstreamHeadersMs, 1);
  assert.strictEqual(records[0].timings.firstUpstreamChunkMs, 2);
  assert.ok(records[0].timings.firstClientByteMs >= 0);
  assert.strictEqual(records[0].timings.firstVisibleTextMs, null);
}

{
  const records = [];
  const usageLogs = [];
  const res = createWritableResponse();
  const startedAt = Date.now();
  res.__requestTiming = createRequestTiming(startedAt);
  markRequestTiming(res.__requestTiming, 'upstreamHeaders', startedAt + 1);
  markRequestTiming(res.__requestTiming, 'firstUpstreamChunk', startedAt + 2);
  res.__auditData = {
    startTime: startedAt,
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
  assert.strictEqual(records[0].usage.inputTokens, 5);
  assert.strictEqual(usageLogs[0].outputTokens, 6);
  assert.ok(records[0].timings.firstVisibleTextMs >= 0);
}

// Regression: Responses custom tools are emitted as custom_tool_call items, and
// some upstreams attach argument deltas by item_id only. The audit capture must
// preserve the custom input shape and avoid appending deltas to call index 0.
{
  const records = [];
  const usageLogs = [];
  const res = createWritableResponse();
  res.__auditData = {
    startTime: Date.now(),
    profileId: 'gemini-official',
    originalModel: 'gemini-client',
    rewriteModel: 'gemini-3.8-flash-tiered',
    response: { role: 'assistant', content: '', tool_calls: [] },
  };
  installConversationAuditResponseCapture(res, createAuditCaptureDeps(records, usageLogs));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(
    [
      'data: {"type":"response.output_item.added","item":{"id":"call_a","type":"custom_tool_call","name":"exec","input":{"language":"js","code":"return 1;"}}}',
      '',
      'data: {"type":"response.output_item.added","item":{"id":"call_b","type":"function_call","name":"lookup","arguments":""}}',
      '',
      'data: {"type":"response.function_call_arguments.delta","item_id":"call_b","delta":"{\\"q\\":\\"x\\"}"}',
      '',
    ].join('\n')
  );
  res.end('data: [DONE]\n\n');

  assert.deepStrictEqual(records[0].response.tool_calls, [
    {
      id: 'call_a',
      name: 'exec',
      args: { language: 'js', code: 'return 1;' },
      truncated: false,
    },
    { id: 'call_b', name: 'lookup', args: { q: 'x' }, truncated: false },
  ]);
}

// Regression: stream providers may send only output_item.done for a completed
// custom call. Auditing should still retain the call instead of losing it.
{
  const records = [];
  const usageLogs = [];
  const res = createWritableResponse();
  res.__auditData = {
    startTime: Date.now(),
    profileId: 'gemini-official',
    originalModel: 'gemini-client',
    rewriteModel: 'gemini-3.8-flash-tiered',
    response: { role: 'assistant', content: '', tool_calls: [] },
  };
  installConversationAuditResponseCapture(res, createAuditCaptureDeps(records, usageLogs));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(
    [
      'data: {"type":"response.output_item.done","item":{"id":"call_done","type":"custom_tool_call","name":"exec","input":"console.log(1)"}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
  );

  assert.deepStrictEqual(records[0].response.tool_calls, [
    { id: 'call_done', name: 'exec', args: { input: 'console.log(1)' }, truncated: false },
  ]);
}

// Regression: non-stream Responses JSON stores assistant text and tool calls in
// output[], not choices[].message. Capture both ordinary and custom tool calls.
{
  const records = [];
  const usageLogs = [];
  const res = createWritableResponse();
  res.__auditData = {
    startTime: Date.now(),
    profileId: 'openai-official',
    originalModel: 'gpt-client',
    rewriteModel: 'gpt-target',
    response: { role: 'assistant', content: '', tool_calls: [] },
  };
  installConversationAuditResponseCapture(res, createAuditCaptureDeps(records, usageLogs));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'done' }] },
        { id: 'call_1', type: 'function_call', name: 'lookup', arguments: '{"q":"x"}' },
        {
          id: 'call_2',
          type: 'custom_tool_call',
          name: 'exec',
          input: { language: 'js', code: 'return 5;' },
        },
      ],
      usage: { input_tokens: 7, output_tokens: 8 },
    })
  );

  assert.strictEqual(records[0].response.content, 'done');
  assert.deepStrictEqual(records[0].response.tool_calls, [
    { id: 'call_1', name: 'lookup', args: { q: 'x' } },
    { id: 'call_2', name: 'exec', args: { language: 'js', code: 'return 5;' } },
  ]);
  assert.strictEqual(records[0].usage.inputTokens, 7);
}

// Regression: usage-stats.jsonl recorded 0/0 for every request because logUsage()
// read snake_case fields off a camelCase object. Non-stream responses without
// provider usage must still emit the local estimate into the usage log.
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
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }));

  assert.strictEqual(records[0].usage.source, 'estimated');
  assert.strictEqual(usageLogs.length, 1);
  assert.deepStrictEqual(usageLogs[0], {
    profileId: 'p1',
    model: 'gpt-target',
    inputTokens: 1,
    outputTokens: 2,
    cachedInputTokens: 0,
  });
}

// Regression: official Responses streams terminate with response.completed; the
// SSE usage extractor previously only understood response.done, so provider usage
// was never captured and every audit record fell back to an estimate.
{
  const records = [];
  const usageLogs = [];
  const res = createWritableResponse();
  res.__auditData = {
    startTime: Date.now(),
    profileId: 'openai-official',
    originalModel: 'gpt-5.5',
    rewriteModel: 'gpt-5.5',
    response: { role: 'assistant', content: '', tool_calls: [] },
  };
  installConversationAuditResponseCapture(res, createAuditCaptureDeps(records, usageLogs));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(
    [
      'data: {"type":"response.output_text.delta","delta":"hi"}',
      '',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":222222,"output_tokens":33,"total_tokens":222255}}}',
      '',
    ].join('\n')
  );
  res.end('data: [DONE]\n\n');

  assert.deepStrictEqual(records[0].usage, {
    inputTokens: 222222,
    outputTokens: 33,
    cachedInputTokens: 0,
    totalTokens: 222255,
    source: 'provider',
  });
  assert.deepStrictEqual(usageLogs[0], {
    profileId: 'openai-official',
    model: 'gpt-5.5',
    inputTokens: 222222,
    outputTokens: 33,
    cachedInputTokens: 0,
  });
}

// Regression: provider cache-hit tokens must flow into the lightweight usage
// log, otherwise usage-stats summaries hide large Gemini/Responses cache hits.
{
  const records = [];
  const usageLogs = [];
  const res = createWritableResponse();
  res.__auditData = {
    startTime: Date.now(),
    profileId: 'gemini-official',
    originalModel: 'gemini-client',
    rewriteModel: 'gemini-3.8-flash-tiered',
    response: { role: 'assistant', content: '', tool_calls: [] },
  };
  installConversationAuditResponseCapture(res, createAuditCaptureDeps(records, usageLogs));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(
    [
      'data: {"type":"response.output_text.delta","delta":"hi"}',
      '',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":140000,"output_tokens":25,"cached_input_tokens":130000,"total_tokens":140025}}}',
      '',
    ].join('\n')
  );
  res.end('data: [DONE]\n\n');

  assert.deepStrictEqual(records[0].usage, {
    inputTokens: 140000,
    outputTokens: 25,
    cachedInputTokens: 130000,
    totalTokens: 140025,
    source: 'provider',
  });
  assert.deepStrictEqual(usageLogs[0], {
    profileId: 'gemini-official',
    model: 'gemini-3.8-flash-tiered',
    inputTokens: 140000,
    outputTokens: 25,
    cachedInputTokens: 130000,
  });
}

// response.incomplete carries usage the same way; both terminal types must be read.
{
  const incomplete = usageFromSsePayload({
    type: 'response.incomplete',
    response: { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  });
  assert.strictEqual(incomplete.inputTokens, 10);
  assert.strictEqual(incomplete.outputTokens, 2);
  assert.strictEqual(
    usageFromSsePayload({ type: 'response.completed', response: {} }),
    null,
    'missing usage must not fabricate tokens'
  );
  assert.strictEqual(usageFromSsePayload(null), null);
}

// Regression: SSE data lines arrive in arbitrary TCP chunks. Parsing each chunk in
// isolation threw on the split JSON and silently dropped provider usage, so every
// official Responses request fell back to the ~30000-token local estimate.
{
  const records = [];
  const usageLogs = [];
  const res = createWritableResponse();
  res.__auditData = {
    startTime: Date.now(),
    profileId: 'openai-official',
    originalModel: 'gpt-5.5',
    rewriteModel: 'gpt-5.5',
    response: { role: 'assistant', content: '', tool_calls: [] },
  };
  installConversationAuditResponseCapture(res, createAuditCaptureDeps(records, usageLogs));
  res.writeHead(200, { 'content-type': 'text/event-stream' });

  const frame =
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":231502,"output_tokens":129,"total_tokens":231631}}}\n\n';
  // Split in the middle of a JSON token, and again 7 chars before the newline.
  const cut = frame.indexOf('"input_tokens"') + 8;
  res.write(frame.slice(0, cut));
  res.write(frame.slice(cut, frame.length - 7));
  res.end(frame.slice(frame.length - 7));

  assert.strictEqual(records.length, 1);
  assert.strictEqual(
    records[0].usage.source,
    'provider',
    'split SSE frame must still yield provider usage, not an estimate'
  );
  assert.strictEqual(records[0].usage.inputTokens, 231502);
  assert.strictEqual(records[0].usage.outputTokens, 129);
  assert.deepStrictEqual(usageLogs[0], {
    profileId: 'openai-official',
    model: 'gpt-5.5',
    inputTokens: 231502,
    outputTokens: 129,
    cachedInputTokens: 0,
  });
}

// A final frame without a trailing newline must still be parsed, and a UTF-8
// character split across two chunks must not corrupt the decoded text.
{
  const records = [];
  const usageLogs = [];
  const res = createWritableResponse();
  res.__auditData = {
    startTime: Date.now(),
    profileId: 'openai-official',
    originalModel: 'gpt-5.5',
    rewriteModel: 'gpt-5.5',
    response: { role: 'assistant', content: '', tool_calls: [] },
  };
  installConversationAuditResponseCapture(res, createAuditCaptureDeps(records, usageLogs));
  res.writeHead(200, { 'content-type': 'text/event-stream' });

  const textEvent = Buffer.from('data: {"type":"response.output_text.delta","delta":"中文"}\n\n');
  const terminator = Buffer.from(
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":4321,"output_tokens":12,"total_tokens":4333}}}'
  );
  const splitAt = textEvent.indexOf(Buffer.from('中')) + 1;
  res.write(textEvent.subarray(0, splitAt));
  res.write(textEvent.subarray(splitAt));
  res.end(terminator);

  assert.strictEqual(records[0].usage.inputTokens, 4321);
  assert.strictEqual(records[0].usage.source, 'provider');
}

// Regression: official Codex/Responses upstreams answer with transfer-encoding:
// chunked and no content-type, so the content-type-only stream detection classified
// the response as JSON and discarded every SSE usage frame. The client accept
// intent (expectStream) must recover stream mode from the first SSE-looking chunk.
{
  const records = [];
  const usageLogs = [];
  const res = createWritableResponse();
  res.__auditData = {
    startTime: Date.now(),
    profileId: 'openai-official',
    originalModel: 'codex/gpt-5.5',
    rewriteModel: 'gpt-5.5',
    response: { role: 'assistant', content: '', tool_calls: [] },
  };
  const deps = createAuditCaptureDeps(records, usageLogs);
  installConversationAuditResponseCapture(res, { ...deps, expectStream: true });
  // Deliberately no content-type: exactly what the live upstream returned.
  res.writeHead(200, { 'transfer-encoding': 'chunked', server: 'cloudflare' });
  const frame =
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":98765,"output_tokens":432,"total_tokens":99197}}}\n\n';
  const cut = frame.indexOf('"input_tokens"') + 8;
  res.write(frame.slice(0, cut));
  res.end(frame.slice(cut) + 'data: [DONE]\n\n');

  assert.strictEqual(
    records[0].usage.source,
    'provider',
    'headerless chunked SSE must still be parsed as a stream'
  );
  assert.strictEqual(records[0].usage.inputTokens, 98765);
  assert.strictEqual(records[0].usage.outputTokens, 432);
  assert.deepStrictEqual(usageLogs[0], {
    profileId: 'openai-official',
    model: 'gpt-5.5',
    inputTokens: 98765,
    outputTokens: 432,
    cachedInputTokens: 0,
  });
}

// Guard the other direction: a JSON body must stay on the JSON path even when the
// client asked for a stream, otherwise a non-SSE error payload would be mangled.
{
  const records = [];
  const usageLogs = [];
  const res = createWritableResponse();
  res.__auditData = {
    startTime: Date.now(),
    profileId: 'p1',
    originalModel: 'm',
    rewriteModel: 'm',
    response: { role: 'assistant', content: '', tool_calls: [] },
  };
  const deps = createAuditCaptureDeps(records, usageLogs);
  installConversationAuditResponseCapture(res, { ...deps, expectStream: true });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ usage: { input_tokens: 77, output_tokens: 8 } }));

  assert.strictEqual(records[0].usage.source, 'provider');
  assert.strictEqual(records[0].usage.inputTokens, 77);
  // The JSON path buffers the raw body; the SSE path would have left it as sseContent.
  assert.strictEqual(
    records[0].response.body,
    JSON.stringify({ usage: { input_tokens: 77, output_tokens: 8 } })
  );
}

// Regression: an upstream that sends 200 headers and then times out mid-stream used to
// leave the audit record reporting success, because the audit writer samples
// clientRes.statusCode (still 200) while proxy-events.jsonl recorded a 502 for the
// same request. The failure registration must win.
{
  const records = [];
  const usageLogs = [];
  const res = createWritableResponse();
  res.__auditData = {
    startTime: Date.now(),
    profileId: 'openai-official',
    originalModel: 'gpt-5.5',
    rewriteModel: 'gpt-5.5',
    response: { role: 'assistant', content: '', tool_calls: [] },
  };
  installConversationAuditResponseCapture(res, createAuditCaptureDeps(records, usageLogs));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
  assert.strictEqual(
    recordAuditUpstreamFailure(res, {
      statusCode: 502,
      failureKind: 'upstream_timeout',
      errorType: 'proxy_error',
      type: 'proxy_error',
      error: 'Gateway Timeout (Upstream request timed out)',
    }),
    true
  );
  // A later observer must not overwrite the first outcome.
  assert.strictEqual(recordAuditUpstreamFailure(res, { statusCode: 500 }), false);
  res.end();

  assert.strictEqual(records[0].statusCode, 502, 'audit must not report the stale 200');
  assert.strictEqual(records[0].failureKind, 'upstream_timeout');
  assert.strictEqual(records[0].errorType, 'proxy_error');
  assert.match(records[0].error, /Gateway Timeout/);
}

// The happy path must stay untouched: no failure registered means the client status wins.
{
  const records = [];
  const usageLogs = [];
  const res = createWritableResponse();
  res.__auditData = {
    startTime: Date.now(),
    profileId: 'p1',
    originalModel: 'm',
    rewriteModel: 'm',
    response: { role: 'assistant', content: '', tool_calls: [] },
  };
  installConversationAuditResponseCapture(res, createAuditCaptureDeps(records, usageLogs));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ usage: { input_tokens: 5, output_tokens: 1 } }));
  assert.strictEqual(records[0].statusCode, 200);
  assert.strictEqual(records[0].failureKind, undefined);
  assert.strictEqual(records[0].error, undefined);
}

// recordAuditUpstreamFailure tolerates a response with no audit data attached.
assert.strictEqual(recordAuditUpstreamFailure(null, { statusCode: 502 }), false);
assert.strictEqual(recordAuditUpstreamFailure({}, { statusCode: 502 }), false);
// applyAuditUpstreamFailure is a no-op without a recorded failure.
assert.strictEqual(applyAuditUpstreamFailure(null), false);
assert.strictEqual(applyAuditUpstreamFailure({ statusCode: 200 }), false);

{
  const diagnostics = sanitizeContextDiagnostics({
    contextBudget: {
      enabled: true,
      policy: 'overflow-drop-oldest',
      source: 'configured',
      inputBudgetTokens: 1000,
      estimatedBeforeTokens: 1200,
      estimatedInputTokens: 900,
      fixedInputTokens: 100,
      overBudgetTokens: 0,
      optimizedCount: 2,
      droppedCount: 1,
      savedChars: 5000,
      prompt: 'private prompt must not appear',
      contextCache: {
        candidate: true,
        stablePrefixHash: 'abc123',
        stablePrefixTokens: 800,
        dynamicTokens: 100,
        privateText: 'secret',
      },
    },
    providerCache: {
      enabled: true,
      policy: 'diagnostics-only',
      provider: 'gemini',
      strategy: 'cached-content-resource',
      candidate: true,
      applied: false,
      reason: 'diagnostics-only',
      stablePrefixHash: 'abc123',
      stablePrefixTokens: 800,
      prompt: 'private provider prompt must not appear',
    },
    repairedOrphanToolResults: 1,
  });
  assert.strictEqual(diagnostics.contextBudget.enabled, true);
  assert.strictEqual(diagnostics.contextBudget.contextCache.stablePrefixHash, 'abc123');
  assert.strictEqual(diagnostics.providerCache.provider, 'gemini');
  assert.strictEqual(diagnostics.providerCache.strategy, 'cached-content-resource');
  assert.strictEqual(diagnostics.repairedOrphanToolResults, 1);
  assert.ok(!JSON.stringify(diagnostics).includes('private prompt'));
  assert.ok(!JSON.stringify(diagnostics).includes('private provider prompt'));
  assert.ok(!JSON.stringify(diagnostics).includes('secret'));
}

{
  const records = [];
  const usageLogs = [];
  const res = createWritableResponse();
  res.__auditData = {
    startTime: Date.now(),
    profileId: 'openai-official',
    originalModel: 'gpt-5.5',
    rewriteModel: 'gpt-5.5',
    response: { role: 'assistant', content: '', tool_calls: [] },
  };
  res.__diagnostics = {
    hpmDiagnostics: {
      contextBudget: {
        enabled: true,
        policy: 'overflow-drop-oldest',
        droppedCount: 3,
        optimizedCount: 2,
        overBudgetTokens: 1,
        prompt: 'private prompt must not appear',
        contextCache: { candidate: true, stablePrefixHash: 'hash-only' },
      },
      providerCache: {
        enabled: true,
        candidate: true,
        applied: true,
        prompt: 'private provider prompt must not appear',
      },
    },
  };
  installConversationAuditResponseCapture(res, createAuditCaptureDeps(records, usageLogs));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }));

  assert.strictEqual(records[0].contextDiagnostics.contextBudget.droppedCount, 3);
  assert.deepStrictEqual(usageLogs[0].context, {
    contextDiagnostics: true,
    contextDroppedCount: 3,
    contextOptimizedCount: 2,
    contextOverBudgetTokens: 1,
    contextStablePrefixCandidate: true,
    providerCacheCandidate: true,
    providerCacheApplied: true,
  });
  assert.ok(!JSON.stringify(usageLogs[0]).includes('private prompt'));
  assert.ok(!JSON.stringify(usageLogs[0]).includes('hash-only'));
}

{
  const records = [];
  const usageLogs = [];
  const res = createWritableResponse();
  res.__auditData = {
    startTime: Date.now(),
    profileId: 'openai-official',
    originalModel: 'gpt-5.5',
    rewriteModel: 'gpt-5.5',
    response: { role: 'assistant', content: '', tool_calls: [] },
  };
  res.__diagnostics = { contextDiagnosticsMissingReason: 'direct-responses-passthrough' };
  installConversationAuditResponseCapture(res, createAuditCaptureDeps(records, usageLogs));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }));

  assert.strictEqual(records[0].contextDiagnostics, null);
  assert.strictEqual(records[0].contextDiagnosticsMissingReason, 'direct-responses-passthrough');
  assert.deepStrictEqual(usageLogs[0].context, {
    contextDiagnostics: false,
    contextDroppedCount: 0,
    contextOptimizedCount: 0,
    contextOverBudgetTokens: 0,
    contextStablePrefixCandidate: false,
    providerCacheCandidate: false,
    providerCacheApplied: false,
  });
  assert.strictEqual(usageLogs[0].contextDiagnosticsMissingReason, 'direct-responses-passthrough');
}

assert.deepStrictEqual(contextDiagnosticsUsageSummary(null), {
  contextDiagnostics: false,
  contextDroppedCount: 0,
  contextOptimizedCount: 0,
  contextOverBudgetTokens: 0,
  contextStablePrefixCandidate: false,
  providerCacheCandidate: false,
  providerCacheApplied: false,
});
assert.strictEqual(
  sanitizeDiagnosticsMissingReason('direct-responses-passthrough'),
  'direct-responses-passthrough'
);
assert.strictEqual(sanitizeDiagnosticsMissingReason('private prompt'), 'unknown');

console.log('[conversation-audit-utils.test] ok');
