const assert = require('assert');

const {
  authorizeEntryRequest,
  extractEntryCredential,
  installEntryCorsGuard,
  normalizeEntryAuthConfig,
  normalizeEntryOrigins,
  profileMatchesEntryKey,
  stripEntryAuthHeaders,
} = require('../lib/proxy/entry-auth');
const {
  decryptConfigSecretsInPlace,
  decryptKey,
  encryptConfigSecretsForStorage,
} = require('../lib/proxy/config');

const entry = { protocol: 'openai-chat', listenPort: 3447 };

{
  assert.strictEqual(extractEntryCredential({ authorization: 'Bearer proxy-key' }), 'proxy-key');
  assert.strictEqual(extractEntryCredential({ authorization: 'Basic abc' }), '');
  assert.strictEqual(extractEntryCredential({ 'x-api-key': 'proxy-x-key' }), 'proxy-x-key');
  assert.strictEqual(extractEntryCredential({ 'api-key': 'proxy-api-key' }), 'proxy-api-key');
  assert.strictEqual(
    extractEntryCredential({ 'proxy-authorization': 'Bearer proxy-header-key' }),
    'proxy-header-key'
  );
}

{
  assert.deepStrictEqual(
    normalizeEntryOrigins(
      {
        entryAuth: {
          allowedOrigins: [
            'https://trusted.example',
            'https://trusted.example/path',
            'javascript:alert(1)',
          ],
        },
      },
      { PROXY_ENTRY_ALLOWED_ORIGINS: 'http://localhost:5173, invalid' }
    ),
    ['https://trusted.example', 'http://localhost:5173']
  );

  function createResponse() {
    return {
      headers: {},
      statusCode: null,
      body: '',
      setHeader(name, value) {
        this.headers[name] = value;
      },
      writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        Object.assign(this.headers, headers);
      },
      end(body = '') {
        this.body = String(body);
      },
    };
  }

  const noOriginResponse = createResponse();
  assert.strictEqual(
    installEntryCorsGuard({ headers: {} }, noOriginResponse, { entryAuth: {} }, {}),
    true
  );

  const deniedResponse = createResponse();
  assert.strictEqual(
    installEntryCorsGuard(
      { headers: { origin: 'https://evil.example' } },
      deniedResponse,
      { entryAuth: { allowedOrigins: ['https://trusted.example'] } },
      {}
    ),
    false
  );
  assert.strictEqual(deniedResponse.statusCode, 403);

  const allowedResponse = createResponse();
  assert.strictEqual(
    installEntryCorsGuard(
      { headers: { origin: 'https://trusted.example' } },
      allowedResponse,
      { entryAuth: { allowedOrigins: ['https://trusted.example'] } },
      {}
    ),
    true
  );
  assert.strictEqual(
    allowedResponse.headers['Access-Control-Allow-Origin'],
    'https://trusted.example'
  );
  allowedResponse.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
  assert.strictEqual(
    allowedResponse.headers['Access-Control-Allow-Origin'],
    'https://trusted.example'
  );
}

{
  const auth = normalizeEntryAuthConfig(
    {
      entryAuth: {
        enabled: true,
        keys: [
          {
            id: 'team-a',
            key: 'entry-secret',
            allowedEntryProtocols: ['OpenAI-Chat'],
            allowedEntryPorts: ['3447', 'not-a-port', 99999],
            allowedProfileIds: ['default'],
          },
          { id: 'empty', key: '' },
          { id: 'disabled', key: 'disabled-key', enabled: false },
        ],
      },
    },
    {}
  );
  assert.strictEqual(auth.enabled, true);
  assert.strictEqual(auth.keys.length, 2);
  assert.deepStrictEqual(auth.keys[0].allowedEntryProtocols, ['openai-chat']);
  assert.deepStrictEqual(auth.keys[0].allowedEntryPorts, [3447]);
}

{
  const auth = normalizeEntryAuthConfig({}, { PROXY_ENTRY_KEYS: 'env-a, env-b ' });
  assert.strictEqual(auth.enabled, true);
  assert.deepStrictEqual(
    auth.keys.map((item) => item.id),
    ['env-1', 'env-2']
  );
}

{
  const config = {
    entryAuth: {
      enabled: true,
      keys: [
        {
          id: 'team-a',
          key: 'entry-secret',
          allowedEntryProtocols: ['openai-chat'],
          allowedEntryPorts: [3447],
          allowedProfileIds: ['profile-a'],
        },
      ],
    },
  };
  const ok = authorizeEntryRequest(
    { headers: { authorization: 'Bearer entry-secret' } },
    entry,
    config,
    {}
  );
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.enabled, true);
  assert.strictEqual(ok.key.id, 'team-a');
  assert.strictEqual(ok.key.key, undefined);
  assert.strictEqual(profileMatchesEntryKey(ok, { id: 'profile-a' }), true);
  assert.strictEqual(profileMatchesEntryKey(ok, { id: 'profile-b' }), false);

  const denied = authorizeEntryRequest(
    { headers: { authorization: 'Bearer wrong' } },
    entry,
    config,
    {}
  );
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.status, 401);

  const wrongEntry = authorizeEntryRequest(
    { headers: { authorization: 'Bearer entry-secret' } },
    { protocol: 'claude', listenPort: 3443 },
    config,
    {}
  );
  assert.strictEqual(wrongEntry.ok, false);
}

{
  const headers = {
    authorization: 'Bearer proxy-key',
    'api-key': 'proxy-key',
    'x-api-key': 'proxy-key',
    'proxy-authorization': 'Bearer proxy-key',
    accept: 'application/json',
  };
  stripEntryAuthHeaders(headers);
  assert.deepStrictEqual(headers, { accept: 'application/json' });
}

{
  const stored = encryptConfigSecretsForStorage({
    entryAuth: { enabled: true, keys: [{ id: 'team-a', key: 'entry-secret' }] },
  });
  assert.notStrictEqual(stored.entryAuth.keys[0].key, 'entry-secret');
  assert.strictEqual(decryptKey(stored.entryAuth.keys[0].key), 'entry-secret');
  assert.strictEqual(decryptConfigSecretsInPlace(stored).entryAuth.keys[0].key, 'entry-secret');
}

console.log('[entry-auth.test] ok');
process.exit(0);
