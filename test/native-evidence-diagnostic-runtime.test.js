'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const actualRuntime = require('../scripts/lib/native-evidence-v2-runtime');
const actualPlan = require('../scripts/lib/native-evidence-diagnostic-plan');

function fixture(t, mode, run = 'run1') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-diagnostic-runtime-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const guard = path.join(root, 'guard.txt');
  fs.writeFileSync(guard, 'synthetic guard');
  const reportPath = path.join(root, 'diagnostic-result.json');
  const plan = {
    reportPath,
    attemptPath: path.join(root, 'attempt.json'),
    route: {},
    priorRequests: run === 'run3' ? 88 : run === 'run2' ? 87 : 86,
    cumulativeLimit: run === 'run3' ? 94 : run === 'run2' ? 93 : 92,
    authorizationSha256: 'a'.repeat(64),
    protectedFiles: [
      { path: guard, sha256: createHash('sha256').update('synthetic guard').digest('hex') },
    ],
  };
  if (run === 'run3') {
    fs.mkdirSync(path.join(root, 'lib/client'), { recursive: true });
    for (const name of ['context-evidence-native-tools.js', 'context-evidence-native-delivery.js'])
      fs.copyFileSync(
        path.join(__dirname, '../lib/client', name),
        path.join(root, 'lib/client', name)
      );
  }
  let gatewayOptions, rpcOptions, terminalResolve;
  let spawned = 0;
  const proxyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-native-v2-proxy-'));
  t.after(() => fs.rmSync(proxyDir, { recursive: true, force: true }));
  const eventFile = path.join(proxyDir, 'events.jsonl');
  const exitedChild = () =>
    Object.assign(new EventEmitter(), { exitCode: 0, stdout: new EventEmitter() });
  const mocks = {
    './native-evidence-diagnostic-plan': {
      ...actualPlan,
      verifyNativeEvidenceDiagnosticPlan: (_root, selectedRun) => {
        assert.equal(selectedRun, run);
        return plan;
      },
    },
    './native-evidence-v2-runtime': {
      ...actualRuntime,
      startIsolatedEvidenceProxy: async () => ({
        child: exitedChild(),
        directory: proxyDir,
        port: 1234,
        eventFile,
        ready: async () => {
          if (mode === 'readiness-failure')
            throw Object.assign(new Error('private-failure'), {
              code: 'native_diagnostic_mock_readiness_failed',
            });
        },
      }),
    },
    'node:child_process': {
      spawn: () => {
        spawned++;
        return exitedChild();
      },
    },
    './native-evidence-v2-gateway': {
      createNativeEvidenceV2Gateway: (options) => {
        gatewayOptions = options;
        const server = new EventEmitter();
        Object.assign(server, {
          listening: false,
          listen(_port, _host, callback) {
            server.listening = true;
            callback();
          },
          address: () => ({ port: 1235 }),
          closeAllConnections() {},
          close(callback) {
            server.listening = false;
            callback();
          },
        });
        return { server };
      },
    },
    './native-loopback-rpc': {
      createNativeLoopbackRpc: (_child, options) => {
        rpcOptions = options;
        return {
          notify() {},
          close() {},
          inspect: () => ({ mock: true }),
          waitFor: () =>
            new Promise((resolve) => {
              terminalResolve = resolve;
            }),
          async call(method) {
            if (method === 'thread/start')
              return { thread: { id: 'thread-1', ephemeral: mode !== 'invalid-isolation' } };
            if (method !== 'turn/start') return {};
            gatewayOptions.budget.admit();
            const row = {
              status: 200,
              responseCompletedEvents: 1,
              responseFailedEvents: 0,
              exactRetainedEvidence: [],
            };
            gatewayOptions.report.transport.push(row);
            fs.writeFileSync(
              eventFile,
              JSON.stringify({
                kind: 'route',
                reqId: gatewayOptions.prefix + '-1',
                profileId: 'openai-official',
              })
            );
            rpcOptions.onNotification({
              method: 'turn/started',
              params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
            });
            const call = (callId, tool, args) =>
              rpcOptions.onServerRequest({
                method: 'item/tool/call',
                params: {
                  threadId: 'thread-1',
                  turnId: 'turn-1',
                  callId,
                  namespace: null,
                  tool,
                  arguments: args,
                },
              });
            const complete = (id, tool) =>
              rpcOptions.onNotification({
                method: 'item/completed',
                params: {
                  threadId: 'thread-1',
                  turnId: 'turn-1',
                  item: { id, tool, type: 'dynamicToolCall', success: true },
                },
              });
            const listed = await call(
              'list-1',
              'hpm_list_retained_evidence',
              mode === 'bad-tool-arguments' ? { limit: 17 } : {}
            );
            complete('list-1', 'hpm_list_retained_evidence');
            const source = JSON.parse(listed.contentItems[0].text).sources[0];
            const read = await call('read-1', 'hpm_read_retained_evidence', {
              sourceId: source.sourceId,
              digest: source.digest,
              offsetBytes: 0,
              limitBytes: 8192,
            });
            complete('read-1', 'hpm_read_retained_evidence');
            row.exactRetainedEvidence = gatewayOptions.workload.inspectReadbackInput([
              { type: 'function_call_output', output: read.contentItems[0].text },
            ]);
            if (mode === 'missing-ingress') row.exactRetainedEvidence = [];
            if (mode === 'guard-changed') fs.writeFileSync(guard, 'synthetic changed guard');
            const turn = { id: 'turn-1', status: 'completed' };
            rpcOptions.onNotification({
              method: 'turn/completed',
              params: { threadId: 'thread-1', turn },
            });
            terminalResolve({ turn });
            return {};
          },
        };
      },
    },
  };
  const file = require.resolve('../scripts/lib/native-evidence-diagnostic-runtime');
  const prior = require.cache[file];
  delete require.cache[file];
  const load = Module._load;
  let runtime;
  try {
    Module._load = function (id, ...rest) {
      return Object.hasOwn(mocks, id) ? mocks[id] : load.call(this, id, ...rest);
    };
    runtime = require(file);
  } finally {
    Module._load = load;
    if (prior) require.cache[file] = prior;
    else delete require.cache[file];
  }
  return { root, runtime, reportPath, spawned: () => spawned };
}

