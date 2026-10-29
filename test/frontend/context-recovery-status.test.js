'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createContextRecoveryDiagnostics,
} = require('../../lib/proxy/context-recovery-diagnostics');
const { composeContextProtocolOptions } = require('../../lib/proxy/context-recovery-policy');

test('loaded runtime policy is shown separately from overall client qualification, including mismatches', async () => {
  const { formatContextRecoveryStatus: format } =
    await import('../../tauri-ui/src/app/models/context-recovery-status.js');
  const diagnostics = createContextRecoveryDiagnostics();
  const config = { appSettings: { contextPolicyVersion: 2 } };
  diagnostics.attachPlannerOptions(composeContextProtocolOptions({}, config));
  const status = diagnostics.inspect(config);
  assert.match(format(status), /代理已载入该策略/);
  assert.match(format(status), /完整请求路径与客户端兼容尚未验收/);
  assert.match(format(diagnostics.inspect({})), /代理载入的策略与当前配置不一致/);
  diagnostics.attachPlannerOptions({});
  assert.match(format(diagnostics.inspect(config)), /代理规划状态不可用/);
  const old = { ...status, policy: { ...status.policy } };
  for (const key of ['runtimeApplication', 'appliedVersion', 'appliedPolicy'])
    delete old.policy[key];
  assert.match(format(old), /已选择原生优先，普通请求规划尚未核验/);
  let hooks = 0;
  for (const extra of [
    { runtimeApplication: 'matched', appliedVersion: 1, appliedPolicy: 'legacy' },
    { runtimeApplication: 'mismatch', appliedVersion: 2, appliedPolicy: 'native-first' },
    { runtimeApplication: 'unverified', appliedVersion: 2, appliedPolicy: 'native-first' },
    { runtimeApplication: 'PRIVATE', appliedVersion: null, appliedPolicy: null },
    { runtimeApplication: 'matched', appliedVersion: 3, appliedPolicy: 'native-first' },
    { runtimeApplication: 'matched', appliedVersion: 2, appliedPolicy: 'PRIVATE' },
  ]) {
    const text = format({ ...status, policy: { ...status.policy, ...extra } });
    assert.match(text, /上下文策略版本未核验/);
    assert.doesNotMatch(text, /PRIVATE|已载入/);
  }
  const malicious = Object.defineProperty({ ...status.policy }, 'appliedPolicy', {
    get() {
      hooks++;
      throw Error('PRIVATE');
    },
  });
  assert.match(format({ ...status, policy: malicious }), /上下文策略版本未核验/);
  assert.equal(hooks, 0);
});

test('policy presentation separates legacy migration and selected intent from application', async () => {
  const { formatContextRecoveryStatus: format } =
    await import('../../tauri-ui/src/app/models/context-recovery-status.js');
  const diagnostics = createContextRecoveryDiagnostics();
  const status = diagnostics.inspect({});
  assert.match(format(status), /旧版上下文策略，尚未迁移/);
  assert.match(
    format(diagnostics.inspect({ appSettings: { contextPolicyVersion: 2 } })),
    /已选择原生优先，普通请求规划尚未核验/
  );
  assert.match(
    format(
      diagnostics.inspect({
        appSettings: { contextPolicyVersion: 2, contextRecoveryEnabled: true },
      })
    ),
    /已选择精确恢复增强，普通请求规划尚未核验/
  );
  const legacy = { ...status };
  delete legacy.policy;
  assert.match(format(legacy), /上下文策略版本未核验/);
  let executed = 0;
  for (const policy of [
    null,
    {},
    { ...status.policy, version: 3 },
    { ...status.policy, requestedPolicy: 'PRIVATE_VALUE' },
    { ...status.policy, migrationRequired: false },
    {
      get version() {
        executed++;
        throw Error('PRIVATE_VALUE');
      },
    },
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw Error('PRIVATE_VALUE');
        },
      }
    ),
  ]) {
    const text = format({ ...status, policy });
    assert.match(text, /上下文策略版本未核验/);
    assert.doesNotMatch(text, /PRIVATE_VALUE|已选择|尚未迁移/);
  }
  assert.equal(executed, 0);
});

