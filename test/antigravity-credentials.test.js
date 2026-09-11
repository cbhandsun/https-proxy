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
