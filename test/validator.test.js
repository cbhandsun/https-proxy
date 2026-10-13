const assert = require('assert');

const {
  validateConfig,
  validateEntryAuthConfig,
  validateMcpHubConfig,
} = require('../lib/proxy/validator');

{
  const valid = validateConfig({
    activeProfile: 'main',
    profiles: [
      {
        id: 'main',
        protocol: 'openai',
        targetUrl: 'https://api.example.test/v1',
        retryUnsafeRequests: true,
      },
    ],
    localServer: { host: 'localhost', listenPort: 3443, basePath: '/v1' },
    entryServers: [{ host: '127.0.0.1', listenPort: 3445, basePath: '/v1' }],
    modelRoutes: [
      {
        from: 'default',
        to: 'gpt-5.6-sol',
        profileId: 'main',
        group: 'gpt',
        clientProtocols: ['openai-chat'],
      },
    ],
    claudeDesktop: {
      enabled: false,
      mode: 'proxy',
      baseUrl: 'https://localhost:3443',
      token: '',
      models: [
        {
          routeId: 'claude-sonnet-4-6',
          upstreamModel: 'gpt-5.6-sol',
          profileId: 'main',
          supports1m: true,
        },
      ],
    },
    appSettings: { verifyUpstreamTls: true, conversationAuditEnabled: false },
    protocolOptions: {
      thinkingPolicy: 'drop',
      contextWindowPolicy: 'overflow-drop-oldest',
      clientContextTokens: 200000,
      maxContextTokens: 0,
      outputReserveTokens: 8192,
      toolReserveTokens: 4096,
      reasoningReserveTokens: 8192,
      safetyMarginTokens: 4096,
      contextKeepRecentTurns: 2,
      maxHistoricalToolChars: 800,
      maxHistoricalMessageChars: 4000,
      contextCompactionMinSavingsTokens: 2048,
      contextCompactionTargetRatio: 0.9,
      contextCacheCandidateMinTokens: 1024,
      providerCacheHintsPolicy: 'diagnostics-only',
      workbuddyOperationalInputTokens: 96 * 1024,
      workbuddyPreflightBodyBytes: 680 * 1024,
      workbuddyTargetBodyBytes: 384 * 1024,
      workbuddyMinCleanupBytes: 64 * 1024,
      workbuddyMaxSelectedTools: 24,
      maxSseBufferChars: 1024 * 1024,
    },
    mcpHub: { servers: [{ id: 'filesystem', url: 'http://127.0.0.1:3001' }], routing: [] },
    entryAuth: {
      enabled: true,
      keys: [
        {
          id: 'team-a',
          key: 'entry-key',
          allowedEntryProtocols: ['openai-chat'],
          allowedEntryPorts: [3447],
          allowedProfileIds: ['main'],
        },
      ],
    },
  });
  assert.strictEqual(valid.valid, true);
  assert.deepStrictEqual(valid.warnings, []);

  const invalid = validateConfig({
    activeProfile: 'missing',
    profiles: [
      { id: 'main', protocol: 'openai', targetUrl: 'file:///tmp/key' },
      { id: 'main', protocol: 'shell' },
    ],
    localServer: { host: 'local/host', listenPort: 70000, basePath: 'v1' },
    mcpHub: { servers: [{ url: 'file:///tmp/socket' }], routing: [] },
  });
  assert.strictEqual(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => error.includes('activeProfile')));
  assert.ok(invalid.errors.some((error) => error.includes('duplicated')));
  assert.ok(invalid.errors.some((error) => error.includes('unsupported protocol')));
  assert.ok(invalid.errors.some((error) => error.includes('invalid targetUrl')));
  assert.ok(invalid.errors.some((error) => error.includes('listenPort')));
  assert.ok(invalid.errors.some((error) => error.includes('basePath')));
  assert.ok(invalid.errors.some((error) => error.includes('mcpHub.servers')));
}

