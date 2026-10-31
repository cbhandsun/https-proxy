'use strict';

const crypto = require('crypto');

const STRUCTURAL_KEYS = new Set([
  'model',
  'role',
  'type',
  'id',
  'tool_use_id',
  'tool_call_id',
  'call_id',
  'name',
  'stop_reason',
  'finish_reason',
  'object',
  'status',
  'encoding_format',
]);

const IGNORED_SECRETS = new Set(['PROXY_MANAGED', 'sk-proxy-managed']);

const SECRET_PATTERNS = [
  {
    name: 'pem_private_key',
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    name: 'connection_uri',
    regex:
      /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s"'<>:@]+:[^\s"'<>@]+@[^\s"'<>]+/gi,
  },
  {
    name: 'anthropic_or_openai_key',
    regex: /\bsk-(?:ant-[A-Za-z0-9_-]{16,}|proj-[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{20,})\b/g,
  },
  {
    name: 'github_token',
    regex: /\b(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
  },
  {
    name: 'google_api_key',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    name: 'aws_access_key',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    name: 'slack_token',
    regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
  },
  {
    name: 'gitlab_pat',
    regex: /\bglpat-[0-9A-Za-z_-]{20,}\b/g,
  },
  {
    name: 'huggingface_token',
    regex: /\bhf_[A-Za-z0-9]{24,}\b/g,
  },
];

const ENV_ASSIGNMENT_REGEX =
  /\b((?:[A-Z0-9_]*_)?(?:API_KEY|SECRET_KEY|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY|CLIENT_SECRET|DB_PASSWORD|PASSWORD)\s*[:=]\s*["']?)([^\s"',;}{]{8,})(["']?)/gi;

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PRIVATE_IPV4_REGEX =
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})\b/g;

const PLACEHOLDER_GLOBAL_REGEX = /__HPM_MASK_\d+_[a-f0-9]{6}__/g;
function findTrailingPartialMaskLength(text) {
  const maxLen = Math.min(31, text.length);
  const prefix = '__HPM_MASK_';
  for (let len = maxLen; len >= 1; len -= 1) {
    const tail = text.slice(text.length - len);
    if (tail[0] !== '_') continue;
    if (len <= prefix.length) {
      if (prefix.startsWith(tail)) return len;
    } else if (
      /^__HPM_MASK_\d*(?:_[a-f0-9]{0,6}_?)?$/.test(tail) &&
      !/^__HPM_MASK_\d+_[a-f0-9]{6}__$/.test(tail)
    ) {
      return len;
    }
  }
  return 0;
}

function parseCustomKeywords(raw) {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\r\n]+/) : [];
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const trimmed = String(item || '').trim();
    if (trimmed.length < 3 || trimmed.length > 256) continue;
    if (IGNORED_SECRETS.has(trimmed) || /^__HPM_MASK_/.test(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= 64) break;
  }
  result.sort((a, b) => b.length - a.length);
  return result;
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolvePromptMaskingOptions(profile, config) {
  const customKeywords = parseCustomKeywords(
    (profile && profile.promptMaskingKeywords) ||
      (profile && profile.promptMasking && profile.promptMasking.keywords) ||
      (config && config.promptMasking && config.promptMasking.keywords) ||
      (config && config.appSettings && config.appSettings.promptMaskingKeywords)
  );
  const candidates = [
    profile && profile.promptMasking,
    config && config.promptMasking,
    config && config.appSettings && config.appSettings.promptMasking,
    config && config.appSettings && config.appSettings.promptMaskingEnabled,
  ];
  for (const raw of candidates) {
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'boolean') {
      return {
        enabled: raw,
        maskEmails: false,
        maskPrivateIps: false,
        customKeywords,
      };
    }
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      return {
        enabled: raw.enabled === true,
        maskEmails: raw.maskEmails === true,
        maskPrivateIps: raw.maskPrivateIps === true,
        customKeywords,
      };
    }
  }
  return {
    enabled: false,
    maskEmails: false,
    maskPrivateIps: false,
    customKeywords,
  };
}

function createPromptMaskState(options = {}) {
  const salt =
    typeof options.salt === 'string' && /^[a-f0-9]{6}$/.test(options.salt)
      ? options.salt
      : crypto.randomBytes(3).toString('hex');
  return {
    salt,
    count: 0,
    secretToToken: new Map(),
    tokenToSecret: new Map(),
  };
}

