'use strict';

const assert = require('assert');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { checkpointPayload, EVIDENCE_MARKER } = require('../lib/proxy/context-checkpoint');

const {
  createOpenAIResponsesToChatHandler,
} = require('../lib/proxy/handlers/responses-to-chat-handler');

async function main() {
  async function waitForCompletion(completed, label) {
    const deadline = Date.now() + 2000;
    while (!completed()) {
      assert.ok(Date.now() < deadline, `${label} did not complete`);
      await nextTurn();
    }
  }
  const calls = [];
  const events = [];
  let converted = null;

  const fakeTransport = {
    request(options, callback) {
      calls.push(options);
      const first = calls.length === 1;
      const proxyRes = {
        statusCode: first ? 401 : 200,
        headers: first ? { 'x-request-id': 'first-401' } : {},
        body: first
          ? '<html><head><title>401 Authorization Required</title></head></html>'
          : JSON.stringify({ id: 'chatcmpl-ok', choices: [{ message: { content: 'ok' } }] }),
      };
      process.nextTick(() => callback(proxyRes));
      return {
        on() {
          return this;
        },
        end() {},
      };
    },
  };

  const handler = createOpenAIResponsesToChatHandler(
    {
      http: fakeTransport,
      https: fakeTransport,
      CORS_HEADERS: {},
      collectBoundedResponse(proxyRes, _clientRes, _upstreamPath, _type, onComplete) {
        onComplete(proxyRes.body);
      },
      createChatToResponsesBridge() {
        throw new Error('stream path should not be used');
      },
      logProxyEvent(type, payload) {
        events.push({ type, payload });
      },
      logRequestEnd() {},
      maxConversionResponseBytes: 1024 * 1024,
      onProxyError() {
        return () => {};
      },
      onProxyTimeout() {
        return () => {};
      },
      openAIChatToResponses(chatPayload) {
        return { id: 'resp-ok', output_text: chatPayload.choices[0].message.content };
      },
      parseJsonOrSseJson: JSON.parse,
      parseProxyBody() {
        return { model: 'workbuddy/deepseek-v4.1-flash', input: 'ping' };
      },
      processOpenAIChatSseChunkToResponses() {},
      protocolOptions: { workbuddyAuthRefreshTimeoutMs: 5, workbuddyAuthRefreshIntervalMs: 1 },
      readWorkBuddyAuthInfo() {
        return {
          accessToken: 'eyJ.fresh',
          refreshToken: 'refresh-secret',
          uid: 'uid-fresh',
          uin: 'uin-fresh',
        };
      },
      refreshWorkBuddyOfficialAuth() {
        return Promise.resolve({
          status: 'refreshed',
          triggerStatus: 'started',
          before: { found: true, hasAccessToken: true, tokenShapeOk: false },
          after: { found: true, hasAccessToken: true, tokenShapeOk: true },
        });
      },
      rejectUnsupportedResponsesConversion() {
        return false;
      },
      rememberResponsesFromChatResponse() {},
      responsesToChatWithHistory() {
        return { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'ping' }] };
      },
      sendJsonError() {
        throw new Error('sendJsonError should not be used');
      },
      upstreamRequestOptions(_target, path, headers) {
        return { path, headers };
      },
      writeJsonResponse(_clientRes, status, body) {
        converted = { status, body };
      },
    },
    {
      boundedResponseContext() {
        return {};
      },
      handleConvertedJsonResponse(options) {
        if (options.proxyRes.statusCode < 200 || options.proxyRes.statusCode >= 300) {
          throw new Error('first 401 should be retried before conversion handling');
        }
        converted = { status: 200, body: options.convert(options.responseBody) };
      },
      proxyErrorContext() {
        return {};
      },
    }
  );

  handler(
    { method: 'POST', headers: {} },
    { headersSent: false },
    {
      authProvider: 'workbuddy',
      buffer: Buffer.from('{}'),
      profile: { protocol: 'openai' },
      rewriteTo: 'deepseek-v4.1-flash',
      workbuddyAuth: { accessToken: 'opaque-old', uid: 'uid-old' },
    },
    { protocol: 'http:', path: '/v2', hostname: 'copilot.tencent.com' },
    'opaque-old',
    '/v1/responses',
    Date.now()
  );

  await waitForCompletion(() => converted !== null, 'auth refresh retry');

  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].headers.authorization, 'Bearer opaque-old');
  assert.strictEqual(calls[1].headers.authorization, 'Bearer eyJ.fresh');
  assert.strictEqual(converted.status, 200);
  assert.deepStrictEqual(converted.body, { id: 'resp-ok', output_text: 'ok' });
  assert.ok(events.some((event) => event.type === 'workbuddy_auth_refresh'));
  assert.ok(!JSON.stringify(events).includes('eyJ.fresh'));
  assert.ok(!JSON.stringify(events).includes('opaque-old'));

  const timeoutCalls = [];
  let localError = null;
  const timeoutTransport = {
    request(options, callback) {
      timeoutCalls.push(options);
      process.nextTick(() =>
        callback({
          statusCode: 401,
          headers: {},
          body: '<html><head><title>401 Authorization Required</title></head></html>',
        })
      );
      return {
        on() {
          return this;
        },
        end() {},
      };
    },
  };
  const timeoutHandler = createOpenAIResponsesToChatHandler(
    {
      http: timeoutTransport,
      https: timeoutTransport,
      CORS_HEADERS: {},
      collectBoundedResponse(proxyRes, _clientRes, _upstreamPath, _type, onComplete) {
        onComplete(proxyRes.body);
      },
      createChatToResponsesBridge() {},
      logProxyEvent() {},
      logRequestEnd() {},
      maxConversionResponseBytes: 1024 * 1024,
      onProxyError() {
        return () => {};
      },
      onProxyTimeout() {
        return () => {};
      },
      openAIChatToResponses() {
        throw new Error('conversion should not run after refresh timeout');
      },
      parseJsonOrSseJson: JSON.parse,
      parseProxyBody() {
        return { model: 'workbuddy/deepseek-v4.1-flash', input: 'ping' };
      },
      processOpenAIChatSseChunkToResponses() {},
      readWorkBuddyAuthInfo() {
        return null;
      },
      refreshWorkBuddyOfficialAuth() {
        return Promise.resolve({
          status: 'refresh_timeout',
          triggerStatus: 'started',
          before: { found: true, hasAccessToken: true, tokenShapeOk: false },
          after: { found: true, hasAccessToken: true, tokenShapeOk: false },
        });
      },
      rejectUnsupportedResponsesConversion() {
        return false;
      },
      rememberResponsesFromChatResponse() {},
      responsesToChatWithHistory() {
        return { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'ping' }] };
      },
      sendJsonError(_clientRes, status, payload) {
        localError = { status, payload };
      },
      upstreamRequestOptions(_target, path, headers) {
        return { path, headers };
      },
      writeJsonResponse() {},
    },
    {
      boundedResponseContext() {
        return {};
      },
      handleConvertedJsonResponse() {
        throw new Error('upstream HTML should not be forwarded after refresh timeout');
      },
      proxyErrorContext() {
        return {};
      },
    }
  );

  timeoutHandler(
    { method: 'POST', headers: {} },
    { headersSent: false },
    {
      authProvider: 'workbuddy',
      buffer: Buffer.from('{}'),
      profile: { protocol: 'openai' },
      rewriteTo: 'deepseek-v4.1-flash',
      workbuddyAuth: { accessToken: 'opaque-old', uid: 'uid-old' },
    },
    { protocol: 'http:', path: '/v2', hostname: 'copilot.tencent.com' },
    'opaque-old',
    '/v1/responses',
    Date.now()
  );

  await waitForCompletion(() => localError !== null, 'auth refresh timeout');
  assert.strictEqual(timeoutCalls.length, 1);
  assert.strictEqual(localError.status, 401);
  assert.strictEqual(localError.payload.error.code, 'workbuddy_auth_refresh_failed');
  assert.ok(!JSON.stringify(localError).includes('<html>'));

  let wbipcConverted = null;
  let encryptedTransportCalled = false;
  const wbipcBodies = [];
  const wbipcEvents = [];
  let artifactReceiptFound = false;
  let artifactReceiptFlags = null;
  let unexpectedEncryptedError = null;
  let encryptedSourceInput = 'ping';
  const encryptedWbipcHandler = createOpenAIResponsesToChatHandler(
    {
      http: {
        request() {
          encryptedTransportCalled = true;
          throw new Error('encrypted credentials must use wbipc before upstream request');
        },
      },
      https: {
        request() {
          encryptedTransportCalled = true;
          throw new Error('encrypted credentials must use wbipc before upstream request');
        },
      },
      CORS_HEADERS: {},
      collectBoundedResponse() {},
      createChatToResponsesBridge() {},
      logProxyEvent(type, payload) {
        wbipcEvents.push({ type, payload });
      },
      logRequestEnd() {},
      maxConversionResponseBytes: 1024 * 1024,
      workbuddyOperationalInputTokens: 2048,
      workbuddyPreflightBodyBytes: 8192,
      workbuddyTargetBodyBytes: 8192,
      workbuddyWbipcRetryBodyBytes: 4096,
      onProxyError() {
        return () => {};
      },
      onProxyTimeout() {
        return () => {};
      },
      openAIChatToResponses(chatPayload) {
        return { id: 'resp-ok', output_text: chatPayload.choices[0].message.content };
      },
      parseJsonOrSseJson: JSON.parse,
      parseProxyBody() {
        return { model: 'workbuddy/deepseek-v4.1-flash', input: encryptedSourceInput };
      },
      processOpenAIChatSseChunkToResponses() {},
      workBuddyWbipcClient: {
        request(params) {
          assert.strictEqual(params.method, 'POST');
          assert.strictEqual(params.path, '/v2/chat/completions');
          assert.strictEqual(params.headers.authorization, undefined);
          assert.strictEqual(params.headers['content-type'], 'application/json');
          assert.ok(Buffer.isBuffer(params.body));
          wbipcBodies.push(JSON.parse(params.body.toString('utf8')));
          if (wbipcBodies.length === 1) {
            return Promise.resolve({ ok: false, status: 'E_PAYLOAD_TOO_LARGE' });
          }
          if (wbipcBodies.length === 2) {
            // Choose the requested result by identity, not the first locator in
            // JSON: checkpoints now also expose recoverable call arguments.
            const receipts = wbipcBodies[1].messages.flatMap((message) => {
              const checkpoint = checkpointPayload(message);
              if (checkpoint) return checkpoint.evidenceReceipts || [];
              if (
                typeof message.content === 'string' &&
                message.content.startsWith(`${EVIDENCE_MARKER} `)
              ) {
                return [JSON.parse(message.content.slice(EVIDENCE_MARKER.length + 1))];
              }
              return [];
            });
            const receipt = receipts.find((item) => item.callId === 'call_old_evidence');
            const { locator, scope, digest } = receipt || {};
            artifactReceiptFound = Boolean(
              locator &&
              scope &&
              digest &&
              wbipcBodies[1].tools.some(
                (tool) => tool.function?.name === 'hpm_read_context_artifact'
              )
            );
            artifactReceiptFlags = {
              locator: Boolean(locator),
              scope: Boolean(scope),
              digest: Boolean(digest),
              tool: wbipcBodies[1].tools.some(
                (tool) => tool.function?.name === 'hpm_read_context_artifact'
              ),
            };
            if (!artifactReceiptFound) {
              return Promise.resolve({
                ok: true,
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  id: 'chatcmpl-no-artifact',
                  choices: [{ message: { content: 'wbipc-no-artifact' } }],
                }),
              });
            }
            return Promise.resolve({
              ok: true,
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
              body: [
                `data: ${JSON.stringify({
                  id: 'chatcmpl-artifact',
                  choices: [
                    {
                      index: 0,
                      delta: {
                        role: 'assistant',
                        content: null,
                        tool_calls: [
                          {
                            index: 0,
                            id: 'call_artifact',
                            type: 'function',
                            function: {
                              name: 'hpm_read_context_artifact',
                              arguments: JSON.stringify({ locator, scope, digest }),
                            },
                          },
                        ],
                      },
                      finish_reason: 'tool_calls',
                    },
                  ],
                })}`,
                'data: [DONE]',
                '',
              ].join('\n\n'),
            });
          }
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: 'chatcmpl-wbipc',
              choices: [{ message: { content: 'wbipc-ok' } }],
            }),
          });
        },
      },
      rejectUnsupportedResponsesConversion() {
        return false;
      },
      rememberResponsesFromChatResponse() {},
      responsesToChatWithHistory() {
        return {
          model: 'deepseek-v4.1-flash',
          messages: [
            { role: 'system', content: 'keep-system' },
            // Leave enough room for verbatim user requirements plus recovery
            // metadata: the planner must no longer truncate this user turn.
            { role: 'user', content: 'old-' + 'x'.repeat(1000) },
            {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call_old_evidence',
                  type: 'function',
                  function: { name: 'read_workspace_file', arguments: '{}' },
                },
              ],
            },
            {
              role: 'tool',
              tool_call_id: 'call_old_evidence',
              content: 'artifact-output-' + 'a'.repeat(500),
            },
            { role: 'user', content: 'middle-request' },
            { role: 'assistant', content: 'old-answer-' + 'y'.repeat(2500) },
            { role: 'user', content: 'keep-latest' },
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'read_workspace_file',
                description: 'tool-doc-'.repeat(1000),
                parameters: {
                  type: 'object',
                  properties: {
                    path: { type: 'string', description: 'parameter-doc-'.repeat(1000) },
                  },
                  required: ['path'],
                  examples: [{ path: 'example.txt' }],
                },
              },
            },
          ],
        };
      },
      sendJsonError(_clientRes, status, payload) {
        unexpectedEncryptedError = { status, payload };
      },
      upstreamRequestOptions() {
        throw new Error('upstream options should not be built');
      },
      writeJsonResponse(_clientRes, status, body) {
        wbipcConverted = { status, body };
      },
    },
    {
      boundedResponseContext() {
        return {};
      },
      handleConvertedJsonResponse(options) {
        wbipcConverted = {
          status: options.proxyRes.statusCode,
          body: options.convert(options.responseBody),
        };
        options.logRequestEnd('POST', '/v1/responses', Date.now(), options.proxyRes.statusCode);
      },
      proxyErrorContext() {
        return {};
      },
    }
  );

  assert.doesNotThrow(
    () =>
      encryptedWbipcHandler(
        { method: 'POST', headers: {} },
        { headersSent: false },
        {
          authProvider: 'workbuddy',
          buffer: Buffer.from('{}'),
          profile: { protocol: 'workbuddy' },
          rewriteTo: 'deepseek-v4.1-flash',
          workbuddyAuth: { accessToken: null, accessTokenEncrypted: true, uid: 'uid-encrypted' },
        },
        { protocol: 'http:', path: '/v2', hostname: 'www.workbuddy.cn' },
        '',
        '/v1/responses',
        Date.now()
      ),
    'ordinary encrypted requests without a profile id must not enter compaction binding validation'
  );

  await waitForCompletion(
    () => wbipcConverted !== null || unexpectedEncryptedError !== null,
    'encrypted artifact continuation'
  );
  assert.strictEqual(encryptedTransportCalled, false);
  assert.strictEqual(unexpectedEncryptedError, null, JSON.stringify(wbipcEvents));
  assert.deepStrictEqual(
    artifactReceiptFlags,
    { locator: true, scope: true, digest: true, tool: true },
    'compacted evidence has a readable receipt'
  );
  assert.strictEqual(wbipcBodies.length, 3);
  assert.ok(JSON.stringify(wbipcBodies[1]).length < JSON.stringify(wbipcBodies[0]).length);
  assert.ok(
    JSON.stringify(
      wbipcBodies[1].tools.find((tool) => tool.function?.name === 'read_workspace_file')
    ).length <=
      JSON.stringify(
        wbipcBodies[0].tools.find((tool) => tool.function?.name === 'read_workspace_file')
      ).length
  );
  assert.strictEqual(wbipcBodies[1].tools[0].function.name, 'read_workspace_file');
  assert.deepStrictEqual(wbipcBodies[1].tools[0].function.parameters.required, ['path']);
  assert.strictEqual(wbipcBodies[1].messages[0].content, 'keep-system');
  assert.strictEqual(wbipcBodies[1].messages.at(-1).content, 'keep-latest');
  assert.ok(
    wbipcBodies[2].messages.some(
      (message) => message.role === 'tool' && String(message.content).includes('artifact-output-')
    ),
    JSON.stringify(
      wbipcBodies[2].messages
        .filter(
          (message) => message.role === 'tool' && message.name === 'hpm_read_context_artifact'
        )
        .map((message) => {
          const envelope = JSON.parse(message.content);
          return {
            ok: envelope.ok,
            error: envelope.error,
            pageBytes: envelope.page ? envelope.page.endOffsetBytes - envelope.page.offsetBytes : 0,
          };
        })
    )
  );
  const fallbackEvent = wbipcEvents.find(
    (event) => event.type === 'workbuddy_wbipc_payload_fallback'
  );
  const contextPlanEvent = wbipcEvents.find((event) => event.type === 'workbuddy_context_plan');
  assert.strictEqual(contextPlanEvent.payload.preflightApplied, true);
  assert.ok(contextPlanEvent.payload.originalEstimatedTokens > 2048);
  assert.ok(contextPlanEvent.payload.finalEstimatedTokens <= 2048);
  assert.strictEqual(fallbackEvent.payload.retrying, true);
  assert.ok(fallbackEvent.payload.retryBodyBytes < fallbackEvent.payload.originalBodyBytes);
  const artifactEvent = wbipcEvents.find(
    (event) => event.type === 'workbuddy_context_artifact_read'
  );
  assert.strictEqual(artifactEvent.payload.round, 1);
  assert.strictEqual(artifactEvent.payload.resolvedArtifacts, 1);
  const outcomeEvent = wbipcEvents.find((event) => event.type === 'workbuddy_context_outcome');
  assert.strictEqual(outcomeEvent.payload.provider, 'workbuddy');
  assert.strictEqual(outcomeEvent.payload.retryAttempted, true);
  assert.strictEqual(outcomeEvent.payload.retrySucceeded, true);
  assert.strictEqual(outcomeEvent.payload.artifactReadSucceeded, true);
  assert.strictEqual(outcomeEvent.payload.artifactsResolved, 1);
  assert.ok(!JSON.stringify(outcomeEvent.payload).includes('artifact-output-'));
  assert.deepStrictEqual(wbipcConverted, {
    status: 200,
    body: { id: 'resp-ok', output_text: 'wbipc-ok' },
  });

  encryptedSourceInput = [
    { type: 'compaction', encrypted_content: 'hpm-local-compaction-v2:invalid' },
  ];
  unexpectedEncryptedError = null;
  assert.doesNotThrow(() =>
    encryptedWbipcHandler(
      { method: 'POST', headers: {} },
      { headersSent: false },
      {
        authProvider: 'workbuddy',
        buffer: Buffer.from('{}'),
        profile: { protocol: 'workbuddy' },
        rewriteTo: 'deepseek-v4.1-flash',
        workbuddyAuth: { accessToken: null, accessTokenEncrypted: true, uid: 'uid-encrypted' },
      },
      { protocol: 'http:', path: '/v2', hostname: 'www.workbuddy.cn' },
      '',
      '/v1/responses',
      Date.now()
    )
  );
  assert.strictEqual(unexpectedEncryptedError.status, 400);
  assert.strictEqual(unexpectedEncryptedError.payload.error.code, 'invalid_local_compaction');
  assert.deepStrictEqual(unexpectedEncryptedError.payload.error.recovery, {
    action: 'resend_full_history',
    replay_external_tools: false,
  });
  assert.strictEqual(wbipcBodies.length, 3, 'unauthenticated replay never reaches WorkBuddy');
  assert.ok(!JSON.stringify(unexpectedEncryptedError).includes('uid-encrypted'));

  let encryptedLocalError = null;
  let encryptedFailureStatus = 'not_available';
  const encryptedUnavailableHandler = createOpenAIResponsesToChatHandler(
    {
      http: {
        request() {
          throw new Error('encrypted credentials must fail locally when wbipc is unavailable');
        },
      },
      https: {
        request() {
          throw new Error('encrypted credentials must fail locally when wbipc is unavailable');
        },
      },
      CORS_HEADERS: {},
      collectBoundedResponse() {},
      createChatToResponsesBridge() {},
      logProxyEvent() {},
      logRequestEnd() {},
      maxConversionResponseBytes: 1024 * 1024,
      onProxyError() {
        return () => {};
      },
      onProxyTimeout() {
        return () => {};
      },
      openAIChatToResponses() {},
      parseJsonOrSseJson: JSON.parse,
      parseProxyBody() {
        return { model: 'workbuddy/deepseek-v4.1-flash', input: 'ping' };
      },
      processOpenAIChatSseChunkToResponses() {},
      workBuddyWbipcClient: {
        request() {
          return Promise.resolve({ ok: false, status: encryptedFailureStatus });
        },
      },
      rejectUnsupportedResponsesConversion() {
        return false;
      },
      rememberResponsesFromChatResponse() {},
      responsesToChatWithHistory() {
        return { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'ping' }] };
      },
      sendJsonError(_clientRes, status, payload) {
        encryptedLocalError = { status, payload };
      },
      upstreamRequestOptions() {
        throw new Error('upstream options should not be built');
      },
      writeJsonResponse() {},
    },
    {
      boundedResponseContext() {
        return {};
      },
      handleConvertedJsonResponse() {
        throw new Error('conversion should not run');
      },
      proxyErrorContext() {
        return {};
      },
    }
  );

  encryptedUnavailableHandler(
    { method: 'POST', headers: {} },
    { headersSent: false },
    {
      authProvider: 'workbuddy',
      buffer: Buffer.from('{}'),
      profile: { protocol: 'workbuddy' },
      rewriteTo: 'deepseek-v4.1-flash',
      workbuddyAuth: { accessToken: null, accessTokenEncrypted: true, uid: 'uid-encrypted' },
    },
    { protocol: 'http:', path: '/v2', hostname: 'www.workbuddy.cn' },
    '',
    '/v1/responses',
    Date.now()
  );

  await waitForCompletion(() => encryptedLocalError !== null, 'unavailable encrypted bridge');
  assert.strictEqual(encryptedLocalError.status, 503);
  assert.strictEqual(encryptedLocalError.payload.error.code, 'workbuddy_host_unavailable');
  assert.strictEqual(encryptedLocalError.payload.error.wbipc_status, 'not_available');
  assert.ok(!JSON.stringify(encryptedLocalError).includes('uid-encrypted'));

  encryptedFailureStatus = 'E_PAYLOAD_TOO_LARGE';
  encryptedLocalError = null;
  encryptedUnavailableHandler(
    { method: 'POST', headers: {} },
    { headersSent: false },
    {
      authProvider: 'workbuddy',
      buffer: Buffer.from('{}'),
      profile: { protocol: 'workbuddy' },
      rewriteTo: 'deepseek-v4.1-flash',
      workbuddyAuth: { accessToken: null, accessTokenEncrypted: true, uid: 'uid-encrypted' },
    },
    { protocol: 'http:', path: '/v2', hostname: 'www.workbuddy.cn' },
    '',
    '/v1/responses',
    Date.now()
  );

  await waitForCompletion(() => encryptedLocalError !== null, 'encrypted payload rejection');
  assert.strictEqual(encryptedLocalError.status, 413);
  assert.strictEqual(encryptedLocalError.payload.error.code, 'workbuddy_request_too_large');
  assert.strictEqual(encryptedLocalError.payload.error.wbipc_status, 'E_PAYLOAD_TOO_LARGE');
  assert.ok(!JSON.stringify(encryptedLocalError).includes('uid-encrypted'));

  const boundaryTargetBytes = 393216;
  const boundaryCheckpoint = {
    role: 'assistant',
    content:
      '[HPM_CONTEXT_CHECKPOINT_V1]\n' +
      JSON.stringify({
        schema: 'hpm.context.checkpoint',
        version: 1,
        sourceRole: 'assistant',
        entries: [{ text: 'continue safely' }],
      }),
  };
  const boundaryMessages = [
    { role: 'system', content: 'stable-system' },
    { role: 'developer', content: 'stable-developer' },
    { role: 'user', content: '' },
    boundaryCheckpoint,
    ...Array.from({ length: 7 }, () => ({ role: 'assistant', content: '' })),
  ];
  const boundaryChatBody = { model: 'deepseek-v4.1-flash', messages: boundaryMessages };
  const boundaryBaseBytes = Buffer.byteLength(JSON.stringify(boundaryChatBody));
  const boundaryContentIndexes = [2, 4, 5, 6, 7, 8, 9, 10];
  // The converted-route cooldown contract adds `stream: true` (+14 bytes) and
  // WorkBuddy normalizes developer -> system (-3 bytes), leaving target + 10.
  const boundaryContentChars = boundaryTargetBytes - 1 - boundaryBaseBytes;
  for (const [offset, index] of boundaryContentIndexes.entries()) {
    const chars =
      Math.floor(boundaryContentChars / boundaryContentIndexes.length) +
      (offset < boundaryContentChars % boundaryContentIndexes.length ? 1 : 0);
    boundaryMessages[index].content = 'b'.repeat(chars);
  }
  assert.strictEqual(Buffer.byteLength(JSON.stringify(boundaryChatBody)), boundaryTargetBytes - 1);

  let boundaryRequestBody = null;
  let boundaryLocalError = null;
  let boundaryConverted = null;
  const boundaryHandler = createOpenAIResponsesToChatHandler(
    {
      http: { request() {} },
      https: { request() {} },
      CORS_HEADERS: {},
      collectBoundedResponse() {},
      createChatToResponsesBridge() {},
      logProxyEvent() {},
      logRequestEnd() {},
      maxConversionResponseBytes: 1024 * 1024,
      workbuddyOperationalInputTokens: 200000,
      contextArtifactStore: {},
      workbuddyPreflightBodyBytes: 1,
      workbuddyTargetBodyBytes: boundaryTargetBytes,
      onProxyError() {
        return () => {};
      },
      onProxyTimeout() {
        return () => {};
      },
      openAIChatToResponses(chatPayload) {
        return { id: 'resp-boundary', output_text: chatPayload.choices[0].message.content };
      },
      parseJsonOrSseJson: JSON.parse,
      parseProxyBody() {
        return { model: 'workbuddy/deepseek-v4.1-flash', input: 'boundary' };
      },
      processOpenAIChatSseChunkToResponses() {},
      workBuddyWbipcClient: {
        request(params) {
          boundaryRequestBody = params.body;
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: 'chatcmpl-boundary',
              choices: [{ message: { content: 'boundary-ok' } }],
            }),
          });
        },
      },
      rejectUnsupportedResponsesConversion() {
        return false;
      },
      rememberResponsesFromChatResponse() {},
      responsesToChatWithHistory() {
        return boundaryChatBody;
      },
      sendJsonError(_clientRes, status, payload) {
        boundaryLocalError = { status, payload };
      },
      upstreamRequestOptions() {
        throw new Error('boundary request must use wbipc');
      },
      writeJsonResponse(_clientRes, status, body) {
        boundaryConverted = { status, body };
      },
    },
    {
      boundedResponseContext() {
        return {};
      },
      handleConvertedJsonResponse(options) {
        boundaryConverted = {
          status: options.proxyRes.statusCode,
          body: options.convert(options.responseBody),
        };
      },
      proxyErrorContext() {
        return {};
      },
    }
  );

  boundaryHandler(
    { method: 'POST', headers: {} },
    { headersSent: false },
    {
      authProvider: 'workbuddy',
      buffer: Buffer.from('{}'),
      profile: { protocol: 'workbuddy' },
      rewriteTo: 'deepseek-v4.1-flash',
      workbuddyAuth: { accessToken: null, accessTokenEncrypted: true, uid: 'uid-encrypted' },
    },
    { protocol: 'http:', path: '/v2', hostname: 'www.workbuddy.cn' },
    '',
    '/v1/responses',
    Date.now()
  );

  await waitForCompletion(
    () => boundaryConverted !== null || boundaryLocalError !== null,
    'boundary payload conversion'
  );
  assert.strictEqual(boundaryLocalError, null);
  assert.ok(Buffer.isBuffer(boundaryRequestBody));
  assert.ok(boundaryRequestBody.length <= boundaryTargetBytes);
  assert.deepStrictEqual(boundaryConverted, {
    status: 200,
    body: { id: 'resp-boundary', output_text: 'boundary-ok' },
  });

  console.log('[responses-to-chat-workbuddy-refresh.test] ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