{
  const invalidBoundaries = validateConfig({
    activeProfile: 'main',
    profiles: [
      {
        id: 'main',
        protocol: 'openai',
        targetUrl: 'https://api.example.test/v1',
        retryUnsafeRequests: 'yes',
      },
    ],
    localServer: { host: 'localhost', listenPort: 3443, basePath: '/v1' },
    entryServers: {},
    modelRoutes: [
      {
        from: '',
        profileId: 'missing',
        group: '<script>',
        clientProtocols: ['smtp'],
      },
      'not-an-object',
    ],
    claudeDesktop: {
      enabled: 'yes',
      mode: 'shell',
      baseUrl: 'https://user:pass@example.test',
      token: 'bad\nsecret',
      models: [{ routeId: 42, profileId: 'missing', supports1m: 'yes' }],
    },
    appSettings: { verifyUpstreamTls: 'yes' },
    protocolOptions: {
      thinkingPolicy: 'execute',
      contextWindowPolicy: 'unbounded',
      maxContextTokens: Number.POSITIVE_INFINITY,
      clientContextTokens: Number.POSITIVE_INFINITY,
      outputReserveTokens: Number.POSITIVE_INFINITY,
      toolReserveTokens: Number.POSITIVE_INFINITY,
      reasoningReserveTokens: Number.POSITIVE_INFINITY,
      safetyMarginTokens: Number.POSITIVE_INFINITY,
      contextKeepRecentTurns: 0,
      maxHistoricalToolChars: 99,
      maxHistoricalMessageChars: 99,
      contextCompactionMinSavingsTokens: 0,
      contextCompactionTargetRatio: 1.1,
      contextCacheCandidateMinTokens: Number.POSITIVE_INFINITY,
      providerCacheHintsPolicy: 'write-everything',
      workbuddyOperationalInputTokens: 4095,
      workbuddyPreflightBodyBytes: 65535,
      workbuddyTargetBodyBytes: 16 * 1024 * 1024 + 1,
      workbuddyMinCleanupBytes: 0,
      workbuddyMaxSelectedTools: 0,
      maxSseBufferChars: 8 * 1024 * 1024,
    },
  });
  assert.strictEqual(invalidBoundaries.valid, false);
  for (const fragment of [
    'entryServers must be an array',
    'retryUnsafeRequests must be a boolean',
    'modelRoutes[0].from is required',
    'modelRoutes[0].group is invalid',
    'profileId does not match any profile',
    'clientProtocols contains unsupported protocol',
    'claudeDesktop.enabled must be a boolean',
    'claudeDesktop.mode is unsupported',
    'must not include credentials',
    'token must not contain line breaks',
    'appSettings.verifyUpstreamTls must be a boolean',
    'protocolOptions.thinkingPolicy is unsupported',
    'protocolOptions.contextWindowPolicy is unsupported',
    'protocolOptions.providerCacheHintsPolicy is unsupported',
    'protocolOptions.maxContextTokens',
    'protocolOptions.clientContextTokens',
    'protocolOptions.outputReserveTokens',
    'protocolOptions.toolReserveTokens',
    'protocolOptions.reasoningReserveTokens',
    'protocolOptions.safetyMarginTokens',
    'protocolOptions.contextKeepRecentTurns',
    'protocolOptions.maxHistoricalToolChars',
    'protocolOptions.maxHistoricalMessageChars',
    'protocolOptions.contextCompactionMinSavingsTokens',
    'protocolOptions.contextCompactionTargetRatio',
    'protocolOptions.contextCacheCandidateMinTokens',
    'protocolOptions.workbuddyOperationalInputTokens',
    'protocolOptions.workbuddyPreflightBodyBytes',
    'protocolOptions.workbuddyTargetBodyBytes',
    'protocolOptions.workbuddyTargetBodyBytes must not exceed workbuddyPreflightBodyBytes',
    'protocolOptions.workbuddyMinCleanupBytes',
    'protocolOptions.workbuddyMaxSelectedTools',
    'protocolOptions.maxSseBufferChars',
  ]) {
    assert.ok(
      invalidBoundaries.errors.some((error) => error.includes(fragment)),
      `missing validation error containing: ${fragment}`
    );
  }
}