test('retention presentation shows runtime limits and safely handles old or malformed metadata', async () => {
  const { formatContextRecoveryStatus: format } =
    await import('../../tauri-ui/src/app/models/context-recovery-status.js');
  const status = createContextRecoveryDiagnostics().inspect({});
  assert.match(format(status), /最多保留 24 小时，读取和重启不续期；已有记录保持原到期时间/);
  assert.match(format(status), /整个代理最多同时维护 4 个活动聊天，分支共享限额/);
  const legacy = { ...status };
  delete legacy.retention;
  assert.match(format(legacy), /留存期限与聊天容量未核验/);
  assert.doesNotMatch(format(legacy), /运行状态不可用/);
  let getters = 0;
  const getter = {
    get absoluteTtlMs() {
      getters++;
      throw Error('PRIVATE_DATA');
    },
  };
  const hostile = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw Error('PRIVATE_DATA');
      },
    }
  );
  for (const retention of [
    null,
    undefined,
    [],
    {},
    getter,
    hostile,
    { ...status.retention, policyVersion: 3 },
    ...[-1, 0, 1, 60001, 86400001, NaN, Infinity, Number.MAX_SAFE_INTEGER, 'PRIVATE_DATA'].map(
      (absoluteTtlMs) => ({ ...status.retention, absoluteTtlMs })
    ),
    ...[0, -1, 1.5, 257, NaN, Infinity, 'PRIVATE_DATA'].map((maxActiveRoots) => ({
      ...status.retention,
      maxActiveRoots,
    })),
  ]) {
    const text = format({ ...status, retention });
    assert.match(text, /留存期限与聊天容量未核验/);
    assert.doesNotMatch(text, /PRIVATE_DATA|最多保留|最多同时维护/);
  }
  assert.equal(getters, 0);
  for (const [absoluteTtlMs, maxActiveRoots] of [
    [60000, 1],
    [86400000, 256],
  ]) {
    const text = format({
      ...status,
      retention: { policyVersion: 1, absoluteTtlMs, maxActiveRoots },
    });
    assert.match(
      text,
      absoluteTtlMs === 86400000
        ? /最多保留 24 小时/
        : new RegExp(`最多保留 ${absoluteTtlMs / 60000} 分钟`)
    );
    assert.match(text, new RegExp(`最多同时维护 ${maxActiveRoots} 个`));
  }
});

test('recovery UI reports actual flags and counters, with memory/transport/acceptance limitations', async () => {
  const { formatContextRecoveryStatus: format } =
    await import('../../tauri-ui/src/app/models/context-recovery-status.js');
  const runtime = createContextRecoveryDiagnostics();
  const config = { appSettings: { contextRecoveryEnabled: true } };
  assert.match(format(runtime.inspect(config)), /等待配置应用/);
  runtime.configure(true);
  runtime.record('responses', 'bound');
  runtime.record('chat', 'completed');
  runtime.record('claude', 'failed');
  const text = format(runtime.inspect(config));
  assert.match(text, /仅限受支持路径/);
  assert.match(text, /绑定 1，绑定不足 0，内部续接完成 1，失败 1/);
  assert.match(text, /原文仅内存，重启丢失；WebSocket 恢复为实验路径，完整兼容未验收/);
  assert.doesNotMatch(text, /WebSocket 透传/);
  assert.match(text, /插件与实际客户端验收未核验/);
  runtime.configure(false);
  assert.match(format(runtime.inspect({})), /已关闭/);
  assert.match(format(runtime.inspect(null)), /配置无效/);
});

