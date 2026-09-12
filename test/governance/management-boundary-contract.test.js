'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROUTES } = require('../../lib/proxy/management-router');

const repoRoot = path.resolve(__dirname, '..', '..');
const rustBridge = fs.readFileSync(
  path.join(repoRoot, 'src-tauri', 'src', 'management_bridge.rs'),
  'utf8'
);
const tauriEntry = fs.readFileSync(path.join(repoRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
const frontendBridge = fs.readFileSync(
  path.join(repoRoot, 'tauri-ui', 'src', 'app', 'domains', 'bridge.js'),
  'utf8'
);

function sorted(values) {
  return [...new Set(values)].sort();
}

function extractQuotedPaths(source) {
  return [...source.matchAll(/"(\/[^"?]+)"/g)].map((match) => match[1]);
}

const allowlistStart = rustBridge.indexOf('fn is_allowed_management_route');
const allowlistEnd = rustBridge.indexOf('\nfn validate_path', allowlistStart);
assert.ok(allowlistStart >= 0 && allowlistEnd > allowlistStart, 'Rust allowlist must be parseable');
const allowlist = rustBridge.slice(allowlistStart, allowlistEnd);
const getStart = allowlist.indexOf('"GET" =>');
const postStart = allowlist.indexOf('"POST" =>');
const fallbackStart = allowlist.indexOf('_ => false');
assert.ok(getStart >= 0 && postStart > getStart && fallbackStart > postStart);

const rustRoutes = sorted([
  ...extractQuotedPaths(allowlist.slice(getStart, postStart)).map((route) => `GET ${route}`),
  ...extractQuotedPaths(allowlist.slice(postStart, fallbackStart)).map((route) => `POST ${route}`),
]);
const nodeRoutes = sorted(
  ROUTES.flatMap((route) =>
    route.paths
      .filter((routePath) => routePath.startsWith('/v1/local/'))
      .map((routePath) => `${route.method} ${routePath.slice('/v1/local'.length)}`)
  )
);
assert.deepEqual(rustRoutes, nodeRoutes, 'Rust management allowlist must match Node routes');

const handlerStart = tauriEntry.indexOf('tauri::generate_handler![');
const handlerEnd = tauriEntry.indexOf('])', handlerStart);
assert.ok(
  handlerStart >= 0 && handlerEnd > handlerStart,
  'Tauri command registration must be parseable'
);
const registeredCommands = new Set(
  tauriEntry
    .slice(handlerStart, handlerEnd)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/,$/, ''))
    .filter((line) => /^[a-z_][a-z0-9_]*$/.test(line))
);
const invokedCommands = sorted(
  [...frontendBridge.matchAll(/\binvoke\(['"]([a-zA-Z0-9_]+)['"]/g)].map((match) => match[1])
);
assert.deepEqual(
  invokedCommands.filter((command) => !registeredCommands.has(command)),
  [],
  'every literal frontend invoke command must be registered by Tauri'
);

console.log('[management-boundary-contract.test] ok');
