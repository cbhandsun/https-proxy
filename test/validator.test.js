const assert = require('assert');

const {
  validateConfig,
  validateEntryAuthConfig,
  validateMcpHubConfig,
} = require('../lib/proxy/validator');

{
  const valid = validateConfig({
    activeProfile: 'main',
    profiles: [{ id: 'main', protocol: 'openai', targetUrl: 'https://api.example.test/v1' }],
    localServer: { host: 'localhost', listenPort: 3443, basePath: '/v1' },
    entryServers: [{ host: '127.0.0.1', listenPort: 3445, basePath: '/v1' }],
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
    keys: [{ id: 'team-a', key: 'entry-key', allowedEntryProtocols: ['openai-chat'] }],
  });
  assert.strictEqual(valid.valid, true);

  const invalid = validateEntryAuthConfig({
    enabled: 'yes',
    keys: [
      { id: 'dup', key: 'bad\nkey', allowedEntryProtocols: ['bad'], allowedEntryPorts: [70000] },
      { id: 'dup', allowedProfileIds: 'main' },
    ],
  });
  assert.strictEqual(invalid.valid, false);
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
  assert.ok(invalid.errors.some((error) => error.includes('toolName or pattern is required')));
}

console.log('[validator.test] ok');
