'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const { createContextCapacityController } = require('../lib/proxy/context-capacity-controller');
const {
  parseBufferedChatCompletion,
  CONTEXT_ARTIFACT_TOOL_NAME,
} = require('../lib/proxy/context-artifact-tool');
const {
  createOpenAIResponsesToChatHandler,
} = require('../lib/proxy/handlers/responses-to-chat-handler');
const { createRouteResponseHelpers } = require('../lib/proxy/handlers/route-response-helpers');

const scope = 'hcs_' + '3'.repeat(32);
const message = (args, id = 'read', extra = []) => ({
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id,
      type: 'function',
      function: { name: CONTEXT_ARTIFACT_TOOL_NAME, arguments: JSON.stringify(args) },
    },
    ...extra,
  ],
});
function response(body, msg, status = 200) {
  const payload =
    body.stream && status === 200
      ? 'data: ' +
        JSON.stringify({
          id: 'chat',
          choices: [
            {
              index: 0,
              delta: {
                ...msg,
                ...(msg.tool_calls
                  ? { tool_calls: msg.tool_calls.map((call, index) => ({ ...call, index })) }
                  : {}),
              },
              finish_reason: msg.tool_calls ? 'tool_calls' : 'stop',
            },
          ],
        }) +
        '\n\ndata: [DONE]\n\n'
      : JSON.stringify({ id: 'chat', choices: [{ message: msg }] });
  return { ok: true, status, headers: {}, body: payload };
}

async function run({ mode = 'success', expire = false, target = 149111, capacityController } = {}) {
  let now = 1000;
  const store = createContextArtifactStore({ now: () => now, ttlMs: 100 });
  const receipt = store.put(
    'owner',
    scope,
    'a'.repeat(100000) + 'MIDDLE_SENTINEL' + 'b'.repeat(100000)
  );
  const args = { locator: receipt.locator, scope, digest: receipt.digest, offsetBytes: 100000 };
  if (expire) now += 100;
  const events = [],
    ends = [],
    sent = [],
    errors = [];
  const req = new EventEmitter();
  req.method = 'POST';
  req.headers = {};
  const res = new EventEmitter();
  let done;
  const completion = new Promise((resolve) => {
    done = resolve;
  });
  let capacityCalls = 0;
  const ctx = {
    CORS_HEADERS: {},
    workbuddyPreflightBodyBytes: 1,
    workbuddyTargetBodyBytes: target,
    contextArtifactStore: store,
    contextCapacityController: capacityController || {
      targetBytes(_key, configured) {
        capacityCalls += 1;
        return mode === 'continuation413' && capacityCalls > 1 ? 50000 : configured;
      },
      recordSuccess() {},
      recordRejection() {},
    },
    parseProxyBody: () => ({ model: 'workbuddy/hy4', input: 'read middle', stream: false }),
    responsesToChatWithHistory: () => ({
      model: 'hy4-preview-f',
      stream: false,
      messages: [
        { role: 'system', content: 'P'.repeat(104274) },
        { role: 'user', content: 'read evidence: ' + JSON.stringify(args) },
      ],
    }),
    rejectUnsupportedResponsesConversion: () => false,
    parseJsonOrSseJson: (raw) =>
      parseBufferedChatCompletion(raw, raw.startsWith('data:'), 16 * 1024 * 1024),
    openAIChatToResponses() {
      if (mode === 'conversionFailure') throw new Error('PRIVATE_CONTENT');
      return { status: 'completed' };
    },
    rememberResponsesFromChatResponse() {},
    sendJsonError(_res, status, payload) {
      errors.push({ status, payload });
    },
    sendUpstreamError(_res, status) {
      errors.push({ status });
    },
    writeJsonResponse() {},
    logProxyEvent: (kind, payload) => events.push({ kind, payload }),
    logRequestEnd: (...values) => {
      ends.push(values);
      done();
    },
    workBuddyWbipcClient: {
      async request(params, signalOptions) {
        const body = JSON.parse(params.body.toString());
        sent.push(body);
        if (mode === 'host413' && sent.length === 4)
          return { ok: false, status: 'E_PAYLOAD_TOO_LARGE' };
        if (mode === 'exception') throw new Error('PRIVATE_CONTENT');
        if (mode === 'cancel')
          return new Promise((resolve) => {
            signalOptions.signal.addEventListener(
              'abort',
              () => resolve({ ok: false, status: 'cancelled' }),
              { once: true }
            );
            setImmediate(() => req.emit('aborted'));
          });
        if (mode === 'upstream500') return response(body, { content: 'failed' }, 500);
        if (mode === 'noRecovery') return response(body, { content: 'ok' });
        if (mode === 'conversionFailure') return response(body, { content: 'ok' });
        if (sent.length === 1)
          return response(
            body,
            message(
              args,
              'read1',
              mode === 'mixed'
                ? [
                    {
                      id: 'external',
                      type: 'function',
                      function: { name: 'read', arguments: '{}' },
                    },
                  ]
                : []
            )
          );
        if (mode === 'loop') return response(body, message(args, 'different-id'));
        const restored = body.messages
          .filter((item) => item.name === CONTEXT_ARTIFACT_TOOL_NAME)
          .at(-1);
        const page = JSON.parse(restored.content);
        if (!expire) {
          assert.equal(page.ok, true);
          assert.equal(page.page.text.startsWith('MIDDLE_SENTINEL'), sent.length === 2);
        } else assert.equal(page.ok, false);
        if (!expire && sent.length < 4)
          return response(
            body,
            message({ ...args, offsetBytes: page.page.nextOffsetBytes }, 'read' + sent.length)
          );
        return response(body, { content: 'ok' });
      },
    },
  };
  const handler = createOpenAIResponsesToChatHandler(ctx, createRouteResponseHelpers(ctx));
  handler(
    req,
    res,
    {
      authProvider: 'workbuddy',
      profile: { id: 'owner', protocol: 'workbuddy' },
      rewriteTo: 'hy4-preview-f',
      buffer: Buffer.from('{}'),
      workbuddyAuth: { accessTokenEncrypted: true },
    },
    { path: '/v2' },
    '',
    '/v1/responses',
    Date.now()
  );
  const timer = setTimeout(() => done(), 3000);
  await completion;
  clearTimeout(timer);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ends.length, 1, 'each terminal must be reported exactly once');
  const outcomes = events.filter((event) => event.kind === 'workbuddy_context_outcome');
  assert.equal(outcomes.length, 1);
  const outcome = outcomes[0].payload;
  assert.equal(outcome.finalStatus, ends[0][3]);
  const safeEvents = events.filter((event) => event.kind.startsWith('workbuddy_context_'));
  const serialized = JSON.stringify(safeEvents);
  for (const secret of [
    'PRIVATE_CONTENT',
    'MIDDLE_SENTINEL',
    receipt.locator,
    receipt.digest,
    scope,
  ])
    assert.ok(!serialized.includes(secret));
  for (const body of sent) assert.ok(Buffer.byteLength(JSON.stringify(body)) <= target);
  assert.ok(!JSON.stringify(errors).includes('PRIVATE_CONTENT'));
  return { outcome, sent, errors };
}

