'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const { createContextEvidenceLedger } = require('../../lib/client/context-evidence-ledger');
const {
  createContextEvidenceNativeTools,
} = require('../../lib/client/context-evidence-native-tools');
const { observeContextEvidenceIngress } = require('../../lib/client/context-evidence-ingress');
const { READ_EVIDENCE_TOOL } = require('../../lib/client/context-evidence-tools');
const { createNativeBenchmarkWorkload } = require('./native-compaction-benchmark-workload');
const { createNativeLoopbackRpc } = require('./native-loopback-rpc');
const {
  nativeFixtureOptions,
  nativeFixtureThreadOptions,
  nativeFixtureToolShapes,
  nativeFixtureToolInventory,
  nativeFixtureCodeItem,
  nativeFixtureSse,
  nativeFixtureAcceptance,
  EVIDENCE_NAMESPACE,
} = require('./native-loopback-contract');

const sha = (text) => createHash('sha256').update(text).digest('hex');
const fail = (code) => Object.assign(new Error('Isolated native fixture failed'), { code });
const finalItem = () => ({
  type: 'message',
  id: 'fixture-message',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'offline fixture complete' }],
});

function seedFixtureLedger(ledger) {
  const base = createNativeBenchmarkWorkload();
  const receipts = [];
  function read(name, args, callId) {
    const result = base.reply(name, args);
    if (!result.ok) throw fail('native_fixture_seed_failed');
    receipts.push(
      ledger.capture({
        callId,
        toolName: name,
        arguments: args,
        output: result.text,
        completed: true,
      })
    );
    return result.text;
  }
  for (const document of ['design', 'verification'])
    read('hpm_read_branch', { document }, 'branch-' + document);
  let next = 0;
  do {
    next = JSON.parse(read('hpm_read_page', { offsetBytes: next }, 'page-' + next)).page
      .nextOffsetBytes;
  } while (next !== null);
  read('hpm_read_branch', { document: 'release' }, 'branch-release');
  return receipts;
}

async function stopChild(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return true;
  const ended = new Promise((resolve) => child.once('exit', () => resolve(true)));
  child.stdin.end();
  let timer;
  const delay = () =>
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 3000);
    });
  if (await Promise.race([ended, delay()])) {
    clearTimeout(timer);
    return true;
  }
  clearTimeout(timer);
  child.kill();
  const result = await Promise.race([ended, delay()]);
  clearTimeout(timer);
  return result;
}

