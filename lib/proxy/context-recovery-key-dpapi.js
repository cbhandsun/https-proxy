'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const {
  KEY_PREFIX,
  keyRequest,
  keyResponse,
  keyFailure,
} = require('./context-recovery-key-contract');
const DEFAULT_NATIVE_EXECUTABLE = path.resolve(
  __dirname,
  '../../runtime/native/hpm-context-recovery-key.exe'
);

// Fixed program. Key material is exclusively supplied through stdin. Do not
// reuse credential compatibility encryption, its key-file fallback or logging.
const SCRIPT = `
$ErrorActionPreference='Stop';$WarningPreference='SilentlyContinue';$ProgressPreference='SilentlyContinue';
try {
  [void][Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a');
  $keyRequestText=[Console]::In.ReadToEnd();
  if($keyRequestText.Length -gt 17000){throw 'invalid'};
  $keyMatch=[regex]::Match($keyRequestText,'\\A\\{"operation":"(protect|unprotect)","value":"([A-Za-z0-9+/]*={0,2})"\\}\\z');
  if(-not $keyMatch.Success){throw 'invalid'};
  $keyRequest=@{operation=$keyMatch.Groups[1].Value;value=$keyMatch.Groups[2].Value};
  $keyBytes=[Convert]::FromBase64String($keyRequest.value);
  $keyEntropy=[Text.Encoding]::UTF8.GetBytes('hpm/context-recovery/data-key/v1');
  if($keyRequest.operation -eq 'protect'){
    if($keyBytes.Length -ne 32){throw 'invalid'};
    $keyResult=[Security.Cryptography.ProtectedData]::Protect($keyBytes,$keyEntropy,'CurrentUser');
    $keyCheck=[Security.Cryptography.ProtectedData]::Unprotect($keyResult,$keyEntropy,'CurrentUser');
    if($keyCheck.Length -ne 32 -or [Convert]::ToBase64String($keyCheck) -cne $keyRequest.value){throw 'invalid'};
    [Array]::Clear($keyCheck,0,$keyCheck.Length);
  } elseif($keyRequest.operation -eq 'unprotect'){
    $keyResult=[Security.Cryptography.ProtectedData]::Unprotect($keyBytes,$keyEntropy,'CurrentUser');
    if($keyResult.Length -ne 32){throw 'invalid'};
  } else {throw 'invalid'};
  [Console]::Out.Write('{"ok":true,"value":"'+[Convert]::ToBase64String($keyResult)+'"}');
} catch { [Console]::Out.Write('{"ok":false}'); exit 1 }
`;

function protectWithCurrentUser(
  input,
  {
    platform = process.platform,
    environment = process.env,
    execute = execFileSync,
    nativeExecutable = DEFAULT_NATIVE_EXECUTABLE,
  } = {}
) {
  try {
    const request = keyRequest(input);
    const root = environment.SystemRoot || environment.WINDIR;
    if (
      platform !== 'win32' ||
      typeof root !== 'string' ||
      !/^[A-Za-z]:[\\/]/.test(root) ||
      /[\0\r\n]/.test(root)
    )
      throw keyFailure();
    let useNative = false;
    if (nativeExecutable !== null) {
      if (
        typeof nativeExecutable !== 'string' ||
        nativeExecutable.length > 4096 ||
        !path.isAbsolute(nativeExecutable) ||
        !nativeExecutable.endsWith('.exe') ||
        /^[\\/]{2}/.test(nativeExecutable) ||
        /[\0\r\n]/.test(nativeExecutable)
      )
        throw keyFailure();
      try {
        const stat = fs.lstatSync(nativeExecutable);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw keyFailure();
        let parent = path.dirname(nativeExecutable);
        while (parent !== path.dirname(parent)) {
          const ancestor = fs.lstatSync(parent);
          if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) throw keyFailure();
          parent = path.dirname(parent);
        }
        useNative = true;
      } catch (error) {
        if (error?.code !== 'ENOENT' || nativeExecutable !== DEFAULT_NATIVE_EXECUTABLE)
          throw keyFailure();
        // Source-only checkouts retain the existing fixed PowerShell backend.
        // A dispatched native request is never retried through another backend.
      }
    }
    const executable = useNative
      ? nativeExecutable
      : path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = execute(
      executable,
      useNative
        ? ['--hpm-context-key-v1']
        : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', SCRIPT],
      {
        input: JSON.stringify({
          operation: request.operation,
          value:
            request.operation === 'protect'
              ? request.value
              : request.value.slice(KEY_PREFIX.length),
        }),
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 20000,
        windowsHide: true,
        env: { SystemRoot: root, WINDIR: root },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    if (typeof result !== 'string' || Buffer.byteLength(result) > 17000) throw keyFailure();
    const response = JSON.parse(result);
    // Both fixed backends emit compact JSON. Refuse duplicate fields and alternate
    // encodings before accepting a success from the parsed reply.
    if (JSON.stringify(response) !== result) throw keyFailure();
    // A raw native reply never becomes the public wrapping format unchecked.
    const value = keyResponse(
      request.operation,
      request.operation === 'protect' && response?.ok === true
        ? { ...response, value: KEY_PREFIX + response.value }
        : response
    );
    return value;
  } catch {
    throw keyFailure();
  }
}

module.exports = { protectWithCurrentUser };