function registerMaskedSecret(rawSecret, state) {
  const secret = String(rawSecret || '');
  if (!secret || IGNORED_SECRETS.has(secret) || /^__HPM_MASK_\d+_[a-f0-9]{6}__$/.test(secret)) {
    return secret;
  }
  if (state.secretToToken.has(secret)) {
    return state.secretToToken.get(secret);
  }
  state.count += 1;
  const token = `__HPM_MASK_${state.count}_${state.salt}__`;
  state.secretToToken.set(secret, token);
  state.tokenToSecret.set(token, secret);
  return token;
}

function maskPromptText(text, state, options = {}) {
  if (typeof text !== 'string' || !text) return text;
  let output = text;

  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern.regex, (matched) => registerMaskedSecret(matched, state));
  }

  output = output.replace(ENV_ASSIGNMENT_REGEX, (full, prefix, secretValue, suffix) => {
    if (!secretValue || /^__HPM_MASK_\d+_[a-f0-9]{6}__$/.test(secretValue)) return full;
    if (/^(?:true|false|null|undefined|localhost|none|your[_-])/i.test(secretValue)) return full;
    return `${prefix}${registerMaskedSecret(secretValue, state)}${suffix}`;
  });

  if (options.maskEmails === true) {
    output = output.replace(EMAIL_REGEX, (matched) => registerMaskedSecret(matched, state));
  }

  if (options.maskPrivateIps === true) {
    output = output.replace(PRIVATE_IPV4_REGEX, (matched) => {
      if (matched === '127.0.0.1') return matched;
      return registerMaskedSecret(matched, state);
    });
  }

  const customKeywords = parseCustomKeywords(options.customKeywords);
  if (customKeywords.length > 0) {
    const keywordAlternation = customKeywords.map(escapeRegExp).join('|');
    const customRegex = new RegExp(`(__HPM_MASK_\\d+_[a-f0-9]{6}__)|(${keywordAlternation})`, 'g');
    output = output.replace(customRegex, (full, existingToken, keywordMatch) => {
      if (existingToken) return existingToken;
      return registerMaskedSecret(keywordMatch, state);
    });
  }

  return output;
}

function maskJsonPayloadValue(value, state, options = {}, keyName = '') {
  if (typeof value === 'string') {
    if (keyName && STRUCTURAL_KEYS.has(keyName)) return value;
    return maskPromptText(value, state, options);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const masked = maskJsonPayloadValue(item, state, options, '');
      if (masked !== item) changed = true;
      return masked;
    });
    return changed ? next : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next = {};
    for (const [k, v] of Object.entries(value)) {
      const masked = maskJsonPayloadValue(v, state, options, k);
      if (masked !== v) changed = true;
      next[k] = masked;
    }
    return changed ? next : value;
  }
  return value;
}

function unmaskText(text, tokenToSecret, options = {}) {
  if (typeof text !== 'string' || !text || !tokenToSecret || tokenToSecret.size === 0) {
    return text;
  }
  if (!text.includes('__HPM_MASK_')) return text;
  const jsonSafe = options.jsonSafe === true;
  return text.replace(PLACEHOLDER_GLOBAL_REGEX, (token) => {
    if (!tokenToSecret.has(token)) return token;
    const secret = tokenToSecret.get(token);
    if (!jsonSafe) return secret;
    return JSON.stringify(secret).slice(1, -1);
  });
}

function createStreamingUnmasker(tokenToSecret, options = {}) {
  let pending = '';
  const jsonSafe = options.jsonSafe !== false;

  function push(chunk) {
    if (chunk == null || !tokenToSecret || tokenToSecret.size === 0) {
      return typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
    }
    const text =
      typeof chunk === 'string'
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString('utf8')
          : String(chunk);
    const combined = pending + text;
    pending = '';

    const holdLen = findTrailingPartialMaskLength(combined);
    let readyPart = combined;
    if (holdLen > 0) {
      pending = combined.slice(combined.length - holdLen);
      readyPart = combined.slice(0, combined.length - holdLen);
    }
    return unmaskText(readyPart, tokenToSecret, { jsonSafe });
  }

  function flush() {
    if (!pending) return '';
    const tail = pending;
    pending = '';
    return unmaskText(tail, tokenToSecret, { jsonSafe });
  }

  return {
    push,
    flush,
  };
}

function stripContentLengthFromHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  const next = { ...headers };
  for (const key of Object.keys(next)) {
    if (key.toLowerCase() === 'content-length') {
      delete next[key];
    }
  }
  return next;
}

