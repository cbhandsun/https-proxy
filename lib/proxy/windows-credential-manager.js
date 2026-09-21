'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MAX_CREDENTIAL_BYTES = 16 * 1024;
const DEFAULT_NATIVE_TIMEOUT_MS = 12000;
const DEFAULT_POWERSHELL_TIMEOUT_MS = 12000;
const DEFAULT_CREDENTIAL_CACHE_TTL_MS = 4 * 60 * 1000;
const MAX_HELPER_BYTES = 512 * 1024;
const NATIVE_HELPER_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;

internal static class HpmWindowsCredentialReader
{
    private const int MaxCredentialBytes = ${MAX_CREDENTIAL_BYTES};

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
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

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern void CredFree(IntPtr buffer);

    private static void WriteFailure()
    {
        Console.Write("{\"ok\":false}");
    }

    public static int Main()
    {
        string target = Environment.GetEnvironmentVariable("HPM_CRED_TARGET");
        if (String.IsNullOrEmpty(target) || target.Length > 256 || target.IndexOf('\0') >= 0)
        {
            WriteFailure();
            return 0;
        }

        IntPtr pointer = IntPtr.Zero;
        if (!CredRead(target, 1, 0, out pointer))
        {
            WriteFailure();
            return 0;
        }

        try
        {
            Credential credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
            if (credential.CredentialBlobSize < 1 || credential.CredentialBlobSize > MaxCredentialBytes)
            {
                WriteFailure();
                return 0;
            }

            byte[] bytes = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
            Console.Write("{\"ok\":true,\"blobBase64\":\"" + Convert.ToBase64String(bytes) + "\"}");
            return 0;
        }
        catch
        {
            WriteFailure();
            return 0;
        }
        finally
        {
            CredFree(pointer);
        }
    }
}
`;
const NATIVE_HELPER_SOURCE_HASH = crypto
  .createHash('sha256')
  .update(NATIVE_HELPER_SOURCE)
  .digest('hex')
  .slice(0, 16);

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

let cachedNativeHelperPath = '';
const credentialCache = new Map();

function clearWindowsCredentialCache() {
  credentialCache.clear();
}

function regularFileWithinLimit(filePath, fsModule = fs, maxBytes = MAX_HELPER_BYTES) {
  try {
    const stat = fsModule.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maxBytes;
  } catch {
    return false;
  }
}

function windowsRuntimeDirectory(env = process.env) {
  const configured = env.PROXY_RUNTIME_DIR || env.PROXY_DATA_DIR;
  return path.resolve(configured || path.join(__dirname, '..', '..', '.hpm-runtime'));
}

function windowsCompilerCandidates(env = process.env) {
  const windowsDirectory = path.resolve(env.WINDIR || 'C:\\Windows');
  return [
    path.join(windowsDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windowsDirectory, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
}

function resolveWindowsCredentialHelper(options = {}) {
  const {
    env = process.env,
    execFile = execFileSync,
    fsModule = fs,
    platform = process.platform,
  } = options;
  if (platform !== 'win32') return '';
  if (cachedNativeHelperPath && regularFileWithinLimit(cachedNativeHelperPath, fsModule)) {
    return cachedNativeHelperPath;
  }

  const runtimeDirectory = windowsRuntimeDirectory(env);
  const helperDirectory = path.join(runtimeDirectory, 'native');
  const helperPath = path.join(
    helperDirectory,
    `windows-credential-reader-${NATIVE_HELPER_SOURCE_HASH}.exe`
  );
  if (regularFileWithinLimit(helperPath, fsModule)) {
    cachedNativeHelperPath = helperPath;
    return helperPath;
  }

  const compilerPath = windowsCompilerCandidates(env).find((candidate) =>
    regularFileWithinLimit(candidate, fsModule, 8 * 1024 * 1024)
  );
  if (!compilerPath) return '';

  const nonce = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const sourcePath = path.join(helperDirectory, `windows-credential-reader-${nonce}.cs`);
  const outputPath = path.join(helperDirectory, `windows-credential-reader-${nonce}.exe`);
  try {
    fsModule.mkdirSync(helperDirectory, { recursive: true });
    fsModule.writeFileSync(sourcePath, NATIVE_HELPER_SOURCE, { encoding: 'utf8', mode: 0o600 });
    execFile(
      compilerPath,
      ['/nologo', '/optimize+', '/target:exe', `/out:${outputPath}`, sourcePath],
      {
        encoding: 'utf8',
        env,
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 64 * 1024,
      }
    );
    if (!regularFileWithinLimit(outputPath, fsModule)) return '';
    try {
      fsModule.renameSync(outputPath, helperPath);
    } catch {
      if (!regularFileWithinLimit(helperPath, fsModule)) return '';
    }
    cachedNativeHelperPath = helperPath;
    return helperPath;
  } catch {
    return '';
  } finally {
    for (const temporaryPath of [sourcePath, outputPath]) {
      try {
        fsModule.rmSync(temporaryPath, { force: true });
      } catch {}
    }
  }
}

function decodeCredentialOutput(stdout, maxCredentialBytes) {
  try {
    const parsed = JSON.parse(String(stdout || '').trim() || '{}');
    if (!parsed || parsed.ok !== true || typeof parsed.blobBase64 !== 'string') return '';
    const bytes = Buffer.from(parsed.blobBase64, 'base64');
    if (bytes.length < 1 || bytes.length > maxCredentialBytes) return '';
    return bytes.toString('utf8');
  } catch {
    return '';
  }
}

function readWindowsGenericCredentialUtf8(target, options = {}) {
  const {
    execFile = execFileSync,
    env = process.env,
    platform = process.platform,
    nativeTimeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
    powershellTimeoutMs = DEFAULT_POWERSHELL_TIMEOUT_MS,
    cacheTtlMs = DEFAULT_CREDENTIAL_CACHE_TTL_MS,
    forceReload = false,
    maxCredentialBytes = MAX_CREDENTIAL_BYTES,
    resolveNativeHelper = resolveWindowsCredentialHelper,
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

  const boundedCacheTtlMs = Number.isFinite(Number(cacheTtlMs))
    ? Math.min(10 * 60 * 1000, Math.max(0, Math.trunc(Number(cacheTtlMs))))
    : DEFAULT_CREDENTIAL_CACHE_TTL_MS;
  const cached = credentialCache.get(target);
  if (!forceReload && cached && cached.expiresAt > Date.now()) return cached.value;

  const childEnv = { ...env, HPM_CRED_TARGET: target };
  try {
    const nativeHelperPath = resolveNativeHelper({ env, execFile, platform });
    if (nativeHelperPath) {
      const nativeOutput = execFile(nativeHelperPath, [], {
        encoding: 'utf8',
        env: childEnv,
        windowsHide: true,
        timeout: nativeTimeoutMs,
        maxBuffer: maxCredentialBytes * 2,
      });
      const credential = decodeCredentialOutput(nativeOutput, maxCredentialBytes);
      if (credential) {
        if (boundedCacheTtlMs > 0) {
          credentialCache.set(target, {
            value: credential,
            expiresAt: Date.now() + boundedCacheTtlMs,
          });
        }
        return credential;
      }
    }
  } catch {}

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
        env: childEnv,
        windowsHide: true,
        timeout: powershellTimeoutMs,
        maxBuffer: maxCredentialBytes * 2,
      }
    );
    const credential = decodeCredentialOutput(stdout, maxCredentialBytes);
    if (credential && boundedCacheTtlMs > 0) {
      credentialCache.set(target, {
        value: credential,
        expiresAt: Date.now() + boundedCacheTtlMs,
      });
    }
    return credential;
  } catch {
    return '';
  }
}

module.exports = {
  DEFAULT_CREDENTIAL_CACHE_TTL_MS,
  DEFAULT_NATIVE_TIMEOUT_MS,
  DEFAULT_POWERSHELL_TIMEOUT_MS,
  MAX_CREDENTIAL_BYTES,
  clearWindowsCredentialCache,
  decodeCredentialOutput,
  readWindowsGenericCredentialUtf8,
  resolveWindowsCredentialHelper,
  windowsCompilerCandidates,
  windowsRuntimeDirectory,
};
