'use strict';

const { tianxiProgressTarget } = require('./tianxi-progress-presentation');
const { sanitizeTianxiErrorText } = require('./tianxi-error-message');

function dataProperty(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function resultText(value, depth = 0, literal = false) {
  if (depth > 4) return '';
  if (typeof value === 'string') {
    if (value.length > 32768) return '';
    const text = value.trim();
    if (literal) return text;
    if (/^[{["]/.test(text)) {
      try {
        const decoded = JSON.parse(text);
        return resultText(decoded, depth + 1, typeof decoded === 'string');
      } catch {
        return '';
      }
    }
    return text;
  }
  let array;
  try {
    array = Array.isArray(value);
  } catch {
    return '';
  }
  if (array) {
    const parts = [];
    for (let index = 0; index < 16; index++) {
      const text = resultText(dataProperty(value, String(index)), depth + 1);
      if (text) parts.push(text);
    }
    return parts.join('\n').slice(0, 8192);
  }
  for (const key of ['text', 'content', 'stdout', 'result', 'output', 'message', 'error']) {
    const text = resultText(
      dataProperty(value, key),
      depth + 1,
      ['text', 'content', 'stdout', 'message', 'error'].includes(key)
    );
    if (text) return text;
  }
  return '';
}

function fileListText(tool, value) {
  if (!['Glob', 'LS', 'List'].includes(tool)) return value;
  let text = value;
  // Some native list results contain a JSON-encoded string inside a text leaf.
  // Decode complete JSON strings only; never replace escape sequences in code.
  for (let depth = 0; depth < 2 && text.startsWith('"'); depth++) {
    try {
      const decoded = JSON.parse(text);
      if (typeof decoded !== 'string') break;
      text = decoded;
    } catch {
      break;
    }
  }
  return text
    .split('\n')
    .map((line) => {
      const candidate = line.trim();
      if (!/^[A-Za-z0-9_./\\:-]+$/.test(candidate)) return line;
      const target = tianxiProgressTarget('Read', { path: candidate });
      return target || '（敏感或外部路径已隐藏）';
    })
    .join('\n');
}

function sanitizePreview(value) {
  return sanitizeTianxiErrorText(value)
    .replace(
      /\b[A-Za-z][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)["']?\s*[:=]\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\s;}]+)/gi,
      '<redacted-assignment>'
    )
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      '<redacted-private-key>'
    )
    .replace(/\bsk[-_][A-Za-z0-9_-]+/g, '<redacted-key>')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, '<redacted-token>')
    .split('')
    .filter(
      (character) =>
        character === '\n' ||
        character === '\t' ||
        (character.charCodeAt(0) >= 32 &&
          character.charCodeAt(0) !== 127 &&
          !/[\u202a-\u202e\u2066-\u2069]/.test(character))
    )
    .join('');
}

function parseTianxiResultDetails(tool, value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid result details');
  const rawTarget = dataProperty(value, 'target');
  const target = tianxiProgressTarget(tool, { path: rawTarget });
  if (!target) return {};
  const rawPreview = dataProperty(value, 'preview');
  const safe = typeof rawPreview === 'string' ? sanitizePreview(rawPreview.slice(0, 8192)) : '';
  const lines = safe.split('\n').slice(0, 8).join('\n');
  const preview = Array.from(lines).slice(0, 512).join('');
  return {
    target,
    ...(preview
      ? {
          preview,
          truncated:
            dataProperty(value, 'truncated') === true ||
            preview.length < safe.length ||
            rawPreview.length > 8192,
        }
      : {}),
  };
}

function tianxiResultDetails(tool, target, result) {
  const text = target ? fileListText(tool, resultText(result)) : '';
  return parseTianxiResultDetails(tool, {
    target,
    preview: text,
    truncated: typeof result === 'string' && result.length > 8192,
  });
}

function formatTianxiResultDetails(tool, value) {
  const details = parseTianxiResultDetails(tool, value);
  if (!details.target) return '';
  const targetLabel = tool === 'Glob' ? '匹配模式' : '目标';
  return `\n${targetLabel}：${details.target}${details.preview ? `\n结果预览${details.truncated ? '（已截断）' : ''}：\n${details.preview}` : '\n未保留可展示的结果预览。'}`;
}

module.exports = { parseTianxiResultDetails, tianxiResultDetails, formatTianxiResultDetails };
