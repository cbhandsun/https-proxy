/**
 * 密钥加密模块 - DPAPI (Windows) 优先，AES-256-GCM 兼容
 *
 * - hpm-dpapi:<base64> : Windows DPAPI CurrentUser scope，绑定到当前用户/机器
 * - hpm-enc:<iv>:<ct>:<tag> : 历史方案，AES-256-GCM，密钥由 hostname+username 派生
 *
 * 优先级:
 *   加密时优先尝试 DPAPI；DPAPI 不可用（macOS/Linux/失败）则退回到 AES-GCM。
 *   解密时按前缀自动识别，无需上层感知。
 *
 * 注意:
 *   - DPAPI 调用通过 PowerShell 完成（无需原生模块）
 *   - 解密结果按密文指纹缓存，避免每请求触发 PowerShell
 *   - loadConfig 会触发解密，因此缓存显著降低热路径开销
 */

const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');

const DPAPI_PREFIX = 'hpm-dpapi:';
const AES_PREFIX = 'hpm-enc:';
const DPAPI_SCOPE = 'CurrentUser';
const DPAPI_TIMEOUT_MS = 10000;
const DPAPI_DECRYPT_ATTEMPTS = 3;
const DPAPI_BATCH_SIZE = 64;
const DPAPI_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_PROTECTED_SECRET_LENGTH = 256 * 1024;
const SECRET_DECRYPTION_ERROR_CODE = 'ERR_SECRET_DECRYPTION_FAILED';

// ===== AES-256-GCM legacy fallback =====

const AES_SALT = 'hpm-local-salt-987654321';
let _aesKey = null;
function getAesKey() {
  if (_aesKey) return _aesKey;
  let secret = AES_SALT;
  try {
    secret += (os.hostname() || '') + (os.userInfo().username || '');
  } catch (e) {
    /* ignore */
  }
  _aesKey = crypto.createHash('sha256').update(secret).digest();
  return _aesKey;
}

function decryptAes(cipherText) {
  if (!cipherText || !cipherText.startsWith(AES_PREFIX)) return cipherText;
  try {
    const parts = cipherText.substring(AES_PREFIX.length).split(':');
    if (parts.length !== 3) return cipherText;
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = Buffer.from(parts[1], 'hex');
    const tag = Buffer.from(parts[2], 'hex');
    if (iv.length !== 12 || tag.length !== 16) return cipherText;
    const decipher = crypto.createDecipheriv('aes-256-gcm', getAesKey(), iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.warn('[crypto] Failed to decrypt AES key:', err.message);
    return cipherText;
  }
}

function encryptAes(text) {
  if (!text) return '';
  if (text.startsWith(DPAPI_PREFIX) || text.startsWith(AES_PREFIX)) return text;
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getAesKey(), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return AES_PREFIX + iv.toString('hex') + ':' + encrypted + ':' + tag;
  } catch (err) {
    console.error('[crypto] AES encryption failed:', err.message);
    return text;
  }
}

// ===== DPAPI (Windows only) =====

let _dpapiAvailable = null; // null = unknown, true/false = probed
let _dpapiDisabledReason = null;

function isWindows() {
  return process.platform === 'win32';
}

function runPowerShell(script, options = {}) {
  // Suppress PowerShell noise (verbose error stream) to keep our logs clean.
  // On non-zero exit (e.g. DPAPI failure) we return null and let caller handle it.
  try {
    const result = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `$ErrorActionPreference='SilentlyContinue';$WarningPreference='SilentlyContinue';${script}`,
      ],
      {
        encoding: 'utf8',
        timeout: DPAPI_TIMEOUT_MS,
        maxBuffer: DPAPI_MAX_BUFFER_BYTES,
        input: typeof options.input === 'string' ? options.input : undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    return result.trim();
  } catch (err) {
    return null;
  }
}