async function runNativeEvidenceLoopback(input) {
  const settings = nativeFixtureOptions(input);
  const report = {
    schema: 'hpm.context.native-evidence-loopback',
    version: 4,
    mode: settings.mode,
    syntheticWorkload: true,
    realNativeClient: false,
    realNativeCodeModeObserved: false,
    realProviderRequests: 0,
    mockResponses: true,
    syntheticUsage: true,
    nativeCompactionInvoked: false,
    installedClientIntegrationVerified: false,
    nativeModelSemanticsVerified: false,
    matchedLatencyOrEconomicsVerified: false,
    productionRestarted: false,
    codexConfigurationChanged: false,
    sourceEvidencePreloadedByFixture: true,
    originalSourceReads: 7,
    codeModePrintApi:
      settings.mode === 'legacy-console'
        ? 'console_negative_regression'
        : ['direct', 'discovery'].includes(settings.mode)
          ? null
          : 'native_text',
    passed: false,
    failureCode: null,
    requests: [],
    toolShapes: [],
    dynamicReadReplies: 0,
    completedDynamicReadItems: 0,
    unsafeRequests: 0,
    nativeProcessTerminal: false,
    loopbackServerTerminal: false,
  };
  const ledger = createContextEvidenceLedger({
    owner: 'native-loopback-fixture',
    threadId: 'isolated',
  });
  const sources = seedFixtureLedger(ledger);
  const native = createContextEvidenceNativeTools(ledger);
  const registration =
    settings.mode === 'namespace-direct'
      ? native.registration({ delivery: 'namespace-direct' })
      : null;
  const replies = [];
  const callIds = new Set();
  const completedIds = new Set();
  let sourceIndex = 0;
  let offset = 0;
  let threadId = null;
  let turnId = null;
  let child;
  let rpc;
  let gateway;
  let deferredFailure = null;
  let nextRequest = 0;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-native-loopback-'));

  function noteFailure(code) {
    deferredFailure ??= code;
  }
  function observeRequest(body) {
    const observation = observeContextEvidenceIngress(
      replies.map((item) => item.text),
      body.input
    );
    const outputs = Array.isArray(body.input)
      ? body.input.filter((item) =>
          ['function_call_output', 'custom_tool_call_output'].includes(item?.type)
        )
      : [];
    const strings = outputs.map((item) =>
      typeof item.output === 'string' ? item.output : JSON.stringify(item.output)
    );
    const rootOutput = outputs.find(
      (item) =>
        item.type === 'custom_tool_call_output' && /^fixture-code-call-\d+$/.test(item.call_id)
    );
    report.realNativeCodeModeObserved ||= Boolean(rootOutput);
    if (settings.mode === 'namespace-direct' && rootOutput) {
      const output =
        typeof rootOutput.output === 'string'
          ? rootOutput.output
          : JSON.stringify(rootOutput.output);
      report.evidenceNestedCallableObserved = output.includes('fixture_evidence_nested_callable');
      report.evidenceNestedUnavailableObserved = output.includes(
        'fixture_evidence_nested_unavailable'
      );
    }
    report.requests.push({
      index: ++nextRequest,
      expectedReadReplies: replies.length,
      inputToolOutputBytes: strings.reduce((sum, text) => sum + Buffer.byteLength(text ?? ''), 0),
      exactEnvelopes: observation.pages.filter((page) => page.exactEnvelopeObserved).length,
      equivalentEnvelopes: observation.pages.filter((page) => page.equivalentEnvelopeObserved)
        .length,
      parseBudgetExceeded: observation.parseBudgetExceeded ?? false,
      codeModeOutputObserved: Boolean(rootOutput),
      outputMentionsTruncation: strings.some((text) =>
        /truncat|omitted|characters remaining/i.test(text ?? '')
      ),
      runtimeMarkers: Object.fromEntries(
        [
          'ReferenceError',
          'TypeError',
          'console',
          'not defined',
          'contentItems',
          'Cannot read',
          'page',
          'text',
        ].map((marker) => [
          marker,
          strings.some((text) => typeof text === 'string' && text.includes(marker)),
        ])
      ),
    });
  }

  function responseItem(body) {
    if (settings.mode === 'discovery') return finalItem();
    if (settings.mode === 'direct' || (settings.mode === 'namespace-direct' && nextRequest > 1)) {
      if (sourceIndex >= sources.length) return finalItem();
      return {
        type: 'function_call',
        id: 'fixture-direct-item-' + nextRequest,
        call_id: 'fixture-direct-call-' + nextRequest,
        name: READ_EVIDENCE_TOOL,
        ...(settings.mode === 'namespace-direct' ? { namespace: EVIDENCE_NAMESPACE } : {}),
        arguments: JSON.stringify({
          sourceId: sources[sourceIndex].sourceId,
          digest: sources[sourceIndex].digest,
          offsetBytes: offset,
          limitBytes: 6144,
        }),
      };
    }
    if (settings.mode === 'code-mode-page' ? sourceIndex >= sources.length : nextRequest > 1)
      return finalItem();
    const shapes = nativeFixtureToolShapes(body.tools ?? []);
    const code = shapes.filter(
      (shape) => shape.type === 'custom' && ['exec', 'js', 'code_mode'].includes(shape.name)
    );
    if (code.length > 1) throw fail('native_fixture_code_tool_unavailable');
    report.codeToolSelection =
      code.length === 1 ? 'advertised_wire_tool' : 'fixed_native_probe_not_advertisement_proof';
    return nativeFixtureCodeItem(
      code[0] ?? { type: 'custom', name: 'exec', namespace: 'functions' },
      settings.mode === 'code-mode-page' ? [sources[sourceIndex]] : sources,
      settings.mode,
      offset,
      nextRequest
    );
  }

  try {
    gateway = http.createServer((req, res) => {
      if (
        req.method !== 'POST' ||
        req.url !== '/responses' ||
        req.socket.remoteAddress !== '127.0.0.1' ||
        req.headers.origin ||
        nextRequest >= 32
      ) {
        res.writeHead(403);
        res.end();
        noteFailure('native_fixture_http_refused');
        return;
      }
      const chunks = [];
      let bytes = 0;
      req.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) {
          noteFailure('native_fixture_body_too_large');
          req.destroy();
        } else chunks.push(chunk);
      });
      req.on('error', () => noteFailure('native_fixture_http_failed'));
      req.on('end', () => {
        try {
          const body = normalizeCompactionData(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
            2 * 1024 * 1024
          );
          if (body.model !== 'gpt-5.6-sol') throw fail('native_fixture_model_mismatch');
          observeRequest(body);
          if (nextRequest === 1) {
            report.toolDefinitionShape = {
              toolsPresent: Object.hasOwn(body, 'tools'),
              toolsArray: Array.isArray(body.tools),
              toolsType: typeof body.tools,
              toolsCount: Array.isArray(body.tools) ? body.tools.length : null,
              toolsBytes: Buffer.byteLength(JSON.stringify(body.tools ?? null)),
              namespaceFieldPresent: Object.hasOwn(body, 'tool_namespaces'),
              namespacesArray: Array.isArray(body.tool_namespaces),
            };
            report.toolInventory = nativeFixtureToolInventory(body.tools ?? []);
            report.toolShapes = nativeFixtureToolShapes(body.tools ?? []);
          }
          const item = responseItem(body);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.end(nativeFixtureSse(item));
        } catch (problem) {
          noteFailure(
            problem.code === 'native_fixture_code_tool_unavailable'
              ? problem.code
              : 'native_fixture_request_invalid'
          );
          res.writeHead(400);
          res.end();
        }
      });
    });
    const port = await new Promise((resolve, reject) => {
      gateway.once('error', () => reject(fail('native_fixture_listen_failed')));
      gateway.listen(0, '127.0.0.1', () => resolve(gateway.address().port));
    });
    const env = {};
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'Path', 'PATHEXT'])
      if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, {
      USERPROFILE: directory,
      HOME: directory,
      CODEX_HOME: path.join(directory, 'codex-home'),
      APPDATA: path.join(directory, 'appdata'),
      LOCALAPPDATA: path.join(directory, 'localappdata'),
    });
    for (const key of ['CODEX_HOME', 'APPDATA', 'LOCALAPPDATA']) fs.mkdirSync(env[key]);
    child = spawn(settings.executable, ['app-server', '--listen', 'stdio://'], {
      cwd: directory,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    report.nativePid = child.pid ?? null;
    rpc = createNativeLoopbackRpc(child, {
      onFailure: noteFailure,
      onServerRequest(message) {
        const params = message.params;
        if (
          message.method !== 'item/tool/call' ||
          params?.threadId !== threadId ||
          typeof params?.callId !== 'string' ||
          callIds.has(params.callId) ||
          params.namespace !== (settings.mode === 'namespace-direct' ? EVIDENCE_NAMESPACE : null) ||
          (turnId !== null && params.turnId !== turnId)
        ) {
          report.unsafeRequests++;
          throw fail('native_fixture_tool_refused');
        }
        callIds.add(params.callId);
        const result = registration
          ? registration.reply(params.namespace, params.tool, params.arguments)
          : native.reply(params.tool, params.arguments);
        if (!result?.success || params.tool !== READ_EVIDENCE_TOOL) {
          report.unsafeRequests++;
          throw fail('native_fixture_tool_refused');
        }
        const text = result.contentItems[0].text;
        const value = JSON.parse(text);
        replies.push({
          callId: params.callId,
          text,
          sha256: sha(text),
          bytes: Buffer.byteLength(text),
        });
        report.dynamicReadReplies++;
        if (['direct', 'namespace-direct', 'code-mode-page'].includes(settings.mode)) {
          offset = value.page.nextOffsetBytes;
          if (offset === null) {
            sourceIndex++;
            offset = 0;
          }
        }
        return result;
      },
      onNotification(message) {
        const item = message.params?.item;
        if (message.method === 'turn/started') turnId = message.params?.turn?.id ?? null;
        if (
          ['item/started', 'item/completed'].includes(message.method) &&
          ['commandExecution', 'fileChange', 'mcpToolCall', 'collabToolCall'].includes(item?.type)
        ) {
          report.unsafeRequests++;
          throw fail('native_fixture_side_effect_refused');
        }
        if (
          message.method === 'item/completed' &&
          item?.type === 'dynamicToolCall' &&
          item.tool === READ_EVIDENCE_TOOL &&
          item.success === true &&
          !completedIds.has(item.id)
        ) {
          completedIds.add(item.id);
          report.completedDynamicReadItems++;
        }
        if (message.method === 'error') {
          report.nativeErrorObserved = true;
          const text = message.params?.error?.message;
          report.nativeErrorMentions = Object.fromEntries(
            ['unknown', 'unsupported', 'invalid', 'contentItems', 'not defined'].map((word) => [
              word,
              typeof text === 'string' && text.includes(word),
            ])
          );
        }
      },
    });
    await rpc.call('initialize', {
      clientInfo: { name: 'hpm_loopback_fixture', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    rpc.notify('initialized');
    report.realNativeClient = true;
    const started = await rpc.call(
      'thread/start',
      nativeFixtureThreadOptions(port, directory, native.definitions, settings.mode)
    );
    threadId = started.thread?.id;
    if (typeof threadId !== 'string' || started.thread.ephemeral !== true)
      throw fail('native_fixture_isolation_unconfirmed');
    const completion = rpc.waitFor('turn/completed', (params) => params?.threadId === threadId);
    // Register rejection before dispatch: native failure may close the waiter
    // while turn/start is still pending, without creating an unhandled promise.
    const observedCompletion = completion.then(
      (value) => ({ value }),
      (problem) => ({ problem })
    );
    await rpc.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Isolated synthetic output-transport fixture.' }],
    });
    const completed = await observedCompletion;
    if (completed.problem) throw completed.problem;
    const turnCompleted = completed.value.turn?.status === 'completed';
    report.nativeTurnCompleted = turnCompleted;
    const last = report.requests.at(-1);
    const ledgerState = ledger.inspect();
    report.fullyReadSources = ledgerState.fullyReadSources;
    report.nativeReadTools = native.inspect();
    report.readbackReceipts = replies.map(({ sha256: digest, bytes }, index) => ({
      index,
      sha256: digest,
      bytes,
    }));
    report.passed = nativeFixtureAcceptance({
      mode: settings.mode,
      turnCompleted,
      requests: nextRequest,
      failureCode: deferredFailure,
      fullyReadSources: ledgerState.fullyReadSources,
      readReplies: replies.length,
      exactEnvelopes: last?.exactEnvelopes ?? 0,
      completedDynamicReadItems: report.completedDynamicReadItems,
      realNativeCodeModeObserved: report.realNativeCodeModeObserved,
      evidenceNestedUnavailableObserved: report.evidenceNestedUnavailableObserved ?? false,
      evidenceNestedCallableObserved: report.evidenceNestedCallableObserved ?? false,
    });
    if (!report.passed) report.failureCode = deferredFailure ?? 'native_fixture_output_incomplete';
  } catch (problem) {
    report.failureCode =
      deferredFailure ??
      (typeof problem.code === 'string' && /^native_[a-z_]+$/.test(problem.code)
        ? problem.code
        : 'native_fixture_failed');
  } finally {
    if (rpc) report.rpc = rpc.inspect();
    if (rpc) rpc.close();
    report.nativeProcessTerminal = await stopChild(child);
    if (gateway) {
      gateway.closeAllConnections();
      await new Promise((resolve) => gateway.close(resolve));
      report.loopbackServerTerminal = !gateway.listening;
    }
    ledger.close();
    report.passed &&=
      report.nativeProcessTerminal && report.loopbackServerTerminal && report.unsafeRequests === 0;
    if (!report.passed && !report.failureCode)
      report.failureCode = 'native_fixture_cleanup_incomplete';
  }
  return report;
}

module.exports = { runNativeEvidenceLoopback, seedFixtureLedger };
