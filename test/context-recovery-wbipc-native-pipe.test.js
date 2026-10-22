'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  createNativePipePeer,
  isolateNativePipeTestEnvironment,
} = require('./helpers/workbuddy-wbipc-native-pipe');
// Apply before production imports, including when invoked directly with node --test.
isolateNativePipeTestEnvironment(test);
const { createWorkBuddyWbipcClient } = require('../lib/proxy/workbuddy-wbipc-client');
const {
  createContextRecoveryWbipcDispatch,
} = require('../lib/proxy/context-recovery-wbipc-dispatch');
const { estimateTokensForValue } = require('../lib/proxy/inline-media');
const { READ_EVIDENCE_TOOL } = require('../lib/proxy/context-evidence-tools');

const failure = { message: 'Recovery WBIPC dispatch failed' };
const completion = JSON.stringify({
  choices: [
    { index: 0, message: { role: 'assistant', content: 'public-answer' }, finish_reason: 'stop' },
  ],
});
const body = () => ({
  model: 'fixture',
  stream: false,
  messages: [{ role: 'user', content: 'synthetic question' }],
});

function dispatch(peer, overrides = {}) {
  return createContextRecoveryWbipcDispatch({
    readEndpoint: () => ({ endpoint: peer.endpoint, ticket: peer.ticket }),
    authorized: () => true,
    path: '/v2/chat/completions',
    model: 'fixture',
    timeoutMs: 2000,
    ...overrides,
  });
}

test(
  'synthetic native IPC transports an exact 600KB body using production HMAC/GetPipe/http.fetch',
  { timeout: 10000 },
  async (t) => {
    const original = '精确原文🙂' + 'x'.repeat(600000);
    const digest = (value) => createHash('sha256').update(value).digest('hex');
    const peer = await createNativePipePeer(t, {
      onFetch(params) {
        assert.equal(params.path, '/v2/chat/completions');
        assert.equal(params.method, 'POST');
        const received = Buffer.from(params.body_b64, 'base64');
        assert.equal(digest(received), digest(original));
        return received.toString('utf8');
      },
    });
    const client = createWorkBuddyWbipcClient({
      autoStart: false,
      timeoutMs: 2000,
      readEndpoint: () => ({ endpoint: peer.endpoint, ticket: peer.ticket }),
    });
    const result = await client.request({ path: '/v2/chat/completions', body: original });
    assert.equal(result.ok, true);
    assert.equal(digest(result.body), digest(original));
    await peer.waitForDisconnect();
    assert.equal(peer.connections, 1);
    assert.equal(peer.requests.length, 1);
    assert.ok(peer.requests[0].frameBytes > 600000);
  }
);

test(
  'synthetic native IPC dispatch projects 600KB retained data under both budgets without changing it',
  { timeout: 10000 },
  async (t) => {
    const original = '保留原文🙂' + 'x'.repeat(600000);
    const digest = createHash('sha256').update(original).digest('hex');
    const evidence = {
      sourceId: 'hce_' + 'a'.repeat(32),
      digest,
      bytes: Buffer.byteLength(original),
    };
    const input = {
      ...body(),
      messages: [
        ...body().messages,
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'original', type: 'function', function: { name: 'lookup', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'original', content: original },
        { role: 'user', content: 'answer from retained evidence' },
      ],
    };
    const before = JSON.stringify(input);
    const peer = await createNativePipePeer(t, { onFetch: () => completion });
    const options = {
      historyFormat: 3,
      reference: (id, hash) => (id === 'original' && hash === digest ? evidence : null),
    };
    const send = dispatch(peer, options);
    const signal = new globalThis.AbortController().signal;
    const privateInput = {
      ...input,
      tools: [
        {
          type: 'function',
          function: {
            name: READ_EVIDENCE_TOOL,
            parameters: { type: 'object' },
          },
        },
      ],
    };
    assert.equal((await send(privateInput, { signal })).statusCode, 200);
    assert.equal((await send(input, { signal })).statusCode, 200);
    const sent = peer.requests.map(({ params }) =>
      JSON.parse(Buffer.from(params.body_b64, 'base64').toString('utf8'))
    );
    for (const window of sent) {
      assert.ok(Buffer.byteLength(JSON.stringify(window)) <= 384 * 1024);
      assert.ok(estimateTokensForValue(window) <= 96 * 1024);
      assert.ok(!JSON.stringify(window).includes(original));
    }
    assert.deepEqual(JSON.parse(sent[0].messages[2].content).retainedToolOutput, evidence);
    assert.doesNotMatch(JSON.stringify(sent[1]), /hce_|hpm_read_retained_evidence/);
    assert.equal(JSON.stringify(input), before);
    const count = peer.connections;
    for (const limits of [{ maxBodyBytes: 1 }, { maxInputTokens: 1 }]) {
      await assert.rejects(dispatch(peer, { ...options, ...limits })(input, { signal }), failure);
    }
    assert.equal(peer.connections, count);
  }
);

test(
  'synthetic native IPC cancellation, peer close and malformed/error replies fail safely without resend',
  { timeout: 10000 },
  async (t) => {
    for (const mode of [
      'cancel',
      'close',
      'malformed',
      'error',
      'revoke',
      'bad-proof',
      'timeout',
    ]) {
      await t.test(mode, async (t) => {
        const controller = new globalThis.AbortController();
        let allowed = true;
        const peer = await createNativePipePeer(t, {
          badProof: mode === 'bad-proof',
          onPipe() {
            if (mode === 'revoke') allowed = false;
          },
          onFetch(_params, controls) {
            if (mode === 'cancel') controller.abort();
            if (mode === 'close') controls.close();
            if (mode === 'malformed') controls.malformed();
            if (mode === 'error') controls.fail();
            return null;
          },
        });
        await assert.rejects(
          dispatch(peer, { authorized: () => allowed })(body(), {
            signal: controller.signal,
          }),
          failure
        );
        await peer.waitForDisconnect();
        assert.equal(peer.connections, 1);
        assert.equal(peer.requests.length, ['revoke', 'bad-proof'].includes(mode) ? 0 : 1);
      });
    }
  }
);

test(
  'synthetic native IPC rejects empty, unretained oversized and pre-cancelled requests before connect',
  { timeout: 10000 },
  async (t) => {
    const peer = await createNativePipePeer(t);
    const send = dispatch(peer);
    const controller = new globalThis.AbortController();
    for (const input of [
      null,
      {},
      { ...body(), messages: [] },
      {
        ...body(),
        messages: [{ role: 'user', content: 'x'.repeat(600000) }],
      },
    ]) {
      await assert.rejects(send(input, { signal: controller.signal }), failure);
    }
    controller.abort();
    await assert.rejects(send(body(), { signal: controller.signal }), failure);
    assert.equal(peer.connections, 0);
    assert.equal(peer.requests.length, 0);
  }
);