function installResponseUnmasking(clientRes, maskState) {
  if (
    !clientRes ||
    !maskState ||
    !maskState.tokenToSecret ||
    maskState.tokenToSecret.size === 0 ||
    clientRes.__hpmPromptUnmaskInstalled
  ) {
    return false;
  }
  clientRes.__hpmPromptUnmaskInstalled = true;
  const unmasker = createStreamingUnmasker(maskState.tokenToSecret, { jsonSafe: true });

  const origWriteHead = clientRes.writeHead;
  if (typeof origWriteHead === 'function') {
    clientRes.writeHead = function (statusCode, statusMessage, headers) {
      try {
        if (typeof clientRes.removeHeader === 'function') {
          clientRes.removeHeader('Content-Length');
          clientRes.removeHeader('content-length');
        }
      } catch (_err) {}
      if (typeof statusMessage === 'object' && statusMessage !== null) {
        return origWriteHead.call(this, statusCode, stripContentLengthFromHeaders(statusMessage));
      }
      if (typeof headers === 'object' && headers !== null) {
        return origWriteHead.call(
          this,
          statusCode,
          statusMessage,
          stripContentLengthFromHeaders(headers)
        );
      }
      return origWriteHead.apply(this, arguments);
    };
  }

  const origWrite = clientRes.write;
  clientRes.write = function (chunk, encoding, callback) {
    if (chunk != null && (typeof chunk === 'string' || Buffer.isBuffer(chunk))) {
      const restored = unmasker.push(chunk);
      if (!restored) {
        if (typeof encoding === 'function') encoding();
        else if (typeof callback === 'function') callback();
        return true;
      }
      const outChunk = Buffer.isBuffer(chunk) ? Buffer.from(restored, 'utf8') : restored;
      return origWrite.call(this, outChunk, encoding, callback);
    }
    return origWrite.apply(this, arguments);
  };

  const origEnd = clientRes.end;
  clientRes.end = function (chunk, encoding, callback) {
    if (typeof chunk === 'function') {
      const tail = unmasker.flush();
      if (tail) origWrite.call(this, Buffer.from(tail, 'utf8'));
      return origEnd.call(this, chunk);
    }
    if (chunk != null && (typeof chunk === 'string' || Buffer.isBuffer(chunk))) {
      const restored = unmasker.push(chunk) + unmasker.flush();
      const outChunk = Buffer.isBuffer(chunk) ? Buffer.from(restored, 'utf8') : restored;
      return origEnd.call(this, outChunk, encoding, callback);
    }
    const tail = unmasker.flush();
    if (tail) origWrite.call(this, Buffer.from(tail, 'utf8'));
    return origEnd.apply(this, arguments);
  };

  return true;
}

function applyBidirectionalPromptMasking(clientRes, prepared, config) {
  if (!prepared || typeof prepared !== 'object') return { masked: false, maskedCount: 0 };
  const options = resolvePromptMaskingOptions(prepared.profile, config);
  if (!options.enabled) return { masked: false, maskedCount: 0 };

  const sourceBuffer = Buffer.isBuffer(prepared.decompressedBuffer)
    ? prepared.decompressedBuffer
    : Buffer.isBuffer(prepared.buffer)
      ? prepared.buffer
      : null;
  if (!sourceBuffer || sourceBuffer.length === 0) {
    return { masked: false, maskedCount: 0 };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(sourceBuffer.toString('utf8'));
  } catch (_err) {
    return { masked: false, maskedCount: 0 };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { masked: false, maskedCount: 0 };
  }

  const state = createPromptMaskState();
  const maskedPayload = maskJsonPayloadValue(parsed, state, options);
  if (state.count === 0) {
    return { masked: false, maskedCount: 0 };
  }

  const nextBuffer = Buffer.from(JSON.stringify(maskedPayload), 'utf8');
  prepared.buffer = nextBuffer;
  prepared.decompressedBuffer = nextBuffer;
  prepared.decompressed = true;
  prepared.bodyChanged = true;
  prepared.promptMaskState = state;
  prepared.promptMaskedCount = state.count;

  if (clientRes) {
    installResponseUnmasking(clientRes, state);
  }

  return {
    masked: true,
    maskedCount: state.count,
    state,
  };
}

module.exports = {
  resolvePromptMaskingOptions,
  createPromptMaskState,
  maskPromptText,
  maskJsonPayloadValue,
  unmaskText,
  createStreamingUnmasker,
  installResponseUnmasking,
  applyBidirectionalPromptMasking,
};