test('recovery presentation rejects malicious, incompatible and invalid status without rendering source text or getters', async () => {
  const { formatContextRecoveryStatus: format } =
    await import('../../tauri-ui/src/app/models/context-recovery-status.js');
  const status = createContextRecoveryDiagnostics().inspect({});
  let getters = 0;
  for (const value of [
    undefined,
    null,
    '',
    [],
    {},
    { ...status, schemaVersion: 2 },
    { ...status, storage: 'disk' },
    { ...status, state: 'PRIVATE_DATA' },
    { ...status, restartRetention: true },
    { ...status, webSocket: 'supported' },
    { ...status, configValid: '<script>private</script>' },
    { ...status, appliedEnabled: 'true' },
    { ...status, requestedEnabled: 1 },
    { ...status, counters: null },
    {
      ...status,
      get counters() {
        getters++;
        return {};
      },
    },
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('secret');
        },
      }
    ),
  ]) {
    assert.match(format(value), /运行状态不可用/);
    assert.doesNotMatch(format(value), /<script>|private|secret/);
  }
  for (const count of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 'private'])
    assert.match(
      format({
        ...status,
        counters: { ...status.counters, chat: { ...status.counters.chat, completed: count } },
      }),
      /运行状态不可用/
    );
  assert.equal(getters, 0);
  const maximal = {
    ...status,
    counters: Object.fromEntries(
      ['chat', 'responses', 'claude'].map((kind) => [
        kind,
        { bound: Number.MAX_SAFE_INTEGER, bindingUnavailable: 0, completed: 0, failed: 0 },
      ])
    ),
  };
  assert.match(format(maximal), new RegExp(`绑定 ${Number.MAX_SAFE_INTEGER}`));
});

test('recovery presentation distinguishes persistent storage from restart authority and unavailable storage', async () => {
  const { formatContextRecoveryStatus: format } =
    await import('../../tauri-ui/src/app/models/context-recovery-status.js');
  const diagnostics = createContextRecoveryDiagnostics();
  let state = { storage: 'persistent', appliedEnabled: false, state: 'initializing' };
  diagnostics.attachLifecycle({ inspect: () => state });
  const config = { appSettings: { contextRecoveryEnabled: true } };
  assert.match(format(diagnostics.inspect(config)), /等待配置应用/);
  assert.match(format(diagnostics.inspect(config)), /原文加密留存，跨重启读回尚未完成验收/);
  state = { ...state, state: 'failed' };
  assert.match(format(diagnostics.inspect(config)), /运行不可用/);
  state = null;
  assert.match(format(diagnostics.inspect(config)), /原文存储不可用/);
});

test('recovery location uses the responding runtime and rejects malformed or executable metadata', async () => {
  const { formatContextRecoveryStatus: format } =
    await import('../../tauri-ui/src/app/models/context-recovery-status.js');
  const status = createContextRecoveryDiagnostics().inspect({});
  for (const directory of [
    'E:\\runtime\\context-recovery-v1',
    '/srv/proxy/context-recovery-v1',
    '/context-recovery-v1',
    '/srv/<img src=x>/context-recovery-v1',
  ]) {
    const text = format(status, { host: 'remote-executor-1', contextRecoveryDirectory: directory });
    assert.ok(
      text.includes(`运行主机：remote-executor-1；加密留存目录（启用后使用）：${directory}`)
    );
    assert.match(text, /原文仅内存，重启丢失/);
  }
  let getters = 0;
  for (const runtime of [
    undefined,
    null,
    [],
    {},
    { host: 'secret\nvalue', contextRecoveryDirectory: '/runtime/context-recovery-v1' },
    { host: 'a'.repeat(256), contextRecoveryDirectory: '/runtime/context-recovery-v1' },
    ...[
      '',
      'relative/context-recovery-v1',
      '/private',
      '/secret\n/context-recovery-v1',
      '/'.repeat(4097) + 'context-recovery-v1',
      12,
    ].map((directory) => ({
      host: 'secret-host',
      contextRecoveryDirectory: directory,
    })),
    {
      get host() {
        getters++;
        return 'secret-host';
      },
    },
    {
      host: 'secret-host',
      get contextRecoveryDirectory() {
        getters++;
        return '/private';
      },
    },
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw Error('secret-value');
        },
      }
    ),
  ]) {
    const text = format(status, runtime);
    assert.match(text, /运行主机与留存目录未核验/);
    assert.doesNotMatch(text, /secret|private/);
  }
  assert.equal(getters, 0);
  const legacy = format({ ...status, webSocket: 'passthrough' });
  assert.match(legacy, /WebSocket 透传/);
  assert.doesNotMatch(legacy, /WebSocket 恢复为实验路径/);
});

