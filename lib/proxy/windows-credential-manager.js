'use strict';

const { execFileSync } = require('node:child_process');

const MAX_CREDENTIAL_BYTES = 16 * 1024;
const POWERSHELL_CRED_READ_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$Target = $env:HPM_CRED_TARGET
if ([string]::IsNullOrEmpty($Target)) {
  @{ ok = $false } | ConvertTo-Json -Compress
  exit 0
}
$src=@'
using System;
using System.Runtime.InteropServices;
public static class HpmCredRead {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern void CredFree(IntPtr buffer);
}
'@
Add-Type $src
$ptr=[IntPtr]::Zero
if (![HpmCredRead]::CredRead($Target, 1, 0, [ref]$ptr)) {
  @{ ok = $false } | ConvertTo-Json -Compress
  exit 0
}
try {
  $cred=[Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][HpmCredRead+CREDENTIAL])
  if ($cred.CredentialBlobSize -le 0 -or $cred.CredentialBlobSize -gt ${MAX_CREDENTIAL_BYTES}) {
    @{ ok = $false } | ConvertTo-Json -Compress
    exit 0
  }
  $bytes=New-Object byte[] $cred.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
  @{ ok = $true; blobBase64 = [Convert]::ToBase64String($bytes) } | ConvertTo-Json -Compress
} finally {
  [HpmCredRead]::CredFree($ptr)
}
`;

function readWindowsGenericCredentialUtf8(target, options = {}) {
  const {
    execFile = execFileSync,
    env = process.env,
    platform = process.platform,
    timeoutMs = 3000,
    maxCredentialBytes = MAX_CREDENTIAL_BYTES,
  } = options;
  if (platform !== 'win32') return '';
  if (env.HPM_DISABLE_WINDOWS_CREDENTIAL_MANAGER === '1') return '';
  if (
    typeof target !== 'string' ||
    target.length < 1 ||
    target.length > 256 ||
    target.includes('\0')
  ) {
    return '';
  }

  try {
    const stdout = execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        POWERSHELL_CRED_READ_SCRIPT,
      ],
      {
        encoding: 'utf8',
        env: { ...env, HPM_CRED_TARGET: target },
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: maxCredentialBytes * 2,
      }
    );
    const parsed = JSON.parse(String(stdout || '').trim() || '{}');
    if (!parsed || parsed.ok !== true || typeof parsed.blobBase64 !== 'string') return '';
    const bytes = Buffer.from(parsed.blobBase64, 'base64');
    if (bytes.length < 1 || bytes.length > maxCredentialBytes) return '';
    return bytes.toString('utf8');
  } catch {
    return '';
  }
}

module.exports = {
  MAX_CREDENTIAL_BYTES,
  readWindowsGenericCredentialUtf8,
};
