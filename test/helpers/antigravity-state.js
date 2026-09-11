'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { STATE_KEY } = require('../../lib/proxy/antigravity-credentials');

function encodeTestOAuthState(token = 'ya29.test-ide-token') {
  const inner = Buffer.from(`\0${token}\0${'x'.repeat(100)}\0`).toString('base64url');
  return Buffer.from(`\0${inner}\0`).toString('base64');
}

function createTestStateDatabase(dbPath, value = encodeTestOAuthState()) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
    if (value !== undefined)
      db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run(STATE_KEY, value);
  } finally {
    db.close();
  }
  return dbPath;
}

module.exports = { createTestStateDatabase, encodeTestOAuthState };
