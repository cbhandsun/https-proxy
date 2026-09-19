'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildTianxiProbeConclusion,
  extractPrintableStrings,
  extractTianxiUrls,
  mergeTianxiProcessMetadata,
  parseQoderCliLogSummary,
  readLatestQoderRuntimeSummaries,
  summarizeRegistryCredentialCache,
  summarizeAgentCoreHeader,
  summarizeTianxiProcessCommand,
  summarizeTianxiBundle,
} = require('../lib/proxy/tianxi-super-probe');

const source = [
  'channelPCGatewayWS:"wss://as-gateway-channel-pc.lenovomm.com"',
  'asGatewayWS:"wss://as-gateway-test.mbgtest.lenovomm.com/path?token=SECRET"',
  '/api/m/ai/token/out/v2/qoder',
  '/cloud-ai-supermode/api/client-config/query',
  'qoder_vpc_token',
  'qoder_vpc_expires_after',
  'NEWPLUGIN_WRAPPLUGIN_APP_RSASIGN',
  'NEWPLUGIN_XLAGENTCOREPLUGIN_SENDMESSAGE',
  'NEWPLUGIN_XLAGENTCOREPLUGIN_NOTIFY_OPEN_WSS',
  'agentCore task_output task_status act_exec act_resp risk_exec risk_resp auth_check',
].join(';');

const urls = extractTianxiUrls(source);
assert.ok(urls.includes('wss://as-gateway-channel-pc.lenovomm.com'));
assert.ok(urls.includes('wss://as-gateway-test.mbgtest.lenovomm.com'));
assert.ok(!JSON.stringify(urls).includes('SECRET'));

const summary = summarizeTianxiBundle(source);
assert.equal(summary.hasBundle, true);
assert.equal(summary.agentCoreLikely, true);
assert.equal(summary.qoderRefreshLikely, true);
assert.equal(summary.nativeSignatureLikely, true);
assert.ok(summary.foundTokens.includes('act_exec'));
assert.ok(summary.qoderNativeTokens.includes('/api/m/ai/token/out/v2/qoder'));
assert.deepEqual(summary.channelPcGatewayUrls, ['wss://as-gateway-channel-pc.lenovomm.com']);

const binaryStrings = extractPrintableStrings(
  Buffer.concat([
    Buffer.from('/api/m/ai/token/out/v2/qoder\0qoder_vpc_token\0', 'utf8'),
    Buffer.from('/cloud-ai-supermode/api/client-config/query\0', 'utf16le'),
  ])
);
const nativeSummary = summarizeTianxiBundle(binaryStrings);
assert.equal(nativeSummary.qoderRefreshLikely, true);
assert.ok(nativeSummary.qoderNativeTokens.includes('qoder_vpc_token'));

const empty = summarizeTianxiBundle('');
assert.equal(empty.hasBundle, false);
assert.equal(empty.agentCoreLikely, false);

const conclusion = buildTianxiProbeConclusion(
  [{ pid: 1, name: 'XLSmartUI.exe', hasRemoteDebugging: false }],
  [
    { pid: 2, name: 'WSPluginHost.exe', localAddress: '127.0.0.1', localPort: 49304 },
    { pid: 3, name: 'tac-server.exe', localAddress: '0.0.0.0', localPort: 63982 },
  ]
);
assert.equal(conclusion.ordinaryTcpAgentCoreListener, false);
assert.equal(conclusion.localModelManagerPort.localPort, 49304);
assert.equal(conclusion.tacServerPort.localPort, 63982);

const commandSummary = summarizeTianxiProcessCommand({
  name: 'WSPluginHost.exe',
  pid: 42,
  commandLine:
    '"WSPluginHost.exe" --classname=xl.model.manager --remote-debugging-port=0 --pipe XLAgentCorePlugin',
});
assert.equal(commandSummary.className, 'xl.model.manager');
assert.equal(commandSummary.hasRemoteDebugging, true);
assert.equal(commandSummary.isModelManager, true);
assert.equal(commandSummary.isAgentCorePlugin, true);
assert.equal(commandSummary.transport, 'ipc-or-pipe');
assert.deepEqual(
  mergeTianxiProcessMetadata(
    [{ pid: 42, name: 'WSPluginHost.exe', className: '', hasRemoteDebugging: false }],
    [commandSummary]
  )[0],
  commandSummary
);

const headerSummary = summarizeAgentCoreHeader({
  app_id: 'app',
  credentials: {
    type: 'official-login',
    qoder_token: 'sat-eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjEwMH0.signature',
  },
  device_id: 'device',
  user_id: 'user',
});
assert.equal(headerSummary.available, true);
assert.equal(headerSummary.credentialsType, 'object');
assert.deepEqual(headerSummary.fields, ['app_id', 'credentials', 'device_id', 'user_id']);
assert.equal(JSON.stringify(headerSummary).includes('official-login'), false);
assert.equal(headerSummary.credentialExpiry.qoder_token.expired, true);
assert.equal(headerSummary.credentialState.qoderExpired, true);
assert.equal(headerSummary.credentialState.txExpired, null);
assert.equal(headerSummary.credentialState.refreshPossibleWithTx, false);
assert.equal(JSON.stringify(headerSummary).includes('sat-'), false);

