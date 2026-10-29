'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  businessHandler,
  runStagedClientDiagnostic,
} = require('../scripts/lib/codex-stop-diagnostic');
const {
  getDiagnosticContract,
  parseDiagnosticReceipt,
} = require('../scripts/lib/codex-stop-diagnostic-contract');
const {
  parseClaudeDiagnosticReceipt,
} = require('../scripts/lib/claude-context-diagnostic-contract');

test('Claude policy accepts only original Messages paths and exact x-api-key without Responses rewriting', async () => {
  for (const variant of [
    'normal',
    'beta',
    'bearer-only',
    'dual-auth',
    'wrong-api',
    'responses',
    'wrong-client',
    'default',
    'unknown-query',
  ]) {
    let calls = 0,
      failed = 0,
      destroyed = false,
      observed;
    const body = {
      model: 'synthetic-model',
      stream: true,
      messages: [{ role: 'user', content: 'synthetic' }],
    };
    const path =
      variant === 'beta'
        ? '/v1/messages?beta=true'
        : variant === 'responses'
          ? '/v1/responses'
          : variant === 'unknown-query'
            ? '/v1/messages?beta=false'
            : '/v1/messages';
    const active = {
      current: {
        client: variant === 'wrong-client' ? 'codex' : 'claude',
        mode: variant === 'default' ? 'default' : 'enhanced',
        upstreamToken: 'synthetic',
        upstream: {
          respond(input) {
            calls++;
            observed = input;
            return {
              statusCode: 200,
              contentType: 'text/event-stream; charset=utf-8',
              wire: Buffer.from('synthetic-stream'),
            };
          },
        },
      },
    };
    const handler = businessHandler(active, () => failed++, 'claude');
    await handler.respond({
      path,
      apiKey:
        variant === 'bearer-only' ? undefined : variant === 'wrong-api' ? 'wrong' : 'synthetic',
      authorization: ['bearer-only', 'dual-auth'].includes(variant)
        ? 'Bearer synthetic'
        : undefined,
      bytes: Buffer.from(JSON.stringify(body)),
      response: {
        destroyed: false,
        writeHead() {},
        end() {},
        destroy() {
          destroyed = true;
        },
      },
    });
    const valid = ['normal', 'beta'].includes(variant);
    assert.equal(calls, valid ? 1 : 0, variant);
    assert.equal(failed, valid ? 0 : 1, variant);
    assert.equal(destroyed, !valid, variant);
    assert.equal(handler.pending(), 0);
    if (valid) assert.deepEqual(observed, { path, body });
  }
});
test('Claude and Codex receipts reject each other and invalid client selectors before any allocation', async () => {
  const common = {
    schemaVersion: 1,
    diagnosticPassed: true,
    failedPhase: null,
    failureCode: null,
    ownedTreeEmpty: true,
    syntheticSocketsClosed: true,
    installedQualified: false,
    realProvider: false,
    retention24hQualified: false,
    modelRequests: 0,
    probesPassed: true,
    tlsVerified: true,
    nonLoopbackBlocked: true,
    listenerOwned: true,
  };
  const codex = JSON.stringify({ ...common, scope: getDiagnosticContract('codex').SCOPE }) + '\n';
  const claude = JSON.stringify({ ...common, scope: getDiagnosticContract('claude').SCOPE }) + '\n';
  assert.doesNotThrow(() => parseDiagnosticReceipt(codex));
  assert.doesNotThrow(() => parseClaudeDiagnosticReceipt(claude));
  assert.throws(() => parseDiagnosticReceipt(claude));
  assert.throws(() => parseClaudeDiagnosticReceipt(codex));
  const failed = {
    ...common,
    scope: getDiagnosticContract('claude').SCOPE,
    diagnosticPassed: false,
    failedPhase: 'codex-enhanced-cli-compact-3',
  };
  assert.throws(() => parseClaudeDiagnosticReceipt(JSON.stringify(failed) + '\n'));
  for (const client of ['', null, undefined, 'gemini', 'CLAUDE', [], {}, 'claude\n']) {
    if (client !== undefined) assert.throws(() => businessHandler({}, () => {}, client));
    else assert.doesNotThrow(() => businessHandler({}, () => {}, client));
    if (client !== undefined) assert.throws(() => getDiagnosticContract(client));
    await assert.rejects(runStagedClientDiagnostic([], client, {}));
  }
});
