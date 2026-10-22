'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const fail = () =>
  Object.assign(new Error('Isolated acceptance capability refused'), {
    code: 'generic_acceptance_capability_refused',
  });

// Test-process instrumentation, not a production authentication provider or an
// OS sandbox. Only the isolated auth lookup is aliased; homedir and all writes
// retain their isolated destinations. No credential is persisted or logged.
function installGenericAcceptanceGuards(options, capabilities = { fs, http, https }) {
  const { authFile, isolatedHome, permitFile, receiptFile } = options || {};
  if (
    ![authFile, isolatedHome, permitFile, receiptFile].every(
      (value) => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0')
    )
  )
    throw fail();
  const alias = path.join(isolatedHome, '.codex', 'auth.json');
  if (
    path.resolve(authFile) === path.resolve(alias) ||
    path.basename(authFile) !== 'auth.json' ||
    path.basename(path.dirname(authFile)) !== '.codex'
  )
    throw fail();
  const io = capabilities.fs;
  const read = io.readFileSync.bind(io);
  const exists = io.existsSync.bind(io);
  const append = io.appendFileSync.bind(io);
  const matches = (file) => typeof file === 'string' && path.resolve(file) === path.resolve(alias);
  const record = (value) => append(receiptFile, JSON.stringify(value) + '\n', { encoding: 'utf8' });
  io.existsSync = (file) => exists(matches(file) ? authFile : file);
  io.readFileSync = (file, ...args) => {
    if (matches(file)) {
      record({ kind: 'auth_read' });
      return read(authFile, ...args);
    }
    return read(file, ...args);
  };
  let consumed = 0;
  function admit(protocol, args) {
    let target;
    try {
      const first = args[0];
      const url = typeof first === 'string' || first instanceof URL ? new URL(first) : null;
      const input = url ? (typeof args[1] === 'object' ? args[1] : {}) : first;
      target = {
        protocol: input?.protocol || url?.protocol || protocol,
        hostname: input?.hostname || input?.host || url?.hostname,
        port: String(input?.port || url?.port || ''),
        path: input?.path || (url ? url.pathname + url.search : '/'),
        method: input?.method || 'GET',
      };
    } catch {
      throw fail();
    }
    if (protocol === 'http:' && target.protocol === 'http:' && target.hostname === '127.0.0.1')
      return;
    if (
      protocol !== 'https:' ||
      target.protocol !== 'https:' ||
      !['', '443'].includes(target.port) ||
      target.method !== 'POST' ||
      !(
        (target.hostname === 'api.openai.com' &&
          /^\/v1\/responses(?:\/compact)?$/.test(target.path)) ||
        (target.hostname === 'chatgpt.com' &&
          /^\/backend-api\/codex\/responses(?:\/compact)?$/.test(target.path))
      )
    ) {
      record({ kind: 'blocked_egress' });
      throw fail();
    }
    let permit;
    try {
      permit = Number(read(permitFile, 'utf8'));
    } catch {
      throw fail();
    }
    if (!Number.isSafeInteger(permit) || permit !== consumed + 1 || permit > 12) {
      record({ kind: 'blocked_retry_or_budget' });
      throw fail();
    }
    consumed = permit; // Reserve before dispatch, including synchronous failures.
    record({ kind: 'upstream_attempt', index: consumed });
  }
  for (const [transport, protocol] of [
    [capabilities.http, 'http:'],
    [capabilities.https, 'https:'],
  ]) {
    const request = transport.request.bind(transport);
    transport.request = (...args) => {
      admit(protocol, args);
      return request(...args);
    };
    transport.get = (...args) => {
      const req = transport.request(...args);
      req.end();
      return req;
    };
  }
}

function summarizeGenericAcceptanceGuards(file, expectedRequests) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > 16384) throw fail();
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const attempts = rows.filter((row) => row.kind === 'upstream_attempt');
    const blocked = rows.filter((row) =>
      ['blocked_egress', 'blocked_retry_or_budget'].includes(row.kind)
    );
    return {
      actualUpstreamAttempts: attempts.length,
      authenticationReadOnlyReads: rows.filter((row) => row.kind === 'auth_read').length,
      blockedAttempts: blocked.length,
      verified:
        attempts.length === expectedRequests &&
        attempts.length <= 12 &&
        blocked.length === 0 &&
        attempts.every((row, index) => row.index === index + 1),
    };
  } catch {
    return { verified: false };
  }
}

module.exports = { installGenericAcceptanceGuards, summarizeGenericAcceptanceGuards };
