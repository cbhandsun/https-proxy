'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
  resolveWindowsSystemTool,
  securePrivatePathSync,
} = require('../lib/proxy/secure-files');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-secure-files-'));
const filePath = path.join(tempRoot, 'secret.txt');
fs.writeFileSync(filePath, 'secret', 'utf8');

assert.throws(() => securePrivatePathSync('', 'file'), /non-empty string/);
assert.throws(() => securePrivatePathSync(filePath, 'socket'), /file or directory/);
assert.throws(() => securePrivatePathSync(tempRoot, 'file'), /Sensitive path is not a file/);
assert.throws(
  () => securePrivatePathSync(filePath, 'directory'),
  /Sensitive path is not a directory/
);

const chmodCalls = [];
const posixFs = {
  statSync: fs.statSync,
  chmodSync(targetPath, mode) {
    chmodCalls.push({ targetPath, mode });
  },
};
assert.strictEqual(
  securePrivatePathSync(filePath, 'file', { fsModule: posixFs, platform: 'linux' }),
  path.resolve(filePath)
);
assert.deepStrictEqual(chmodCalls.pop(), {
  targetPath: path.resolve(filePath),
  mode: PRIVATE_FILE_MODE,
});
securePrivatePathSync(tempRoot, 'directory', { fsModule: posixFs, platform: 'darwin' });
assert.strictEqual(chmodCalls.pop().mode, PRIVATE_DIRECTORY_MODE);

const windowsInvocations = [];
const mockEnvironment = { SystemRoot: 'C:\\Windows', SAFE_PARENT_VALUE: 'preserved' };
ensurePrivateFileSync(filePath, {
  platform: 'win32',
  environment: mockEnvironment,
  currentUserSid: 'S-1-5-21-1000',
  execFileSync(command, args, options) {
    windowsInvocations.push({ command, args, options });
  },
});
assert.strictEqual(windowsInvocations.length, 2);
const resetInvocation = windowsInvocations[0];
const windowsInvocation = windowsInvocations[1];
assert.deepStrictEqual(resetInvocation.args.slice(1), ['/reset', '/c', '/q']);
assert.strictEqual(windowsInvocation.command, 'C:\\Windows\\System32\\icacls.exe');
assert.strictEqual(windowsInvocation.args[0], path.resolve(filePath));
assert.ok(windowsInvocation.args.includes('/inheritance:r'));
assert.ok(windowsInvocation.args.includes('*S-1-5-21-1000:F'));
assert.ok(windowsInvocation.args.includes('*S-1-5-11'));
assert.strictEqual(windowsInvocation.options.env.SAFE_PARENT_VALUE, 'preserved');
ensurePrivateFileSync(filePath, {
  platform: 'win32',
  environment: mockEnvironment,
  currentUserSid: 'S-1-5-21-1000',
  execFileSync(command, args, options) {
    windowsInvocations.push({ command, args, options });
  },
});
assert.strictEqual(
  windowsInvocations.length,
  2,
  'unchanged Windows files must not execute ACL subprocesses repeatedly'
);

assert.strictEqual(resolveWindowsSystemTool('icacls.exe', {}), 'icacls.exe');
assert.throws(
  () =>
    ensurePrivateFileSync(filePath, {
      platform: 'win32',
      force: true,
      currentUserSid: 'S-1-5-21-1000',
      execFileSync() {
        throw new Error('ACL denied');
      },
    }),
  /ACL denied/
);

const nestedDirectory = path.join(tempRoot, 'nested', 'private');
const mkdirCalls = [];
const directoryFs = {
  mkdirSync(targetPath, options) {
    mkdirCalls.push({ targetPath, options });
    fs.mkdirSync(targetPath, options);
  },
  statSync: fs.statSync,
  chmodSync: fs.chmodSync,
};
ensurePrivateDirectorySync(nestedDirectory, {
  fsModule: directoryFs,
  platform: 'linux',
});
assert.strictEqual(mkdirCalls[0].options.mode, PRIVATE_DIRECTORY_MODE);
assert.ok(fs.statSync(nestedDirectory).isDirectory());

console.log('[secure-files.test] ok');
