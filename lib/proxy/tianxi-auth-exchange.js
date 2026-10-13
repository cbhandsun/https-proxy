'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { randomInt } = require('node:crypto');
const { loadAuthBuild } = require('./tianxi-auth-build');
const { SCRIPT } = require('./tianxi-auth-native-script');
const { decodeJwtLikePayload } = require('./tianxi-agentcore-local');
function validIdentity(header) {
  return (
    header &&
    ['user_id', 'app_id', 'device_id'].every(
      (key) => typeof header[key] === 'string' && /^[A-Za-z0-9._:@-]{1,256}$/.test(header[key])
    )
  );
}
function candidateMatches(token, header, nowMs) {
  if (
    typeof token !== 'string' ||
    token.length > 16384 ||
    !/^sat-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  )
    return false;
  const candidate = decodeJwtLikePayload(token),
    old = decodeJwtLikePayload(header?.credentials?.qoder_token);
  return Boolean(
    candidate &&
    old &&
    Number.isSafeInteger(candidate.exp) &&
    candidate.exp * 1000 > nowMs + 60000 &&
    candidate.exp * 1000 <= nowMs + 86400000 &&
    ['sub', 'iss', 'aud'].every(
      (key) => typeof old[key] === 'string' && old[key] && candidate[key] === old[key]
    )
  );
}
function invokeNative(input, signal, spawnChild = spawn) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('tianxi_auth_aborted'));
      return;
    }
    const exe = path.join(
      process.env.SystemRoot || 'C:/Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe'
    );
    const child = spawnChild(
      exe,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(SCRIPT, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let output = '',
      bytes = 0,
      settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) {
        child.kill();
        reject(error);
      } else resolve(value);
    };
    const abort = () => finish(new Error('tianxi_auth_aborted'));
    const timer = setTimeout(() => finish(new Error('tianxi_auth_native_timeout')), 20000);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish(new Error('tianxi_auth_native_failed')));
    child.stdin.on('error', () => finish(new Error('tianxi_auth_native_failed')));
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 40000) finish(new Error('tianxi_auth_native_failed'));
      else output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 40000) finish(new Error('tianxi_auth_native_failed'));
    });
    child.on('close', (code) => {
      if (settled) return;
      try {
        const result = JSON.parse(output);
        if (code !== 0 || result.ok !== true) throw new Error();
        finish(null, result);
      } catch {
        finish(new Error('tianxi_auth_native_failed'));
      }
      output = '';
    });
    child.stdin.end(JSON.stringify(input) + '\n');
  });
}
async function exchangeTianxiToken(
  header,
  {
    signal,
    native = invokeNative,
    loadBuild = loadAuthBuild,
    fetchImpl = globalThis.fetch,
    now = Date.now,
  } = {}
) {
  if (!validIdentity(header)) throw new Error('tianxi_auth_identity_invalid');
  const build = loadBuild(header.app_id);
  const body = {
    positionId: build.positionId,
    appId: header.app_id,
    nonce: Array.from({ length: 10 }, () => build.alphabet[randomInt(build.alphabet.length)]).join(
      ''
    ),
    sign_type: 'RSA2',
    timestamp: String(now()),
    lenovoId: header.user_id,
  };
  const canonical = Object.keys(body)
    .sort()
    .map((key) => `${key}=${body[key]}`)
    .join('&');
  const reply = await native(
    { userId: header.user_id, initPayload: build.initPayload, canonical },
    signal
  );
  const v4 = typeof reply?.token === 'string' ? decodeJwtLikePayload(reply.token) : null;
  if (
    typeof reply?.token !== 'string' ||
    reply.token.length > 16384 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(reply.token) ||
    !v4 ||
    !Number.isSafeInteger(v4.exp) ||
    v4.exp * 1000 <= now() + 60000 ||
    v4.exp * 1000 > now() + 86400000 ||
    typeof reply.signature !== 'string' ||
    !/^[A-Za-z0-9+/]{342}==$/.test(reply.signature) ||
    Buffer.from(reply.signature, 'base64').length !== 256
  )
    throw new Error('tianxi_auth_native_reply_invalid');
  const response = await fetchImpl(build.endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: signal
      ? globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(10000)])
      : globalThis.AbortSignal.timeout(10000),
    headers: {
      Authorization: `Bearer ${reply.token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ ...body, sign: reply.signature }),
  });
  if (response.status !== 200) throw new Error('tianxi_auth_exchange_http_failed');
  if (!response.body || typeof response.body.getReader !== 'function')
    throw new Error('tianxi_auth_exchange_reply_invalid');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) throw new Error('tianxi_auth_exchange_reply_invalid');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('tianxi_auth_exchange_reply_invalid');
  }
  if (!value || value.code !== 10000) throw new Error('tianxi_auth_exchange_rejected');
  if (
    !Number.isSafeInteger(value.expiresIn) ||
    value.expiresIn <= 60 ||
    value.expiresIn > 86400 ||
    !candidateMatches(value.accessToken, header, now())
  )
    throw new Error('tianxi_auth_candidate_invalid');
  return value.accessToken;
}
module.exports = { exchangeTianxiToken, candidateMatches, invokeNative, validIdentity };
