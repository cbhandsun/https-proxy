'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  AntigravityCredentialError,
  antigravityCredentialFailure,
  createAntigravityCredentialReader,
  decodeAntigravityCredentialManagerValue,
  MAX_STATE_VALUE_BYTES,
  STATE_KEY,
} = require('../lib/proxy/antigravity-credentials');
const { decodeAntigravityOAuthStateValue } = require('../lib/proxy/google-official');
const { createAuthResolver } = require('../lib/proxy/auth-resolver');
const { createTestStateDatabase, encodeTestOAuthState } = require('./helpers/antigravity-state');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-antigravity-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('hpm-antigravity-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return path.join(dir, 'state.vscdb');
}

function reader(dbPath, overrides = {}) {
  return createAntigravityCredentialReader({
    databasePaths: () => [dbPath],
    decode: decodeAntigravityOAuthStateValue,
    credentialTargets: () => [],
    ...overrides,
  });
}

test('reads live WAL login changes without Python and leaves IDE state untouched', (t) => {
  const dbPath = createTestStateDatabase(fixture(t));
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    const read = reader(dbPath);
    assert.equal(read().content.access_token, 'ya29.test-ide-token');
    db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(
      encodeTestOAuthState('ya29.new-login'),
      STATE_KEY
    );
    const before = fs.readFileSync(dbPath);
    const walBefore = fs.readFileSync(dbPath + '-wal');
    const result = read();
    assert.equal(result.content.access_token, 'ya29.new-login');
    assert.equal(result.source, 'antigravity-state');
    assert.equal(result.content.__readOnly, true);
    assert.equal(result.credsPath, null);
    assert.deepEqual(fs.readFileSync(dbPath), before);
    assert.deepEqual(fs.readFileSync(dbPath + '-wal'), walBefore);
  } finally {
    db.close();
  }
});

test('missing state fails explicitly; an unused variant allows the next IDE database', (t) => {
  const dbPath = fixture(t);
  assert.throws(reader(dbPath), { code: 'ANTIGRAVITY_CREDENTIALS_MISSING' });
  createTestStateDatabase(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec('DELETE FROM ItemTable');
  db.close();
  assert.throws(reader(dbPath), { code: 'ANTIGRAVITY_CREDENTIALS_MISSING' });
  const second = createTestStateDatabase(dbPath + '.second');
  assert.equal(reader(dbPath, { databasePaths: () => [dbPath, second] })().dbPath, second);
});

test('prefers Antigravity Windows credential manager login over SQLite state', (t) => {
  const dbPath = createTestStateDatabase(fixture(t), encodeTestOAuthState('ya29.sqlite-stale'));
  const expiresAt = Date.now() + 3600 * 1000;
  const read = reader(dbPath, {
    credentialTargets: () => ['gemini:antigravity'],
    readWindowsCredential: (target) => {
      assert.equal(target, 'gemini:antigravity');
      return JSON.stringify({
        token: {
          access_token: 'ya29.credential-fresh',
          refresh_token: '1//credential-refresh',
          token_type: 'Bearer',
          expiry: new Date(expiresAt).toISOString(),
        },
        auth_method: 'consumer',
      });
    },
  });
  const result = read();
  assert.equal(result.source, 'antigravity-credential-manager');
  assert.equal(result.credentialTarget, 'gemini:antigravity');
  assert.equal(result.content.access_token, 'ya29.credential-fresh');
  assert.equal(result.content.refresh_token, '1//credential-refresh');
  assert.equal(result.content.__source, 'antigravity-credential-manager');
  assert.equal(result.content.__readOnly, true);
  assert.ok(result.content.expiry_date >= expiresAt - 1000);
});

test('falls back to SQLite when Windows credential manager has no usable token', (t) => {
  const dbPath = createTestStateDatabase(fixture(t), encodeTestOAuthState('ya29.sqlite-login'));
  const read = reader(dbPath, {
    credentialTargets: () => ['gemini:antigravity'],
    readWindowsCredential: () => JSON.stringify({ token: {}, auth_method: 'consumer' }),
  });
  const result = read();
  assert.equal(result.source, 'antigravity-state');
  assert.equal(result.content.access_token, 'ya29.sqlite-login');
});

test('decodes Antigravity credential manager OAuth shapes safely', () => {
  const iso = '2999-01-01T00:00:00.000Z';
  assert.deepEqual(
    decodeAntigravityCredentialManagerValue(
      JSON.stringify({
        token: {
          access_token: 'ya29.manager-access',
          refresh_token: '1//manager-refresh',
          expiry: iso,
        },
        auth_method: 'consumer',
      })
    ),
    {
      access_token: 'ya29.manager-access',
      refresh_token: '1//manager-refresh',
      token_type: 'Bearer',
      client_id: '',
      expiry_date: Date.parse(iso),
      __readOnly: true,
      __source: 'antigravity-credential-manager',
    }
  );
  assert.equal(decodeAntigravityCredentialManagerValue('not-json'), null);
  assert.equal(
    decodeAntigravityCredentialManagerValue(JSON.stringify({ token: { access_token: 'bad' } })),
    null
  );
  assert.equal(
    decodeAntigravityCredentialManagerValue(
      JSON.stringify({ token: { access_token: 'ya29.' + 'x'.repeat(20000) } })
    ),
    null
  );
});

for (const [name, value] of [
  ['empty', ''],
  ['malformed', 'invalid-state'],
  ['null', null],
  ['blob', Buffer.from(encodeTestOAuthState())],
  ['oversized', 'x'.repeat(MAX_STATE_VALUE_BYTES + 1)],
]) {
  test(`rejects ${name} state without falling back`, (t) => {
    const dbPath = createTestStateDatabase(fixture(t), value);
    assert.throws(reader(dbPath), { code: 'ANTIGRAVITY_CREDENTIALS_INVALID' });
  });
}

test('rejects corrupt databases, views, non-files and untrusted paths safely', (t) => {
  const dbPath = fixture(t);
  fs.writeFileSync(dbPath, 'sensitive-database-content');
  assert.throws(reader(dbPath), { code: 'ANTIGRAVITY_CREDENTIALS_UNREADABLE' });
  const viewPath = dbPath + '.view';
  const db = new DatabaseSync(viewPath);
  db.exec('CREATE VIEW ItemTable AS SELECT 1 AS key, 2 AS value');
  db.close();
  for (const candidate of [viewPath, path.dirname(dbPath), 'relative.db', dbPath + '\0']) {
    assert.throws(reader(candidate), { code: 'ANTIGRAVITY_CREDENTIALS_UNREADABLE' });
  }
  const hidden = 'secret-token-and-path';
  assert.throws(
    reader(dbPath, {
      fsModule: {
        lstatSync() {
          throw Error(hidden);
        },
      },
    }),
    (error) => !error.message.includes(hidden)
  );
  assert.throws(
    reader(dbPath, {
      fsModule: { lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => true }) },
    }),
    { code: 'ANTIGRAVITY_CREDENTIALS_UNREADABLE' }
  );
});

