const assert = require('assert');

const {
  MAX_CREDENTIAL_BYTES,
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
    env: { PATH: 'test-path' },
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
  assert.ok(call.options.maxBuffer >= MAX_CREDENTIAL_BYTES);
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
    execFile() {
      return stdout;
    },
  });

  assert.strictEqual(result, '');
}

{
  const result = readWindowsGenericCredentialUtf8('gemini:antigravity', {
    platform: 'win32',
    execFile() {
      throw new Error('private credential read failure');
    },
  });

  assert.strictEqual(result, '');
}
