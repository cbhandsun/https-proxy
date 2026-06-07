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
const DPAPI_TIMEOUT_MS = 4000;

// ===== AES-256-GCM legacy fallback =====

const AES_SALT = 'hpm-local-salt-987654321';
let _aesKey = null;
function getAesKey() {
  if (_aesKey) return _aesKey;
  let secret = AES_SALT;
  try {
    secret += (os.hostname() || '') + (os.userInfo().username || '');
  } catch (e) { /* ignore */ }
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

function runPowerShell(script) {
  // Suppress PowerShell noise (verbose error stream) to keep our logs clean.
  // On non-zero exit (e.g. DPAPI failure) we return null and let caller handle it.
  try {
    const result = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', `$ErrorActionPreference='SilentlyContinue';$WarningPreference='SilentlyContinue';${script}`,
    ], { encoding: 'utf8', timeout: DPAPI_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    return result.trim();
  } catch (err) {
    return null;
  }
}

function dpapiProbe() {
  if (_dpapiAvailable !== null) return _dpapiAvailable;
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
      `[Convert]::ToBase64String($p)`,
    );
    const ptB64 = runPowerShell(
      `Add-Type -AssemblyName System.Security;` +
      `$b=[Convert]::FromBase64String('${ct}');` +
      `$u=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'${DPAPI_SCOPE}');` +
      `[Convert]::ToBase64String($u)`,
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
      `[Convert]::ToBase64String($p)`,
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
  const b64 = payload.substring(DPAPI_PREFIX.length);
  if (!dpapiProbe()) return payload;
  try {
    const result = runPowerShell(
      `Add-Type -AssemblyName System.Security;` +
      `$b=[Convert]::FromBase64String('${b64}');` +
      `$u=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'${DPAPI_SCOPE}');` +
      `[Convert]::ToBase64String($u)`,
    );
    if (!result) throw new Error('powershell returned empty');
    return Buffer.from(result, 'base64').toString('utf16le');
  } catch (err) {
    console.warn('[crypto] DPAPI unprotect failed:', err.message);
    return payload;
  }
}

// ===== Public API =====

const _decryptCache = new Map();

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
  encryptKey,
  decryptKey,
  clearDecryptCache,
  getCryptoBackend,
  // Test hooks
  _dpapiProbe: dpapiProbe,
  _dpapiProtect: dpapiProtect,
  _dpapiUnprotect: dpapiUnprotect,
  _encryptAes: encryptAes,
  _decryptAes: decryptAes,
};