test('unsupported runtime and decoder exceptions return fixed safe errors', (t) => {
  const dbPath = createTestStateDatabase(fixture(t));
  for (const loadSqlite of [
    () => {
      throw Error('private');
    },
    () => ({}),
  ]) {
    assert.throws(reader(dbPath, { loadSqlite }), { code: 'ANTIGRAVITY_SQLITE_UNAVAILABLE' });
  }
  assert.throws(
    reader(dbPath, {
      decode() {
        throw Error('private');
      },
    }),
    { code: 'ANTIGRAVITY_CREDENTIALS_INVALID' }
  );
  const error = new AntigravityCredentialError('ANTIGRAVITY_CREDENTIALS_MISSING');
  error.message = 'private';
  assert.ok(!JSON.stringify(antigravityCredentialFailure(error)).includes('private'));
  for (const value of [null, {}, { code: 'toString' }, { code: {} }, Error('private')])
    assert.equal(antigravityCredentialFailure(value), null);
  assert.equal(
    new AntigravityCredentialError('toString').code,
    'ANTIGRAVITY_CREDENTIALS_UNREADABLE'
  );
});

function resolver(overrides = {}) {
  return createAuthResolver({
    officialLoginProvider: () => 'google',
    inferOfficialProfileAuthMode: () => 'official-login',
    isRedactedSecret: (value) => !value,
    PROFILES: [],
    readGoogleOfficialCredentialFile: () => ({
      credsPath: null,
      content: {
        __readOnly: true,
        __source: 'antigravity-state',
        access_token: 'ya29.stale',
        refresh_token: 'synthetic',
        expiry_date: 1,
      },
    }),
    getFreshAntigravityOfficialAccessToken: async () => 'ya29.fresh',
    resolveGoogleOfficialLoginPrepared: (prepared, profile, token, resolve) =>
      resolve({ ...prepared, profile: { ...profile, apiKey: token } }),
    ...overrides,
  });
}

test('refresh succeeds or fails closed without stale/configured token fallback', async () => {
  const prepared = () => ({
    profile: { id: 'google-official', protocol: 'gemini', apiKey: 'ya29.configured' },
  });
  assert.equal(
    (await resolver().resolveOfficialCredentials(prepared(), {})).profile.apiKey,
    'ya29.fresh'
  );
  const failing = resolver({
    getFreshAntigravityOfficialAccessToken: async () => {
      throw Error('private-refresh-token');
    },
  });
  await assert.rejects(
    failing.resolveOfficialCredentials(prepared(), {}),
    (error) =>
      error.code === 'ANTIGRAVITY_TOKEN_REFRESH_FAILED' && !error.message.includes('private')
  );
  await assert.rejects(
    resolver({
      readGoogleOfficialCredentialFile() {
        throw new AntigravityCredentialError('ANTIGRAVITY_CREDENTIALS_MISSING');
      },
    }).resolveOfficialCredentials(prepared(), {}),
    { code: 'ANTIGRAVITY_CREDENTIALS_MISSING' }
  );
});

test('expired credential-manager token fails closed without stale fallback', async () => {
  const prepared = () => ({
    profile: { id: 'google-official', protocol: 'gemini', apiKey: 'ya29.configured' },
  });
  await assert.rejects(
    resolver({
      readGoogleOfficialCredentialFile: () => ({
        credsPath: null,
        content: {
          __readOnly: true,
          __source: 'antigravity-credential-manager',
          access_token: 'ya29.expired',
          refresh_token: '1//expired-refresh',
          expiry_date: 1,
        },
      }),
      getFreshAntigravityOfficialAccessToken: async () => {
        throw Error('private-refresh-token');
      },
    }).resolveOfficialCredentials(prepared(), {}),
    (error) =>
      error.code === 'ANTIGRAVITY_TOKEN_REFRESH_FAILED' && !error.message.includes('private')
  );
});

test('explicit API-key mode does not read IDE credentials', async () => {
  const profile = { id: 'google-official', apiKey: 'synthetic-api-key' };
  const auth = resolver({
    PROFILES: [profile],
    inferOfficialProfileAuthMode: () => 'api-key',
    readGoogleOfficialCredentialFile() {
      assert.fail('API key mode must not read IDE state');
    },
  });
  const result = await auth.resolveOfficialCredentials({ profile }, {});
  assert.equal(result.authMode, 'api-key');
  assert.equal(result.profile.apiKey, 'synthetic-api-key');
});
