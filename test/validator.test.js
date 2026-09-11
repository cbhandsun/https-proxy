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
      maxContextTokens: 0,
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
    'protocolOptions.maxContextTokens',
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
  assert.strictEqual(insecureUpstream.valid, true);
  assert.ok(insecureUpstream.warnings.some((warning) => warning.includes('non-loopback HTTP')));

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

console.log('[validator.test] ok');
