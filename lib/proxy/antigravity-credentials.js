'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readWindowsGenericCredentialUtf8 } = require('./windows-credential-manager');

const MAX_STATE_VALUE_BYTES = 1024 * 1024;
const MAX_CREDENTIAL_VALUE_BYTES = 16 * 1024;
const STATE_KEY = 'antigravityUnifiedStateSync.oauthToken';
const CREDENTIAL_TARGETS = ['gemini:antigravity'];
const ERROR_MESSAGES = Object.freeze({
  ANTIGRAVITY_SQLITE_UNAVAILABLE:
    'Antigravity login requires a proxy runtime with node:sqlite. Update the proxy runtime.',
  ANTIGRAVITY_CREDENTIALS_MISSING:
    'No Antigravity IDE login was found. Sign in to Antigravity IDE; Gemini CLI credentials are not used for this route.',
  ANTIGRAVITY_CREDENTIALS_INVALID:
    'Antigravity IDE login data is empty or invalid. Sign in to Antigravity IDE again.',
  ANTIGRAVITY_CREDENTIALS_UNREADABLE:
    'Antigravity IDE login database could not be read. Check access to the IDE user data directory.',
  ANTIGRAVITY_TOKEN_REFRESH_FAILED:
    'Antigravity IDE login could not be refreshed. Sign in to Antigravity IDE again.',
});

class AntigravityCredentialError extends Error {
  constructor(code) {
    const safeCode =
      typeof code === 'string' && Object.hasOwn(ERROR_MESSAGES, code)
        ? code
        : 'ANTIGRAVITY_CREDENTIALS_UNREADABLE';
    super(ERROR_MESSAGES[safeCode]);
    this.name = 'AntigravityCredentialError';
    this.code = safeCode;
  }
}

function antigravityCredentialFailure(error) {
  if (!error || typeof error.code !== 'string' || !Object.hasOwn(ERROR_MESSAGES, error.code))
    return null;
  return { type: 'authentication_error', code: error.code, message: ERROR_MESSAGES[error.code] };
}

function normalizeExpiryDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1000000000000 ? value : value * 1000;
  }
  if (typeof value !== 'string' || !value.trim()) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return normalizeExpiryDate(numeric);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function decodeAntigravityCredentialManagerValue(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_CREDENTIAL_VALUE_BYTES) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const token = parsed && typeof parsed === 'object' ? parsed.token : null;
  const source = token && typeof token === 'object' ? token : parsed;
  if (!source || typeof source !== 'object') return null;
  const accessToken = source.access_token || source.accessToken || '';
  const refreshToken = source.refresh_token || source.refreshToken || '';
  if (
    (accessToken && (typeof accessToken !== 'string' || !accessToken.startsWith('ya29.'))) ||
    (refreshToken && (typeof refreshToken !== 'string' || !refreshToken.startsWith('1//')))
  ) {
    return null;
  }
  if (!accessToken && !refreshToken) return null;
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: source.token_type || source.tokenType || 'Bearer',
    client_id: source.client_id || source.clientId || '',
    expiry_date: normalizeExpiryDate(
      source.expiry_date ||
        source.expiryDate ||
        source.expiry ||
        source.expires_at ||
        source.expiresAt ||
        0
    ),
    __readOnly: true,
    __source: 'antigravity-credential-manager',
  };
}

function createAntigravityCredentialReader({
  databasePaths,
  decode,
  credentialTargets = () => CREDENTIAL_TARGETS,
  decodeCredential = decodeAntigravityCredentialManagerValue,
  readWindowsCredential = readWindowsGenericCredentialUtf8,
  loadSqlite = () => require('node:sqlite'),
  fsModule = fs,
}) {
  function readCredentialManagerValue(target) {
    if (typeof readWindowsCredential !== 'function') return null;
    if (typeof target !== 'string' || !target || target.includes('\0')) return null;
    const value = readWindowsCredential(target);
    if (typeof value !== 'string' || !value) return null;
    const content = decodeCredential(value);
    if (!content || !(content.access_token || content.refresh_token)) return null;
    return {
      credsPath: null,
      content,
      source: 'antigravity-credential-manager',
      credentialTarget: target,
    };
  }

  function readValue(dbPath) {
    let DatabaseSync;
    try {
      ({ DatabaseSync } = loadSqlite());
      if (typeof DatabaseSync !== 'function') throw new Error();
    } catch {
      throw new AntigravityCredentialError('ANTIGRAVITY_SQLITE_UNAVAILABLE');
    }
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 250, allowExtension: false });
      try {
        db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;');
        const table = db.prepare('SELECT type FROM sqlite_schema WHERE name = ?').get('ItemTable');
        if (table?.type !== 'table') throw new Error();
        // Bound the value inside SQLite before copying it into JavaScript.
        const row = db
          .prepare(
            'SELECT CASE WHEN typeof(value) = ? AND length(CAST(value AS BLOB)) BETWEEN 1 AND ? THEN value END AS value FROM ItemTable WHERE key = ? LIMIT 1'
          )
          .get('text', MAX_STATE_VALUE_BYTES, STATE_KEY);
        return row ? row.value : undefined;
      } finally {
        db.close();
      }
    } catch {
      // SQLite errors may contain paths, SQL or user data. Never forward their text.
      throw new AntigravityCredentialError('ANTIGRAVITY_CREDENTIALS_UNREADABLE');
    }
  }

  return function readAntigravityCredentials() {
    for (const target of credentialTargets()) {
      const credentialResult = readCredentialManagerValue(target);
      if (credentialResult) return credentialResult;
    }
    for (const dbPath of databasePaths()) {
      if (typeof dbPath !== 'string' || !path.isAbsolute(dbPath) || dbPath.includes('\0'))
        throw new AntigravityCredentialError('ANTIGRAVITY_CREDENTIALS_UNREADABLE');
      try {
        const stat = fsModule.lstatSync(dbPath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw new AntigravityCredentialError('ANTIGRAVITY_CREDENTIALS_UNREADABLE');
      }
      const value = readValue(dbPath);
      if (value === undefined) continue; // An installed but never signed-in IDE variant.
      let content;
      try {
        content = typeof value === 'string' ? decode(value) : null;
      } catch {
        throw new AntigravityCredentialError('ANTIGRAVITY_CREDENTIALS_INVALID');
      }
      if (!content || !(content.access_token || content.refresh_token))
        throw new AntigravityCredentialError('ANTIGRAVITY_CREDENTIALS_INVALID');
      return { credsPath: null, content, source: 'antigravity-state', dbPath };
    }
    throw new AntigravityCredentialError('ANTIGRAVITY_CREDENTIALS_MISSING');
  };
}

module.exports = {
  AntigravityCredentialError,
  antigravityCredentialFailure,
  createAntigravityCredentialReader,
  decodeAntigravityCredentialManagerValue,
  MAX_CREDENTIAL_VALUE_BYTES,
  MAX_STATE_VALUE_BYTES,
  STATE_KEY,
};