{
  const insecureUpstream = validateConfig({
    activeProfile: 'main',
    profiles: [
      {
        id: 'main',
        protocol: 'openai',
        targetUrl: 'http://api.example.test/v1',
        apiKey: 'encrypted-or-plain',
      },
    ],
    localServer: { host: 'localhost', listenPort: 3443, basePath: '/v1' },
  });
  assert.strictEqual(insecureUpstream.valid, false);
  assert.ok(insecureUpstream.errors.some((error) => error.includes('allowInsecureHttpUpstream')));
  const legacyInsecureUpstream = validateConfig(
    {
      activeProfile: 'main',
      profiles: [
        {
          id: 'main',
          protocol: 'openai',
          targetUrl: 'http://api.example.test/v1',
          apiKey: 'encrypted-or-plain',
        },
      ],
      localServer: { host: 'localhost', listenPort: 3443, basePath: '/v1' },
    },
    { allowLegacyInsecureHttpUpstream: true }
  );
  assert.strictEqual(legacyInsecureUpstream.valid, true);
  assert.ok(
    legacyInsecureUpstream.warnings.some((warning) => warning.includes('exposed in transit'))
  );

  const explicitlyAllowedInsecureUpstream = validateConfig({
    activeProfile: 'main',
    profiles: [
      {
        id: 'main',
        protocol: 'openai',
        targetUrl: 'http://api.example.test/v1',
        apiKey: 'encrypted-or-plain',
        allowInsecureHttpUpstream: true,
      },
    ],
    localServer: { host: 'localhost', listenPort: 3443, basePath: '/v1' },
  });
  assert.strictEqual(explicitlyAllowedInsecureUpstream.valid, true);
  assert.ok(
    explicitlyAllowedInsecureUpstream.warnings.some((warning) =>
      warning.includes('credentials may be exposed')
    )
  );

  const loopbackHttpUpstream = validateConfig({
    activeProfile: 'main',
    profiles: [
      { id: 'main', protocol: 'openai', targetUrl: 'http://127.0.0.1:8080/v1', apiKey: 'x' },
    ],
    localServer: { host: 'localhost', listenPort: 3443, basePath: '/v1' },
  });
  assert.strictEqual(loopbackHttpUpstream.valid, true);
  assert.deepStrictEqual(loopbackHttpUpstream.warnings, []);

  const invalidManagementPort = validateConfig({
    activeProfile: 'main',
    profiles: [{ id: 'main', protocol: 'openai', targetUrl: 'https://api.example.test/v1' }],
    localServer: { host: 'localhost', listenPort: 65500, managementPort: 70000, basePath: '/v1' },
  });
  assert.strictEqual(invalidManagementPort.valid, false);
  assert.ok(
    invalidManagementPort.errors.some((error) => error.includes('localServer.managementPort'))
  );

  const exposedWithoutAuth = validateConfig({
    activeProfile: 'main',
    profiles: [{ id: 'main', protocol: 'openai', targetUrl: 'https://api.example.test/v1' }],
    localServer: { host: '0.0.0.0', listenPort: 3443, basePath: '/v1' },
    entryAuth: { enabled: false, keys: [] },
  });
  assert.strictEqual(exposedWithoutAuth.valid, false);
  assert.ok(exposedWithoutAuth.errors.some((error) => error.includes('entryAuth.enabled')));
}

