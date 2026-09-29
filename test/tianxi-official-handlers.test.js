'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createTianxiOfficialHandlers } = require('../lib/proxy/tianxi-official-handlers');

function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    headersSent: false,
    extraHeaders: {},
    setHeader(name, value) {
      assert.equal(this.headersSent, false);
      this.extraHeaders[name] = value;
    },
    body: '',
    ended: false,
    writeHead(statusCode, headers) {
      assert.equal(this.headersSent, false);
      this.statusCode = statusCode;
      this.headers = headers;
      this.headersSent = true;
    },
    write(chunk) {
      this.body += String(chunk);
    },
    end(chunk) {
      if (chunk) this.body += String(chunk);
      this.ended = true;
    },
  };
}

(async () => {
  let bridgePayload = null;
  const handlers = createTianxiOfficialHandlers({
    sendJsonError() {
      throw new Error('unexpected sendJsonError');
    },
    logRequestEnd() {},
    openAIResponsesToChat() {
      return { messages: [{ role: 'user', content: 'hello' }] };
    },
    callTianxiOfficialBridge(payload) {
      bridgePayload = payload;
      return Promise.resolve({
        bridgeUrl: 'tianxi://test',
        frames: [
          { type: 'task_output', data: { content_type: 'text', content: 'ok' } },
          { type: 'task_status', data: { status: 'COMPLETED' } },
        ],
      });
    },
    fallbackId: () => 'resp_test',
    stableCreated: () => 123,
  });

  const res = fakeRes();
  await handlers.handleTianxiOfficialResponses(
    { headers: {}, method: 'POST' },
    res,
    Buffer.from(JSON.stringify({ model: 'tianxi/chat', input: 'hello' })),
    {
      model: 'tianxi/chat',
      rewriteTo: 'chat',
      profile: { id: 'tianxi-official' },
      route: {
        from: 'tianxi/chat',
        to: 'chat',
        tianxiAgentId: 'chat',
        tianxiLlm: 'chat',
      },
    },
    Date.now(),
    '/v1/responses'
  );

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).status, 'completed');
  assert.equal(bridgePayload.model, 'chat');
  assert.deepEqual(bridgePayload.metadata.tianxi, { agent_id: 'chat', llm: 'chat' });

  const fallbackRes = fakeRes();
  bridgePayload = null;
  await handlers.handleTianxiOfficialResponses(
    { headers: {}, method: 'POST' },
    fallbackRes,
    Buffer.from(JSON.stringify({ model: 'tianxi/super', input: 'hello' })),
    {
      model: 'tianxi/super',
      rewriteTo: 'super',
      profile: { id: 'tianxi-official' },
      route: {
        from: 'tianxi/super',
        to: 'super',
      },
    },
    Date.now(),
    '/v1/responses'
  );

  assert.equal(fallbackRes.statusCode, 200);
  assert.equal(bridgePayload.model, 'super');
  assert.deepEqual(bridgePayload.metadata.tianxi, { agent_id: 'super' });

  let invalidBodyBridgeCalled = false;
  let invalidBodyError;
  const invalidBodyHandlers = createTianxiOfficialHandlers({
    sendJsonError(response, statusCode, payload) {
      invalidBodyError = { statusCode, payload };
      response.writeHead(statusCode, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    },
    logRequestEnd() {},
    openAIResponsesToChat() {
      return { messages: [] };
    },
    callTianxiOfficialBridge() {
      invalidBodyBridgeCalled = true;
      throw new Error('invalid root request reached native bridge');
    },
  });
  for (const invalidRoot of [null, [], 42, 'hello']) {
    const invalidBodyRes = fakeRes();
    invalidBodyError = null;
    await invalidBodyHandlers.handleTianxiOfficialResponses(
      { headers: {}, method: 'POST' },
      invalidBodyRes,
      Buffer.from(JSON.stringify(invalidRoot)),
      { model: 'tianxi/super', rewriteTo: 'super', profile: { id: 'tianxi-official' } },
      Date.now(),
      '/v1/responses'
    );
    assert.equal(invalidBodyRes.ended, true);
    assert.equal(invalidBodyError.statusCode, 400);
    assert.equal(invalidBodyError.payload.error.code, 'tianxi_request_body_invalid');
  }
  assert.equal(invalidBodyBridgeCalled, false);

  let unsupportedError;
  let unsupportedBridgeCalled = false;
  const unsupportedHandlers = createTianxiOfficialHandlers({
    sendJsonError(response, statusCode, payload) {
      unsupportedError = { statusCode, payload };
      response.writeHead(statusCode, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    },
    logRequestEnd() {},
    openAIResponsesToChat() {
      return { messages: [] };
    },
    callTianxiOfficialBridge() {
      unsupportedBridgeCalled = true;
      throw new Error('unsupported tool request reached native bridge');
    },
  });
  for (const input of [
    { tools: [{ type: 'function', name: 'read_file' }], tool_choice: 'required' },
    { tools: [], tool_choice: 'required' },
    { input: [{ type: 'function_call_output', call_id: 'call_1', output: 'private' }] },
  ]) {
    unsupportedError = null;
    await unsupportedHandlers.handleTianxiOfficialResponses(
      { headers: {}, method: 'POST' },
      fakeRes(),
      Buffer.from(JSON.stringify({ model: 'tianxi/super', input: 'hello', ...input })),
      { model: 'tianxi/super', rewriteTo: 'super', profile: { id: 'tianxi-official' } },
      Date.now(),
      '/v1/responses'
    );
    assert.equal(unsupportedError.statusCode, 422);
    assert.equal(unsupportedError.payload.error.code, 'tianxi_tool_bridge_unsupported');
    assert.ok(!JSON.stringify(unsupportedError).includes('private'));
  }
  assert.equal(unsupportedBridgeCalled, false);

  const unsupportedMediaStream = fakeRes();
  await unsupportedHandlers.handleTianxiOfficialResponses(
    { headers: {}, method: 'POST' },
    unsupportedMediaStream,
    Buffer.from(
      JSON.stringify({
        model: 'tianxi/super',
        stream: true,
        input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'private-media' }] }],
      })
    ),
    { model: 'tianxi/super', rewriteTo: 'super', profile: { id: 'tianxi-official' } },
    Date.now(),
    '/v1/responses'
  );
  assert.equal(unsupportedMediaStream.statusCode, 200);
  assert.ok(unsupportedMediaStream.body.includes('event: response.failed'));
  assert.ok(unsupportedMediaStream.body.includes('tianxi_input_media_unsupported'));
  assert.ok(unsupportedMediaStream.body.endsWith('data: [DONE]\n\n'));
  assert.ok(!unsupportedMediaStream.body.includes('private-media'));
  assert.equal(unsupportedBridgeCalled, false);

  unsupportedError = null;
  await unsupportedHandlers.handleTianxiOfficialResponses(
    { headers: {}, method: 'POST' },
    fakeRes(),
    Buffer.from(
      JSON.stringify({
        model: 'tianxi/super',
        input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'private-media' }] }],
      })
    ),
    { model: 'tianxi/super', rewriteTo: 'super', profile: { id: 'tianxi-official' } },
    Date.now(),
    '/v1/responses'
  );
  assert.equal(unsupportedError.statusCode, 422);
  assert.equal(unsupportedError.payload.error.code, 'tianxi_input_media_unsupported');
  assert.equal(unsupportedError.payload.error.param, 'input');
  assert.ok(!JSON.stringify(unsupportedError).includes('private-media'));
  assert.equal(unsupportedBridgeCalled, false);

  const previousInputs = [];
  const historyHandlers = createTianxiOfficialHandlers({
    sendJsonError(response, statusCode, payload) {
      response.writeHead(statusCode, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    },
    logRequestEnd() {},
    openAIResponsesToChat: () => ({ messages: [] }),
    callTianxiOfficialBridge(payload) {
      previousInputs.push(payload.input);
      return Promise.resolve({
        bridgeUrl: 'tianxi://test',
        frames: [
          {
            type: 'task_output',
            data: {
              content_type: 'text',
              content: previousInputs.length === 1 ? 'remembered' : 'ALPHA7382',
            },
          },
          { type: 'task_status', data: { status: 'COMPLETED' } },
        ],
      });
    },
  });
  const prepared = {
    model: 'tianxi/super',
    rewriteTo: 'super',
    profile: { id: 'tianxi-official' },
    route: { from: 'tianxi/super', to: 'super' },
  };
  const ownerReq = { headers: {}, method: 'POST', entryAuth: { key: { id: 'owner-a' } } };
  const firstRes = fakeRes();
  await historyHandlers.handleTianxiOfficialResponses(
    ownerReq,
    firstRes,
    Buffer.from(JSON.stringify({ model: 'tianxi/super', input: 'remember ALPHA7382' })),
    prepared,
    Date.now(),
    '/v1/responses'
  );
  const firstId = JSON.parse(firstRes.body).id;
  assert.match(firstId, /^resp_[0-9a-f]{32}$/);
  const secondRes = fakeRes();
  await historyHandlers.handleTianxiOfficialResponses(
    ownerReq,
    secondRes,
    Buffer.from(
      JSON.stringify({
        model: 'tianxi/super',
        input: 'what was it?',
        previous_response_id: firstId,
      })
    ),
    prepared,
    Date.now(),
    '/v1/responses'
  );
  assert.equal(secondRes.statusCode, 200);
  assert.notEqual(JSON.parse(secondRes.body).id, firstId);
  assert.ok(previousInputs[1].includes('remember ALPHA7382'));
  assert.ok(previousInputs[1].includes('remembered'));
  assert.ok(previousInputs[1].includes('what was it?'));
  assert.equal(JSON.parse(secondRes.body).usage, null);

  const untrackedRes = fakeRes();
  await historyHandlers.handleTianxiOfficialResponses(
    ownerReq,
    untrackedRes,
    Buffer.from(JSON.stringify({ model: 'tianxi/super', input: 'private turn', store: false })),
    prepared,
    Date.now(),
    '/v1/responses'
  );
  assert.equal(untrackedRes.statusCode, 200);
  const untrackedId = JSON.parse(untrackedRes.body).id;
  const untrackedContinuation = fakeRes();
  await historyHandlers.handleTianxiOfficialResponses(
    ownerReq,
    untrackedContinuation,
    Buffer.from(
      JSON.stringify({
        model: 'tianxi/super',
        input: 'continue',
        previous_response_id: untrackedId,
      })
    ),
    prepared,
    Date.now(),
    '/v1/responses'
  );
  assert.equal(untrackedContinuation.statusCode, 404);

  for (const [id, req, expectedStatus] of [
    ['bad-id', ownerReq, 400],
    ['resp_' + '0'.repeat(32), ownerReq, 404],
    [firstId, { ...ownerReq, entryAuth: { key: { id: 'owner-b' } } }, 404],
  ]) {
    const rejectedRes = fakeRes();
    await historyHandlers.handleTianxiOfficialResponses(
      req,
      rejectedRes,
      Buffer.from(JSON.stringify({ model: 'tianxi/super', input: 'x', previous_response_id: id })),
      prepared,
      Date.now(),
      '/v1/responses'
    );
    assert.equal(rejectedRes.statusCode, expectedStatus);
  }

  let nativeReadPayload;
  const nativeReadHandlers = createTianxiOfficialHandlers({
    sendJsonError() {
      throw new Error('native read request was rejected');
    },
    logRequestEnd() {},
    openAIResponsesToChat() {
      return { messages: [] };
    },
    resolveTianxiNativeReadTools: () => ({
      cwd: 'E:\\Project',
      allowedTools: ['Read', 'Glob', 'Grep'],
      disallowedTools: ['Write', 'Edit', 'Bash'],
      permissionMode: 'default',
    }),
    callTianxiOfficialBridge(payload) {
      nativeReadPayload = payload;
      return Promise.resolve({
        bridgeUrl: 'tianxi://test',
        frames: [
          {
            type: 'act_exec',
            data: { exec_mode: 'cli', actions: [{ id: 'read_1', name: 'Read' }] },
          },
          { type: 'act_resp', data: { actions: [{ id: 'read_1', result: 'private' }] } },
          { type: 'task_output', data: { content_type: 'text', content: 'Project summary' } },
          { type: 'task_status', data: { status: 'COMPLETED' } },
        ],
      });
    },
    fallbackId: () => 'resp_native_read',
    stableCreated: () => 123,
  });
  const nativeReadRes = fakeRes();
  await nativeReadHandlers.handleTianxiOfficialResponses(
    { headers: {}, method: 'POST' },
    nativeReadRes,
    Buffer.from(
      JSON.stringify({
        model: 'tianxi/super',
        input: 'Inspect the project',
        tools: [{ type: 'function', name: 'inspect_project' }],
        tool_choice: 'auto',
      })
    ),
    {
      model: 'tianxi/super',
      rewriteTo: 'super',
      profile: { id: 'tianxi-official', tianxiNativeReadTools: true },
      route: { from: 'tianxi/super', to: 'super' },
    },
    Date.now(),
    '/v1/responses'
  );
  assert.equal(nativeReadRes.statusCode, 200);
  assert.equal(nativeReadPayload.metadata.tianxi.cwd, 'E:\\Project');
  assert.deepEqual(nativeReadPayload.metadata.tianxi.allowedTools, ['Read', 'Glob', 'Grep']);
  assert.deepEqual(
    JSON.parse(nativeReadRes.body).output.map((item) => item.type),
    ['reasoning', 'message']
  );
  assert.ok(!nativeReadRes.body.includes('private'));

  const nativeReadStream = fakeRes();
  await nativeReadHandlers.handleTianxiOfficialResponses(
    { headers: {}, method: 'POST' },
    nativeReadStream,
    Buffer.from(JSON.stringify({ model: 'tianxi/super', input: 'Inspect', stream: true })),
    {
      model: 'tianxi/super',
      rewriteTo: 'super',
      profile: { id: 'tianxi-official', tianxiNativeReadTools: true },
    },
    Date.now(),
    '/v1/responses'
  );
  assert.equal(nativeReadStream.extraHeaders['X-Tianxi-Tool-Mode'], 'native-read-only');
  assert.ok(nativeReadStream.body.includes('event: response.completed'));

  const cancellation = new EventEmitter();
  const cancelledRes = fakeRes();
  cancelledRes.on = cancellation.on.bind(cancellation);
  cancelledRes.off = cancellation.off.bind(cancellation);
  let upstreamCancelled = false;
  const cancellationHandlers = createTianxiOfficialHandlers({
    sendJsonError() {
      throw new Error('closed client received an error response');
    },
    logRequestEnd() {},
    openAIResponsesToChat: () => ({ messages: [] }),
    callTianxiOfficialBridge(_payload, _profile, context) {
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener('abort', () => {
          upstreamCancelled = true;
          reject(new Error('aborted'));
        });
      });
    },
  });
  const cancelledCall = cancellationHandlers.handleTianxiOfficialResponses(
    { headers: {}, method: 'POST' },
    cancelledRes,
    Buffer.from(JSON.stringify({ model: 'tianxi/super', input: 'hello' })),
    prepared,
    Date.now(),
    '/v1/responses'
  );
  cancelledRes.destroyed = true;
  cancellation.emit('close');
  await cancelledCall;
  assert.equal(upstreamCancelled, true);
  assert.equal(cancelledRes.ended, false);

  let capturedError = null;
  const errorHandlers = createTianxiOfficialHandlers({
    sendJsonError(_clientRes, statusCode, payload) {
      capturedError = { statusCode, payload };
      _clientRes.writeHead(statusCode, { 'content-type': 'application/json' });
      _clientRes.end(JSON.stringify(payload));
    },
    logRequestEnd() {},
    openAIResponsesToChat() {
      return { messages: [{ role: 'user', content: 'hello' }] };
    },
    callTianxiOfficialBridge() {
      const err = new Error('Authorization: Bearer sat-secret-token ' + 'a'.repeat(140));
      err.diagnostics = {
        cause_code: 'PIPE_FAILED',
        cause_message: 'Authorization: Bearer sat-secret-token ' + 'a'.repeat(140),
      };
      return Promise.reject(err);
    },
    fallbackId: () => 'resp_test',
    stableCreated: () => 123,
  });
  const errorRes = fakeRes();
  await errorHandlers.handleTianxiOfficialResponses(
    { headers: {}, method: 'POST' },
    errorRes,
    Buffer.from(JSON.stringify({ model: 'tianxi/super', input: 'hello' })),
    {
      model: 'tianxi/super',
      rewriteTo: 'super',
      profile: { id: 'tianxi-official' },
      route: { from: 'tianxi/super', to: 'super' },
    },
    Date.now(),
    '/v1/responses'
  );
  assert.equal(capturedError.statusCode, 502);
  const serializedError = JSON.stringify(capturedError.payload);
  assert.equal(capturedError.payload.error.message, 'Tianxi bridge request failed.');
  assert.equal(capturedError.payload.error.diagnostics.cause_code, 'PIPE_FAILED');
  assert.equal(serializedError.includes('sat-secret-token'), false);
  assert.equal(serializedError.includes('Authorization: Bearer'), false);
  assert.equal(serializedError.includes('a'.repeat(140)), false);

  const streamLogs = [];
  const streamHandlers = createTianxiOfficialHandlers({
    sendJsonError() {
      throw new Error('stream failure must remain SSE');
    },
    logRequestEnd(_method, _path, _start, status, details) {
      streamLogs.push({ status, details });
    },
    openAIResponsesToChat: () => ({ messages: [] }),
    callTianxiOfficialBridge() {
      const error = new Error('tianxi_native_runtime_failed');
      error.diagnostics = { cause_message: 'tianxi_tac_server_idle_timeout' };
      return Promise.reject(error);
    },
  });
  const failedStream = fakeRes();
  await streamHandlers.handleTianxiOfficialResponses(
    ownerReq,
    failedStream,
    Buffer.from(JSON.stringify({ model: 'tianxi/super', input: 'hello', stream: true })),
    prepared,
    Date.now(),
    '/v1/responses'
  );
  assert.equal(failedStream.statusCode, 200);
  assert.match(failedStream.body, /^event: response.created\n/);
  assert.equal((failedStream.body.match(/event: response.failed/g) || []).length, 1);
  assert.ok(failedStream.body.endsWith('data: [DONE]\n\n'));
  assert.equal(streamLogs[0].details.causeCode, 'tianxi_tac_server_idle_timeout');
  assert.ok(!failedStream.body.includes('cause_message'));

  const partialFailureLogs = [];
  const partialFailureHandlers = createTianxiOfficialHandlers({
    sendJsonError() {
      throw new Error('partial stream failure must remain SSE');
    },
    logRequestEnd(_method, _path, _start, status, details) {
      partialFailureLogs.push({ status, details });
    },
    openAIResponsesToChat: () => ({ messages: [] }),
    callTianxiOfficialBridge(_payload, _profile, context) {
      context.onFrame({
        type: 'task_output',
        data: { reasoning_content: 'Inspecting project structure.' },
      });
      const error = new Error('tianxi_native_runtime_timeout');
      error.code = 'tianxi_native_runtime_timeout';
      return Promise.reject(error);
    },
  });
  const partialFailedStream = fakeRes();
  await partialFailureHandlers.handleTianxiOfficialResponses(
    ownerReq,
    partialFailedStream,
    Buffer.from(JSON.stringify({ model: 'tianxi/super', input: 'hello', stream: true })),
    prepared,
    Date.now(),
    '/v1/responses'
  );
  assert.equal(partialFailedStream.statusCode, 200);
  assert.equal((partialFailedStream.body.match(/event: response.incomplete/g) || []).length, 1);
  assert.equal((partialFailedStream.body.match(/event: response.failed/g) || []).length, 0);
  assert.ok(partialFailedStream.body.includes('response.reasoning.delta'));
  assert.ok(!partialFailedStream.body.includes('Tianxi native request failed'));
  assert.ok(partialFailedStream.body.endsWith('data: [DONE]\n\n'));
  assert.equal(
    partialFailureLogs[0].details.type,
    'tianxi_official_responses_bridge_stream_incomplete'
  );
  assert.equal(partialFailureLogs[0].details.causeCode, 'tianxi_native_runtime_timeout');

  const successStream = fakeRes();
  await handlers.handleTianxiOfficialResponses(
    ownerReq,
    successStream,
    Buffer.from(JSON.stringify({ model: 'tianxi/super', input: 'hello', stream: true })),
    prepared,
    Date.now(),
    '/v1/responses'
  );
  assert.equal(successStream.statusCode, 200);
  assert.equal((successStream.body.match(/event: response.completed/g) || []).length, 1);
  assert.ok(successStream.body.endsWith('data: [DONE]\n\n'));

  let releaseLiveBridge;
  let liveProgressObserved = false;
  const liveHandlers = createTianxiOfficialHandlers({
    sendJsonError() {
      throw new Error('live stream unexpectedly failed');
    },
    logRequestEnd() {},
    openAIResponsesToChat: () => ({ messages: [] }),
    callTianxiOfficialBridge(_payload, _profile, context) {
      context.onFrame({
        type: 'task_output',
        data: { reasoning_content: 'Inspecting project structure.' },
      });
      context.onFrame({
        type: 'act_exec',
        data: { exec_mode: 'cli', actions: [{ id: 'read_live', name: 'Read' }] },
      });
      liveProgressObserved = true;
      return new Promise((resolve) => {
        releaseLiveBridge = () => {
          context.onFrame({
            type: 'act_resp',
            data: { actions: [{ id: 'read_live', result: 'private' }] },
          });
          context.onFrame({ type: 'task_output', data: { content_type: 'text', content: 'Done' } });
          context.onFrame({ type: 'task_status', data: { status: 'COMPLETED' } });
          resolve({
            bridgeUrl: 'tianxi://test',
            frames: [
              {
                type: 'task_output',
                data: { reasoning_content: 'Inspecting project structure.' },
              },
              {
                type: 'act_exec',
                data: { exec_mode: 'cli', actions: [{ id: 'read_live', name: 'Read' }] },
              },
              { type: 'act_resp', data: { actions: [{ id: 'read_live', result: 'private' }] } },
              { type: 'task_output', data: { content_type: 'text', content: 'Done' } },
              { type: 'task_status', data: { status: 'COMPLETED' } },
            ],
          });
        };
      });
    },
  });
  const liveRes = fakeRes();
  const liveCall = liveHandlers.handleTianxiOfficialResponses(
    ownerReq,
    liveRes,
    Buffer.from(JSON.stringify({ model: 'tianxi/super', input: 'inspect', stream: true })),
    prepared,
    Date.now(),
    '/v1/responses'
  );
  await Promise.resolve();
  assert.equal(liveProgressObserved, true);
  assert.ok(liveRes.body.includes('Inspecting project structure.'));
  assert.ok(liveRes.body.includes('Using Read.'));
  assert.equal(liveRes.ended, false);
  releaseLiveBridge();
  await liveCall;
  assert.ok(liveRes.body.includes('event: response.completed'));
  assert.ok(!liveRes.body.includes('private'));

  console.log('[tianxi-official-handlers.test] ok');
})();