function dpapiProbe() {
  if (_dpapiAvailable === true) return true;
  if (!isWindows()) {
    _dpapiAvailable = false;
    _dpapiDisabledReason = 'not-windows';
    return false;
  }
  try {
    // Smoke test: encrypt+decrypt a known string
    const sample = 'hpm-dpapi-probe';
    const sampleB64 = Buffer.from(sample, 'utf16le').toString('base64');
    const ct = runPowerShell(
      `Add-Type -AssemblyName System.Security;` +
        `$b=[Convert]::FromBase64String('${sampleB64}');` +
        `$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,'${DPAPI_SCOPE}');` +
        `[Convert]::ToBase64String($p)`
    );
    const ptB64 = runPowerShell(
      `Add-Type -AssemblyName System.Security;` +
        `$b=[Convert]::FromBase64String('${ct}');` +
        `$u=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'${DPAPI_SCOPE}');` +
        `[Convert]::ToBase64String($u)`
    );
    if (!ct || !ptB64) throw new Error('probe produced empty output');
    const pt = Buffer.from(ptB64, 'base64').toString('utf16le');
    if (pt !== sample) throw new Error('probe roundtrip mismatch');
    _dpapiAvailable = true;
    return true;
  } catch (err) {
    _dpapiAvailable = false;
    _dpapiDisabledReason = err && err.message ? err.message : 'unknown';
    return false;
  }
}

function dpapiProtect(plaintext) {
  if (!dpapiProbe()) return null;
  try {
    // Use UTF-16LE bytes to preserve arbitrary unicode safely
    const b64 = Buffer.from(plaintext, 'utf16le').toString('base64');
    const result = runPowerShell(
      `Add-Type -AssemblyName System.Security;` +
        `$b=[Convert]::FromBase64String('${b64}');` +
        `$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,'${DPAPI_SCOPE}');` +
        `[Convert]::ToBase64String($p)`
    );
    if (!result) throw new Error('powershell returned empty');
    return DPAPI_PREFIX + result;
  } catch (err) {
    _dpapiAvailable = false;
    _dpapiDisabledReason = err && err.message ? err.message : 'unknown';
    return null;
  }
}

function dpapiUnprotect(payload) {
  if (!payload || !payload.startsWith(DPAPI_PREFIX)) return payload;
  try {
    return decryptKeysStrict([payload])[0];
  } catch (err) {
    console.warn('[crypto] DPAPI unprotect failed:', err.code || 'unprotect_failed');
    return payload;
  }
}

// ===== Public API =====

const _decryptCache = new Map();

function secretDecryptionError(message = 'Failed to decrypt protected configuration secrets') {
  const error = new Error(message);
  error.code = SECRET_DECRYPTION_ERROR_CODE;
  return error;
}

function isPlausibleBase64(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

function unprotectDpapiBatchOnce(cipherTexts) {
  if (!isWindows()) throw secretDecryptionError('DPAPI secrets require Windows CurrentUser');
  const payloads = cipherTexts.map((cipherText) => {
    if (typeof cipherText !== 'string' || cipherText.length > MAX_PROTECTED_SECRET_LENGTH) {
      throw secretDecryptionError();
    }
    const payload = cipherText.substring(DPAPI_PREFIX.length);
    if (!isPlausibleBase64(payload)) throw secretDecryptionError();
    return payload;
  });
  const script =
    `Add-Type -AssemblyName System.Security;` +
    `$items=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd());` +
    `$values=New-Object System.Collections.ArrayList;` +
    `foreach($item in @($items)){` +
    `try{` +
    `$b=[Convert]::FromBase64String([string]$item);` +
    `$u=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'${DPAPI_SCOPE}');` +
    `[void]$values.Add([Convert]::ToBase64String($u));` +
    `}catch{[void]$values.Add($null)}` +
    `};` +
    `$result=[ordered]@{values=@($values.ToArray())};` +
    `[Console]::Out.Write(($result|ConvertTo-Json -Compress));`;
  const raw = runPowerShell(script, { input: JSON.stringify(payloads) });
  if (!raw) throw secretDecryptionError();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw secretDecryptionError();
  }
  if (!parsed || !Array.isArray(parsed.values) || parsed.values.length !== cipherTexts.length) {
    throw secretDecryptionError();
  }
  return parsed.values.map((value) => {
    if (typeof value !== 'string' || !isPlausibleBase64(value)) {
      throw secretDecryptionError();
    }
    return Buffer.from(value, 'base64').toString('utf16le');
  });
}