{
  const valid = validateEntryAuthConfig({
    enabled: true,
    allowedOrigins: ['https://trusted.example'],
    keys: [{ id: 'team-a', key: 'entry-key', allowedEntryProtocols: ['openai-chat'] }],
  });
  assert.strictEqual(valid.valid, true);

  const invalid = validateEntryAuthConfig({
    enabled: 'yes',
    allowedOrigins: [
      'https://trusted.example/path',
      'javascript:alert(1)',
      'https://duplicate.example',
      'https://duplicate.example',
    ],
    keys: [
      { id: 'dup', key: 'bad\nkey', allowedEntryProtocols: ['bad'], allowedEntryPorts: [70000] },
      { id: 'dup', allowedProfileIds: 'main' },
    ],
  });
  assert.strictEqual(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => error.includes('allowedOrigins')));
  assert.ok(invalid.errors.some((error) => error.includes('enabled')));
  assert.ok(invalid.errors.some((error) => error.includes('duplicated')));
  assert.ok(invalid.errors.some((error) => error.includes('key is invalid')));
  assert.ok(invalid.errors.some((error) => error.includes('unsupported protocol')));
  assert.ok(invalid.errors.some((error) => error.includes('invalid port')));
  assert.ok(invalid.errors.some((error) => error.includes('allowedProfileIds')));
}

{
  const valid = validateMcpHubConfig({
    servers: [{ id: 'filesystem', url: 'http://127.0.0.1:3001', timeoutMs: 750 }],
    routing: [{ toolName: 'read_file', serverId: 'filesystem' }],
  });
  assert.strictEqual(valid.valid, true);

  const invalid = validateMcpHubConfig({
    servers: [
      { id: 'dup', url: 'http://user:pass@127.0.0.1:3001', prefix: 'bad-prefix!' },
      { id: 'dup', url: 'file:///tmp/socket' },
    ],
    routing: [
      { toolName: 'bad tool', serverId: 'missing' },
      { pattern: '(', serverId: 'dup' },
      { pattern: '(a+)+$', serverId: 'dup' },
      { serverId: 'dup' },
    ],
  });
  assert.strictEqual(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => error.includes('duplicated')));
  assert.ok(invalid.errors.some((error) => error.includes('credentials')));
  assert.ok(invalid.errors.some((error) => error.includes('prefix')));
  assert.ok(invalid.errors.some((error) => error.includes('must be http(s)')));
  assert.ok(invalid.errors.some((error) => error.includes('does not match any server')));
  assert.ok(invalid.errors.some((error) => error.includes('pattern is invalid')));
  assert.ok(invalid.errors.some((error) => error.includes('unsafe backtracking')));
  assert.ok(invalid.errors.some((error) => error.includes('toolName or pattern is required')));
}

{
  const invalidTimeout = validateConfig({
    activeProfile: 'main',
    profiles: [
      {
        id: 'main',
        protocol: 'openai',
        targetUrl: 'https://api.example.test/v1',
        timeoutMs: 500, // min is 1000
      },
    ],
    localServer: { host: 'localhost', listenPort: 3443, basePath: '/v1' },
  });
  assert.strictEqual(invalidTimeout.valid, false);
  assert.ok(
    invalidTimeout.errors.some((err) => err.includes('timeoutMs must be between 1000 and 1800000'))
  );

  const validTimeout = validateConfig({
    activeProfile: 'main',
    profiles: [
      {
        id: 'main',
        protocol: 'openai',
        targetUrl: 'https://api.example.test/v1',
        timeoutMs: 300000,
      },
    ],
    localServer: { host: 'localhost', listenPort: 3443, basePath: '/v1' },
  });
  assert.strictEqual(validTimeout.valid, true);
}

/**
 * 回归：DNS 配置写错时必须报错。
 *
 * 这些项如果被静默忽略，代理会退回系统解析，正是本次 chatgpt.com 被投毒导致
 * 502 的成因，所以非法 IP、错误类型、超长列表都要显式失败。
 */
