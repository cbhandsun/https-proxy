'use strict';

// Static vocabulary only. Sharing it with the reader prevents arbitrary module
// paths or user-controlled request strings from becoming diagnostic output.
const STARTUP_IMPORTS = Object.freeze({
  './lib/proxy/logger': 'logger',
  './lib/proxy/runtime-metrics': 'metrics',
  './lib/proxy/core-request-handler': 'core',
  './lib/proxy/lazy-core-request-handler': 'lazy_core',
  './lib/proxy/context-recovery-runtime': 'recovery',
  './lib/proxy/config': 'config',
  './lib/proxy/runtime-support': 'support',
  './lib/proxy/cert': 'cert',
  './lib/proxy/routing': 'routing',
  './lib/proxy/google-official-runtime': 'google',
  './lib/proxy/mcp-hub': 'mcp',
  './lib/proxy/trae-debug-center': 'trae',
  './lib/proxy/websocket-proxy': 'websocket',
  ...Object.fromEntries(
    [
      'auth-resolver',
      'claude-self-test-target',
      'lazy-management-handlers',
      'lazy-feature-handlers',
      'proxy-transport',
      'request-observability',
      'runtime-config-controller',
      'tianxi-sdk-native-options',
      'codex-catalog-sync',
      'runtime/http-agents',
      'upstream-warmup',
      'management-auth',
      'server-lifecycle',
      'ids',
      'local-tls-refresh',
      'models',
      'errors',
      'tools',
      'claude-desktop',
      'diagnostics',
      'sse',
      'lazy-protocol-handlers',
      'handlers',
      'claude-filters',
      'local-handlers',
      'request-utils',
      'audit',
      'conversation-audit-utils',
      'cli-session-routing',
      'upstream-request',
      'entry-auth',
      'upstream-retry',
      'usage-report',
      'management-router',
      'env-tools',
      'management-utils',
      'rate-limits',
      'trae-official',
      'google-official',
      'profile-auth',
      'http-client',
      'validator',
      'usage',
      'model-list',
      'auth-mode',
      'openai-official',
      'workbuddy-official',
      'entry-routing',
      'exception-handlers',
    ].map((name) => ['./lib/proxy/' + name, name.replaceAll('-', '_').replaceAll('/', '_')])
  ),
});

const STARTUP_CALLS = Object.freeze({
  './lib/proxy/config': Object.freeze({
    migrateLegacyRuntimeFiles: 'legacy_runtime_migration',
    loadConfig: 'connection_config_load',
  }),
  './lib/proxy/runtime/http-agents': Object.freeze({
    createRuntimeHttpAgents: 'runtime_http_agents_create',
  }),
  './lib/proxy/proxy-transport': Object.freeze({
    createProxyTransport: 'proxy_transport_create',
  }),
  './lib/proxy/runtime-support': Object.freeze({
    createRuntimeSupport: 'runtime_support_create',
  }),
});

const STARTUP_NESTED_IMPORTS = Object.freeze({
  lazyCore: Object.freeze({ './core-request-handler': 'core_lazy_implementation' }),
  core: Object.freeze(
    Object.fromEntries(
      [
        'entry-routing',
        'entry-auth',
        'errors',
        'logger',
        'antigravity-credentials',
        'request-utils',
        'request-timing',
        'performance-policy',
        'direct-request-streaming',
        'direct-request-contract',
        'forced-stream-collector',
        'handlers/claude-filtered-stream',
        'json-object-response-guard',
        'codex-responses-contract',
        'provider-context-request',
        'openai-context-management',
        'anthropic-context-management',
        'gemini-context-management',
        'utf8-stream',
        'native-responses-compaction',
        'handlers/native-compaction-response',
        'workbuddy-standalone-compaction',
        'workbuddy-official',
        'workbuddy-request-contract',
        'deepseek-request-contract',
        'workbuddy-http-transport',
        'context-recovery-diagnostics',
        'conversation-audit-utils',
        'context-budget-manager',
        'handlers/converted-rate-limit',
        'handlers/failure-terminal',
        'handlers/route-response-helpers',
        'handlers/upstream-terminal-state',
        'handlers/downstream-cancellation',
        'handlers/upstream-connection-observer',
        'handlers/upstream-terminal-frame',
        'handlers/upstream-timeout',
        'handlers/upstream-stream-guard',
        'handlers/client-diagnostics',
        'upstream-retry',
        'client-context-target',
        'context-api-evidence-runtime',
        'context-api-evidence-http',
        'context-api-evidence-protocol',
        'context-transport-policy',
        'context-recovery-lifecycle',
        'context-recovery-protocol',
        'context-recovery-rejection',
        'context-recovery-observer',
        'context-recovery-compaction',
        'context-recovery-http-entry',
        'context-recovery-converted-http',
        'context-api-evidence-observer',
      ].map((name) => [
        './' + name,
        name === 'utf8-stream'
          ? 'core_utf_eight_stream'
          : 'core_' + name.replaceAll('-', '_').replaceAll('/', '_'),
      ])
    )
  ),
  handlers: Object.freeze(
    Object.fromEntries(
      [
        'config',
        'logger',
        'management-utils',
        'handlers/http-utils',
        'handlers/code-assist',
        'handlers/responses-state',
        'handlers/request-validators',
        'lazy-route-handlers',
      ].map((name) => ['./' + name, 'handlers_' + name.replaceAll('-', '_').replaceAll('/', '_')])
    )
  ),
});

module.exports = { STARTUP_IMPORTS, STARTUP_CALLS, STARTUP_NESTED_IMPORTS };