async function main() {
  const success = await run();
  assert.equal(success.sent.length, 4);
  assert.equal(success.outcome.artifactReadRounds, 3);
  assert.equal(success.outcome.artifactsAttempted, 3);
  assert.equal(success.outcome.artifactsResolved, 3);
  assert.equal(success.outcome.artifactsDelivered, 3);
  assert.equal(success.outcome.finalOk, true);
  const capacityController = createContextCapacityController();
  const hostRejected = await run({ mode: 'host413', capacityController });
  assert.equal(hostRejected.sent.length, 4);
  assert.equal(hostRejected.outcome.finalStatus, 413);
  assert.equal(hostRejected.outcome.artifactsDelivered, 2);
  const capacityKey = JSON.stringify(['owner', '/v2', 'hy4-preview-f', 'stream']);
  const rejectedBytes = Buffer.byteLength(JSON.stringify(hostRejected.sent[3]));
  const eligibleAcceptedBytes = hostRejected.sent
    .slice(0, 3)
    .map((body) => Buffer.byteLength(JSON.stringify(body)))
    .filter((size) => size < rejectedBytes);
  assert.equal(
    capacityController.targetBytes(capacityKey, 149111),
    Math.max(...eligibleAcceptedBytes),
    'a failed later recovery keeps the largest proven accepted size strictly below rejection'
  );
  assert.ok(capacityController.targetBytes(capacityKey, 149111) < rejectedBytes);
  const nextRequest = await run({ mode: 'noRecovery', capacityController });
  assert.equal(
    nextRequest.outcome.finalStatus,
    200,
    'the smaller next request must not be locally locked out'
  );
  assert.equal(nextRequest.sent.length, 1);
  const expired = await run({ expire: true });
  assert.equal(expired.outcome.artifactsResolved, 0);
  assert.equal(expired.outcome.artifactsUnavailable, 1);
  assert.equal(expired.outcome.artifactReadSucceeded, false);
  assert.equal(expired.outcome.artifactDeliverySucceeded, false);
  for (const mode of ['mixed', 'loop', 'conversionFailure', 'upstream500']) {
    const failure = await run({ mode });
    assert.equal(failure.outcome.finalStatus, mode === 'upstream500' ? 500 : 502);
    assert.equal(failure.outcome.finalOk, false);
  }
  const continuation413 = await run({ mode: 'continuation413' });
  assert.equal(continuation413.sent.length, 1);
  assert.equal(continuation413.outcome.finalStatus, 413);
  assert.equal(continuation413.outcome.artifactsResolved, 0);
  assert.equal(continuation413.outcome.artifactsDelivered, 0);
  const preflight413 = await run({ target: 50000 });
  assert.equal(preflight413.sent.length, 0);
  assert.equal(preflight413.outcome.finalStatus, 413);
  const cancel = await run({ mode: 'cancel' });
  assert.equal(cancel.outcome.finalStatus, 499);
  assert.equal(cancel.outcome.finalOk, false);
  const exception = await run({ mode: 'exception' });
  assert.equal(exception.outcome.finalStatus, 401);
  assert.equal(exception.outcome.finalOk, false);
  console.log('[workbuddy-context-recovery-route.test] ok');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