function testUpstreamDnsServersValidation() {
  const baseConfig = (upstreamDnsServers) => ({
    activeProfile: 'main',
    profiles: [
      {
        id: 'main',
        protocol: 'openai',
        targetUrl: 'https://api.example.test/v1',
      },
    ],
    localServer: { host: 'localhost', listenPort: 3443, basePath: '/v1' },
    appSettings: { upstreamDnsServers },
  });

  // 正常：数组、逗号分隔字符串、IPv6 都合法。
  assert.strictEqual(validateConfig(baseConfig(['1.1.1.1', '8.8.8.8', '223.5.5.5'])).valid, true);
  assert.strictEqual(validateConfig(baseConfig('1.1.1.1,8.8.8.8')).valid, true);
  assert.strictEqual(validateConfig(baseConfig(['2606:4700:4700::1111'])).valid, true);
  // 空值表示退回系统解析，属于合法配置。
  assert.strictEqual(validateConfig(baseConfig([])).valid, true);
  assert.strictEqual(validateConfig(baseConfig('')).valid, true);
  assert.strictEqual(validateConfig(baseConfig(null)).valid, true);
  assert.strictEqual(validateConfig(baseConfig(undefined)).valid, true);

  // 非法：错误类型、非法 IP、超长列表。
  const wrongType = validateConfig(baseConfig({ servers: ['1.1.1.1'] }));
  assert.strictEqual(wrongType.valid, false);
  assert.ok(
    wrongType.errors.some((err) =>
      err.includes('appSettings.upstreamDnsServers must be an array of IP addresses')
    )
  );

  const invalidIp = validateConfig(baseConfig(['1.1.1.1', 'not-an-ip']));
  assert.strictEqual(invalidIp.valid, false);
  assert.ok(
    invalidIp.errors.some((err) =>
      err.includes('appSettings.upstreamDnsServers contains an invalid IP address: not-an-ip')
    )
  );

  const tooMany = validateConfig(
    baseConfig(Array.from({ length: 9 }, (_value, index) => `10.0.0.${index + 1}`))
  );
  assert.strictEqual(tooMany.valid, false);
  assert.ok(
    tooMany.errors.some((err) =>
      err.includes('appSettings.upstreamDnsServers must contain at most 8 servers')
    )
  );

  // 超长列表即使内容合法也要拒绝，避免为一个错误配置反复失败。
  const boundary = validateConfig(
    baseConfig(Array.from({ length: 8 }, (_value, index) => `10.0.0.${index + 1}`))
  );
  assert.strictEqual(boundary.valid, true);
}

testUpstreamDnsServersValidation();

// A release health fixture must not confuse provider families with entry wire
// protocols; invalid fixtures cannot establish a packaged-runtime defect.
{
  const config = {
    activeProfile: 'isolated-health',
    profiles: [
      {
        id: 'isolated-health',
        protocol: 'openai',
        api: 'responses',
        targetUrl: 'http://127.0.0.1:9',
        apiKey: '',
      },
    ],
    localServer: {
      host: '127.0.0.1',
      listenPort: 14101,
      managementPort: 13503,
      protocol: 'openai-responses',
    },
    entryServers: [
      { host: '127.0.0.1', listenPort: 14101, protocol: 'openai-responses', tls: false },
    ],
    modelRoutes: [],
    entryAuth: { enabled: false, keys: [] },
    appSettings: { upstreamWarmupEnabled: false },
  };
  assert.strictEqual(validateConfig(config).valid, true);
  for (const protocol of ['openai-responses', 'openai-chat']) {
    const invalid = validateConfig({
      ...config,
      profiles: [{ ...config.profiles[0], protocol }],
    });
    assert.strictEqual(invalid.valid, false);
    assert.deepStrictEqual(invalid.errors, ['Profile [isolated-health] has unsupported protocol']);
  }
  assert.strictEqual(validateConfig(config).valid, true);
}

console.log('[validator.test] ok');