const refreshableHeaderSummary = summarizeAgentCoreHeader({
  credentials: {
    qoder_token: 'sat-eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjEwMH0.signature',
    tx_token: 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.signature',
  },
});
assert.equal(refreshableHeaderSummary.credentialState.refreshPossibleWithTx, true);

const registrySummary = summarizeRegistryCredentialCache({
  available: true,
  source: 'tianxi-registry',
  keyScope: 'account',
  hasQoderToken: true,
  hasLoginToken: true,
  credentials: {
    qoder_token: 'do-not-leak',
  },
  credentialExpiry: {
    qoder_token: { expiresAtMs: 100000, expired: true },
    tianxi_login_token: { expiresAtMs: 9999999999000, expired: false },
  },
});
assert.equal(registrySummary.available, true);
assert.equal(registrySummary.hasQoderToken, true);
assert.equal(registrySummary.credentialState.qoderExpired, true);
assert.equal(registrySummary.credentialState.loginExpired, false);
assert.equal(registrySummary.credentialState.refreshPossibleWithLogin, true);
assert.equal(JSON.stringify(registrySummary).includes('do-not-leak'), false);

const catalogReadyLog = [
  '2026-09-17T18:23:38.568-07:00 INFO  debug.message [HeadlessSession] outbound control_request sent request_id=a subtype=fetch_service_account_token bare=false',
  '2026-09-17T18:23:38.579-07:00 INFO  debug.message [HeadlessSession] inbound control_response received request_id=a status=success bare=false',
  '2026-09-17T18:23:38.581-07:00 INFO  [session=s] session.phase.started phase="qoder_runtime.ready" mode="sdk" auth_phase="post-host-job-token" auth_type="qoder-browser" wait_catalog=true',
  '2026-09-17T18:23:38.606-07:00 INFO  debug.message [catalog] Loaded 14 models from fresh disk cache (age 5s)',
  '2026-09-17T18:23:38.610-07:00 INFO  [session=s] session.phase.finished phase="qoder_runtime.ready" duration_ms=29 success=true authenticated=true runtime_ready=true endpoint_ready=false catalog_ready=true byok_ready=false model_reconciled=true warning_count=0',
  '2026-09-17T18:23:38.691-07:00 INFO  debug.message [HeadlessSession] outbound control_response sent request_id=b subtype=initialize status=success duration_ms=129 bare=false model_count=14',
].join('\n');
const catalogReadySummary = parseQoderCliLogSummary(catalogReadyLog);
assert.equal(catalogReadySummary.classification, 'catalog_ready');
assert.equal(catalogReadySummary.fetchServiceAccountToken, true);
assert.equal(catalogReadySummary.controlResponseSuccess, true);
assert.equal(catalogReadySummary.catalogLoadedModelCount, 14);
assert.equal(catalogReadySummary.catalogCacheState, 'fresh');
assert.equal(catalogReadySummary.catalogReady, true);
assert.equal(catalogReadySummary.initializeStatus, 'success');
assert.equal(catalogReadySummary.initializeModelCount, 14);

const expiredLog = [
  '2026-09-18T07:09:45.747-07:00 INFO  debug.message [HeadlessSession] outbound control_request sent request_id=a subtype=fetch_service_account_token bare=false',
  '2026-09-18T07:09:45.759-07:00 INFO  debug.message [HeadlessSession] inbound control_response received request_id=a status=success bare=false',
  '2026-09-18T07:09:45.764-07:00 ERROR debug.message [HeadlessSession] initialize failed: _L [SdkAuthError]: Service Account token has expired',
  '2026-09-18T07:09:45.764-07:00 INFO  debug.message [HeadlessSession] outbound control_response sent request_id=b subtype=initialize status=error duration_ms=26 bare=false',
].join('\n');
const expiredSummary = parseQoderCliLogSummary(expiredLog);
assert.equal(expiredSummary.classification, 'service_account_expired');
assert.equal(expiredSummary.serviceAccountExpired, true);
assert.equal(expiredSummary.initializeStatus, 'error');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-tianxi-probe-'));
try {
  const runsRoot = path.join(tmpRoot, 'logs', 'runs');
  const oldRun = path.join(runsRoot, 'old');
  const newRun = path.join(runsRoot, 'new');
  fs.mkdirSync(oldRun, { recursive: true });
  fs.mkdirSync(newRun, { recursive: true });
  fs.writeFileSync(path.join(oldRun, 'qodercli.log'), expiredLog);
  fs.writeFileSync(path.join(newRun, 'qodercli.log'), catalogReadyLog);
  const oldDate = new Date('2026-09-18T01:00:00.000Z');
  const newDate = new Date('2026-09-18T02:00:00.000Z');
  fs.utimesSync(path.join(oldRun, 'qodercli.log'), oldDate, oldDate);
  fs.utimesSync(path.join(newRun, 'qodercli.log'), newDate, newDate);
  const runs = readLatestQoderRuntimeSummaries({ xlagentRoot: tmpRoot, limit: 1 });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runDir, 'new');
  assert.equal(runs[0].classification, 'catalog_ready');
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log('[tianxi-super-probe.test] ok');
