'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  handleWorkBuddyCompactionTrigger,
} = require('../lib/proxy/handlers/workbuddy-compaction-flow');
const {
  createContextCompactionEnvelopeStore,
} = require('../lib/proxy/context-compaction-envelope');
const {
  createContextCompactionCoordinator,
} = require('../lib/proxy/context-compaction-coordinator');
const binding = {
  owner: 'owner',
  provider: 'workbuddy-wbipc',
  model: 'model',
  endpoint: 'host/v2',
};
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const { summaryFixture } = require('./helpers/compaction-summary-fixture');

async function run(stream, mode, withEvidence = false) {
  const store = createContextCompactionEnvelopeStore();
  const coordinator = createContextCompactionCoordinator();
  const artifacts = createContextArtifactStore();
  const clientReq = new EventEmitter(),
    clientRes = new EventEmitter();
  clientReq.method = 'POST';
  const endings = [],
    errors = [],
    diagnostics = [],
    published = [];
  clientRes.writeHead = () => {
    if (mode === 'headers') throw new Error('PRIVATE_HEADERS_FAILURE');
    clientRes.headersSent = true;
  };
  clientRes.end = (wire) => {
    if (mode === 'write') throw new Error('PRIVATE_WRITE_FAILURE');
    if (mode === 'disconnect') clientReq.emit('aborted');
    clientRes.writableEnded = true;
    if (wire) published.push(wire);
  };
  clientRes.write = () => true;
  try {
    await handleWorkBuddyCompactionTrigger({
      clientReq,
      clientRes,
      binding,
      store,
      coordinator,
      artifactStore: artifacts,
      body: {
        stream,
        input: [
          { type: 'message', role: 'user', content: 'retain' },
          ...(withEvidence
            ? ['old', 'recent1', 'recent2'].flatMap((id) => [
                { type: 'function_call', call_id: id, name: 'read', arguments: '{}' },
                {
                  type: 'function_call_output',
                  call_id: id,
                  output: id === 'old' ? 'x'.repeat(150000) : id,
                },
              ])
            : []),
        ],
      },
      maxRequestBytes: 100000,
      maxInputTokens: 20000,
      maxResponseBytes: mode === 'limit' ? 1 : 100000,
      requestSummary(request) {
        if (withEvidence)
          return {
            ok: true,
            status: 200,
            body: JSON.stringify({
              choices: [
                {
                  finish_reason: 'stop',
                  message: {
                    role: 'assistant',
                    content: summaryFixture(request, 'unverified evidence'),
                  },
                },
              ],
            }),
          };
        throw new Error('No summary should be needed');
      },
      prepareSummary() {},
      CORS_HEADERS: {},
      upstreamPath: '/v1/responses',
      startTime: 1,
      writeJsonResponse(_res, _status, response) {
        clientRes.end(JSON.stringify(response));
      },
      sendJsonError(_res, status, payload) {
        errors.push({ status, payload });
      },
      logRequestEnd(...args) {
        endings.push(args);
        if (mode === 'logger') throw new Error('PRIVATE_LOG_FAILURE');
      },
      diagnosticLog: {
        error(...args) {
          diagnostics.push(args);
        },
      },
    });
    assert.equal(clientReq.listenerCount('aborted'), 0);
    assert.equal(clientRes.listenerCount('close'), 0);
    assert.equal(clientRes.listenerCount('error'), 0);
    assert.equal(endings.length, 1);
    assert.ok(!JSON.stringify([...errors, ...endings, ...diagnostics]).includes('PRIVATE_'));
    return { store, artifacts, published, endings, errors, diagnostics };
  } catch (error) {
    store.close();
    throw error;
  } finally {
    coordinator.close();
    if (!withEvidence) artifacts.close();
  }
}

test('terminal logging failure is separately reported and cannot revoke a published JSON/SSE token', async () => {
  for (const stream of [false, true]) {
    const f = await run(stream, 'logger');
    try {
      assert.equal(f.store.stats().entries, 1);
      assert.equal(f.endings[0][3], 200);
      assert.equal(f.errors.length, 0);
      assert.equal(f.diagnostics[0][0].code, 'compaction_terminal_log_failed');
      const response = stream
        ? JSON.parse(
            f.published[0]
              .split('\n')
              .filter((line) => line.startsWith('data: {'))
              .at(-1)
              .slice(6)
          ).response
        : JSON.parse(f.published[0]);
      assert.equal(
        f.store.read(response.output[0].encrypted_content, binding)[0].content,
        'retain'
      );
    } finally {
      f.store.close();
    }
  }
});

test('JSON/SSE publication failures discard newly committed evidence, while terminal logging leaves published evidence intact', async () => {
  for (const stream of [false, true]) {
    for (const mode of ['write', 'disconnect', 'limit', 'logger', ...(stream ? ['headers'] : [])]) {
      const f = await run(stream, mode, true);
      try {
        assert.equal(f.store.stats().entries, mode === 'logger' ? 1 : 0);
        assert.equal(f.artifacts.stats().entries, mode === 'logger' ? 1 : 0);
        assert.equal(f.endings[0][3], mode === 'logger' ? 200 : mode === 'disconnect' ? 499 : 502);
      } finally {
        f.store.close();
        f.artifacts.close();
      }
    }
  }
});

test('transport exceptions and synchronous disconnect roll back token publication, never report success', async () => {
  for (const stream of [false, true]) {
    for (const mode of ['write', 'disconnect', ...(stream ? ['headers'] : [])]) {
      const f = await run(stream, mode);
      try {
        assert.equal(f.store.stats().entries, 0);
        assert.equal(f.endings[0][3], mode === 'disconnect' ? 499 : 502);
        assert.equal(f.diagnostics.length, 0);
        if (mode !== 'disconnect') assert.equal(f.published.length, 0);
      } finally {
        f.store.close();
      }
    }
  }
});
