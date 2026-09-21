const assert = require('assert');

const {
  DEFAULT_NATIVE_TIMEOUT_MS,
  DEFAULT_POWERSHELL_TIMEOUT_MS,
  MAX_CREDENTIAL_BYTES,
  clearWindowsCredentialCache,
  readWindowsGenericCredentialUtf8,
} = require('../lib/proxy/windows-credential-manager');

function encodedCredential(value) {
  return JSON.stringify({
    ok: true,
    blobBase64: Buffer.from(value, 'utf8').toString('base64'),
  });
}

{
  let call = null;
  const result = readWindowsGenericCredentialUtf8('gemini:antigravity', {
    platform: 'win32',
    cacheTtlMs: 0,
    env: { PATH: 'test-path' },
    resolveNativeHelper: () => '',
    execFile(command, args, options) {
      call = { command, args, options };
      return encodedCredential('{"token":{"access_token":"ya29.test"}}');
    },
  });

  assert.strictEqual(result, '{"token":{"access_token":"ya29.test"}}');
  assert.strictEqual(call.command, 'powershell.exe');
  assert.ok(call.args.includes('-NoProfile'));
  assert.ok(call.args.includes('-NonInteractive'));
  assert.strictEqual(call.options.env.HPM_CRED_TARGET, 'gemini:antigravity');
  assert.strictEqual(call.options.windowsHide, true);
  assert.strictEqual(call.options.timeout, DEFAULT_POWERSHELL_TIMEOUT_MS);
  assert.ok(call.options.maxBuffer >= MAX_CREDENTIAL_BYTES);
}

{
  clearWindowsCredentialCache();
  let calls = 0;
  const options = {
    platform: 'win32',
    cacheTtlMs: 60000,
    resolveNativeHelper: () => 'C:\\safe\\windows-credential-reader.exe',
    execFile() {
      calls += 1;
      return encodedCredential('{"token":{"access_token":"ya29.cached"}}');
    },
  };
  const first = readWindowsGenericCredentialUtf8('gemini:cache-test', options);
  const second = readWindowsGenericCredentialUtf8('gemini:cache-test', options);
  const forced = readWindowsGenericCredentialUtf8('gemini:cache-test', {
    ...options,
    forceReload: true,
  });

  assert.strictEqual(first, second);
  assert.strictEqual(second, forced);
  assert.strictEqual(calls, 2);
  clearWindowsCredentialCache();
}

{
  const calls = [];
  const result = readWindowsGenericCredentialUtf8('gemini:antigravity', {
    platform: 'win32',
    cacheTtlMs: 0,
    env: { PATH: 'test-path' },
    resolveNativeHelper: () => 'C:\\safe\\windows-credential-reader.exe',
    execFile(command, args, options) {
      calls.push({ command, args, options });
      return encodedCredential('{"token":{"access_token":"ya29.native"}}');
    },
  });

  assert.strictEqual(result, '{"token":{"access_token":"ya29.native"}}');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].command, 'C:\\safe\\windows-credential-reader.exe');
  assert.deepStrictEqual(calls[0].args, []);
  assert.strictEqual(calls[0].options.timeout, DEFAULT_NATIVE_TIMEOUT_MS);
  assert.strictEqual(calls[0].options.env.HPM_CRED_TARGET, 'gemini:antigravity');
}

{
  const calls = [];
  const result = readWindowsGenericCredentialUtf8('gemini:antigravity', {
    platform: 'win32',
    cacheTtlMs: 0,
    resolveNativeHelper: () => 'C:\\safe\\windows-credential-reader.exe',
    execFile(command) {
      calls.push(command);
      if (calls.length === 1) throw new Error('native helper unavailable');
      return encodedCredential('{"token":{"access_token":"ya29.fallback"}}');
    },
  });

  assert.strictEqual(result, '{"token":{"access_token":"ya29.fallback"}}');
  assert.deepStrictEqual(calls, ['C:\\safe\\windows-credential-reader.exe', 'powershell.exe']);
}

{
  const result = readWindowsGenericCredentialUtf8('gemini:antigravity', {
    platform: 'linux',
    execFile() {
      throw new Error('should not execute');
    },
  });

  assert.strictEqual(result, '');
}

{
  const result = readWindowsGenericCredentialUtf8('gemini:antigravity', {
    platform: 'win32',
    env: { HPM_DISABLE_WINDOWS_CREDENTIAL_MANAGER: '1' },
    execFile() {
      throw new Error('should not execute');
    },
  });

  assert.strictEqual(result, '');
}

for (const target of ['', 'bad\0target', 'x'.repeat(257)]) {
  const result = readWindowsGenericCredentialUtf8(target, {
    platform: 'win32',
    execFile() {
      throw new Error('should not execute');
    },
  });

  assert.strictEqual(result, '');
}

for (const stdout of [
  '',
  'not-json',
  JSON.stringify({ ok: false }),
  JSON.stringify({ ok: true, blobBase64: '' }),
  JSON.stringify({ ok: true, blobBase64: Buffer.from('abcdef').toString('base64') }),
]) {
  const result = readWindowsGenericCredentialUtf8('gemini:antigravity', {
    platform: 'win32',
    maxCredentialBytes: 4,
    resolveNativeHelper: () => '',
    execFile() {
      return stdout;
    },
  });

  assert.strictEqual(result, '');
}

{
  const result = readWindowsGenericCredentialUtf8('gemini:antigravity', {
    platform: 'win32',
    resolveNativeHelper: () => '',
    execFile() {
      throw new Error('private credential read failure');
    },
  });

  assert.strictEqual(result, '');
}