test('run2 orchestration uses its fresh plan and includes the consumed prior request', async (t) => {
  const f = fixture(t, 'success', 'run2');
  const report = await f.runtime.runNativeEvidenceDiagnostic(f.root, () => {}, 'run2');
  assert.equal(report.diagnosticRun, 'run2');
  assert.equal(report.diagnosticCompleted, true);
  assert.equal(report.requestBudget.priorRequests, 87);
  assert.equal(report.requestBudget.cumulativeLimit, 93);
  assert.equal(report.requestBudget.cumulativeRequests, 88);
  assert.equal(report.nativeSemanticAcceptanceVerified, false);
});

test('run3 uses product definitions, snapshots candidate sources and keeps the six-request bound', async (t) => {
  const f = fixture(t, 'success', 'run3');
  const report = await f.runtime.runNativeEvidenceDiagnostic(f.root, () => {}, 'run3');
  assert.equal(report.diagnosticCompleted, true);
  assert.equal(report.candidateWorkload.productNativeDefinitionsUsed, true);
  assert.equal(report.candidateWorkload.installedHostIntegrationVerified, false);
  assert.equal(report.requestBudget.priorRequests, 88);
  assert.equal(report.requestBudget.cumulativeLimit, 94);
  assert.equal(report.requestBudget.cumulativeRequests, 89);
  assert.equal(
    report.executedSources.some(
      (row) => row.file === 'lib/client/context-evidence-native-tools.js'
    ),
    true
  );
});

for (const mode of [
  'success',
  'bad-tool-arguments',
  'readiness-failure',
  'invalid-isolation',
  'missing-ingress',
  'guard-changed',
]) {
  test(`isolated diagnostic orchestration with mock transport: ${mode}`, async (t) => {
    const f = fixture(t, mode);
    const report = await f.runtime.runNativeEvidenceDiagnostic(f.root);
    assert.equal(report.diagnosticCompleted, mode === 'success');
    assert.equal(report.phase, 'terminal');
    assert.equal(report.nativeProcessTerminal, true);
    assert.equal(report.isolatedProxyTerminal, true);
    assert.equal(report.isolatedDirectoriesRemoved, true);
    assert.equal(report.nativeSemanticAcceptanceVerified, false);
    assert.equal(report.installedClientConfigurationWritten, false);
    assert.equal(report.requestBudget.cumulativeRequests <= 92, true);
    assert.equal(f.spawned(), mode === 'readiness-failure' ? 0 : 1);
    assert.equal(JSON.stringify(report).includes('private-failure'), false);
    assert.equal(fs.existsSync(f.reportPath), true);
    if (mode === 'bad-tool-arguments')
      assert.equal(report.toolFailureShape.keyConstraints.limit, 'out_of_range');
  });
}