function unprotectDpapiBatch(cipherTexts) {
  let lastError = null;
  for (let attempt = 0; attempt < DPAPI_DECRYPT_ATTEMPTS; attempt += 1) {
    try {
      const values = unprotectDpapiBatchOnce(cipherTexts);
      _dpapiAvailable = true;
      _dpapiDisabledReason = null;
      return values;
    } catch (error) {
      lastError = error;
    }
  }
  _dpapiAvailable = false;
  _dpapiDisabledReason = 'batch-unprotect-failed';
  throw lastError || secretDecryptionError();
}

function decryptKeysStrict(values) {
  if (!Array.isArray(values)) throw new TypeError('decryptKeysStrict requires an array');
  const resolved = new Map();
  const pendingDpapi = [];

  for (const value of values) {
    if (typeof value !== 'string' || !value) continue;
    if (_decryptCache.has(value)) {
      resolved.set(value, _decryptCache.get(value));
      continue;
    }
    if (value.startsWith(AES_PREFIX)) {
      const plain = decryptAes(value);
      if (!plain || plain === value) throw secretDecryptionError();
      _decryptCache.set(value, plain);
      resolved.set(value, plain);
      continue;
    }
    if (value.startsWith(DPAPI_PREFIX) && !pendingDpapi.includes(value)) {
      pendingDpapi.push(value);
    }
  }

  for (let offset = 0; offset < pendingDpapi.length; offset += DPAPI_BATCH_SIZE) {
    const batch = pendingDpapi.slice(offset, offset + DPAPI_BATCH_SIZE);
    const plainValues = unprotectDpapiBatch(batch);
    for (let index = 0; index < batch.length; index += 1) {
      const plain = plainValues[index];
      if (!plain || plain === batch[index]) throw secretDecryptionError();
      _decryptCache.set(batch[index], plain);
      resolved.set(batch[index], plain);
    }
  }

  return values.map((value) => resolved.get(value) || value);
}

function decryptKey(cipherText) {
  if (!cipherText) return cipherText;
  if (typeof cipherText !== 'string') return cipherText;
  if (!cipherText.startsWith(DPAPI_PREFIX) && !cipherText.startsWith(AES_PREFIX)) return cipherText;

  // Cache hit
  if (_decryptCache.has(cipherText)) return _decryptCache.get(cipherText);

  let plain = cipherText;
  if (cipherText.startsWith(DPAPI_PREFIX)) {
    plain = dpapiUnprotect(cipherText);
  } else if (cipherText.startsWith(AES_PREFIX)) {
    plain = decryptAes(cipherText);
  }

  // Only cache successful decryptions (i.e. returned value differs from input)
  if (plain && plain !== cipherText) {
    _decryptCache.set(cipherText, plain);
  }
  return plain;
}

function encryptKey(text) {
  if (!text) return '';
  if (typeof text !== 'string') return '';
  if (text.startsWith(DPAPI_PREFIX) || text.startsWith(AES_PREFIX)) return text;

  if (dpapiProbe()) {
    const enc = dpapiProtect(text);
    if (enc) return enc;
  }
  return encryptAes(text);
}

function clearDecryptCache() {
  _decryptCache.clear();
}

function getCryptoBackend() {
  return {
    isWindows: isWindows(),
    dpapiAvailable: _dpapiAvailable === null ? null : _dpapiAvailable,
    dpapiDisabledReason: _dpapiDisabledReason,
    prefersDpapi: _dpapiAvailable === true,
  };
}

module.exports = {
  DPAPI_PREFIX,
  AES_PREFIX,
  SECRET_DECRYPTION_ERROR_CODE,
  encryptKey,
  decryptKey,
  decryptKeysStrict,
  clearDecryptCache,
  getCryptoBackend,
  // Test hooks
  _dpapiProbe: dpapiProbe,
  _dpapiProtect: dpapiProtect,
  _dpapiUnprotect: dpapiUnprotect,
  _encryptAes: encryptAes,
  _decryptAes: decryptAes,
};