test('actual status refresh renders recovery metadata as text in overview and settings and clears stale location', async (t) => {
  const { configureToolStatus, refreshProxyStatus } =
    await import('../../tauri-ui/src/app/domains/tool-status.js');
  const { formatContextRecoveryStatus } =
    await import('../../tauri-ui/src/app/models/context-recovery-status.js');
  const previousDocument = global.document;
  const previousWindow = global.window;
  t.after(() => {
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  });
  global.document = { createElement: () => ({}), createTextNode: (text) => ({ text }) };
  global.window = { proxyManager: { command: async () => ({ output: 'Proxy running PID: 123' }) } };
  const elements = Object.fromEntries(
    [
      'heroProxyStatus',
      'heroContextRecoveryDiagnostics',
      'contextRecoveryRuntimeStatus',
      'heroPortDiagnostics',
    ].map((id) => [
      id,
      {
        textContent: '',
        append() {},
        set innerHTML(_) {
          assert.fail('HTML sink used');
        },
      },
    ])
  );
  let health = {
    appId: 'https-proxy-manager',
    contextRecovery: createContextRecoveryDiagnostics().inspect({}),
    runtime: {
      host: 'remote-executor',
      contextRecoveryDirectory: '/srv/<img src=x>/context-recovery-v1',
    },
    ports: { entries: [] },
  };
  const dependencies = Object.fromEntries(
    [
      'CLAUDE_DESKTOP_PROCESS_VERIFICATION_PROMPT',
      'STARTUP_STATUS_GRACE_MS',
      'STARTUP_STATUS_RETRY_MS',
      'applyClaudeDesktopBadges',
      'codexDesktopConnectionDetails',
      'formatCodexDesktopDrift',
      'ensureClaudeDesktop',
      'formatClaudeDesktopStatus',
      'populatePromptPresetsDropdown',
      'refreshCertStatusAfterProxyOnline',
      'renderClientActivity',
      'resolveClaudeDesktopModel',
      'routeIdOfClaudeDesktopModel',
      'showDiagnosticsView',
      'showToast',
      'startupStatusStartedAt',
    ].map((name) => [name, () => {}])
  );
  configureToolStatus({
    ...dependencies,
    $: (id) => elements[id],
    config: {},
    sharedAppState: {},
    isMonitorVisible: () => false,
    perfStart: () => () => {},
    clearElement() {},
    formatContextRecoveryStatus,
    checkProxyHealth: async () => health,
  });
  await refreshProxyStatus({ startup: false });
  assert.match(elements.contextRecoveryRuntimeStatus.textContent, /运行主机：remote-executor/);
  assert.match(elements.contextRecoveryRuntimeStatus.textContent, /<img src=x>/);
  assert.equal(
    elements.heroContextRecoveryDiagnostics.textContent,
    elements.contextRecoveryRuntimeStatus.textContent
  );
  health = null;
  await refreshProxyStatus({ startup: false });
  assert.match(elements.contextRecoveryRuntimeStatus.textContent, /运行状态不可用/);
  assert.doesNotMatch(elements.contextRecoveryRuntimeStatus.textContent, /remote-executor|<img/);
});
