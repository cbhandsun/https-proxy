'use strict';

const { isToolResponseMessage } = require('./context-optimizer');
const { buildRolePreservingCheckpoint } = require('./context-checkpoint');

const DEFAULT_PROTECTED_CONTEXT_CHARS = 256 * 1024;
const DEFAULT_CONTINUATION_SUMMARY_CHARS = 6000;
const PRIORITY_RE =
  /\b(must|never|required|important|security|safety|constraint|goal|request|instruction|do not)\b|必须|禁止|重要|安全|约束|目标|请求|指令/gi;

function jsonBytes(value) {
  const serialized = JSON.stringify(value);
  return typeof serialized === 'string' ? Buffer.byteLength(serialized) : 0;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (part.type === 'tool_result') return contentText(part.content);
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function compactText(text, maxChars, query = '') {
  if (typeof text !== 'string' || text.length <= maxChars) return text;
  const safeLimit = Math.max(256, Math.floor(maxChars));
  const notice = '\n\n[Earlier protected context was extractively compacted here.]\n\n';
  const headBudget = Math.floor(safeLimit * 0.3);
  const tailBudget = Math.floor(safeLimit * 0.25);
  const middleBudget = Math.max(0, safeLimit - headBudget - tailBudget - notice.length * 2);
  const head = text.slice(0, headBudget);
  const tail = text.slice(-tailBudget);
  const queryTerms = new Set(
    (
      String(query || '')
        .toLowerCase()
        .match(/[a-z0-9_]{3,}|[\u3400-\u9fff]{2,8}/g) || []
    ).slice(0, 64)
  );
  const paragraphs = text
    .slice(headBudget, text.length - tailBudget)
    .split(/\n{2,}/)
    .map((value, index) => {
      const normalized = value.toLowerCase();
      PRIORITY_RE.lastIndex = 0;
      const priorityMatches = value.match(PRIORITY_RE) || [];
      let score = priorityMatches.length * 20;
      for (const term of queryTerms) if (normalized.includes(term)) score += 5;
      if (/^\s{0,3}(?:#{1,6}|<instructions>|<system>|<constraints>)/i.test(value)) score += 10;
      return { value: value.trim(), index, score };
    })
    .filter((entry) => entry.value);
  const selected = [];
  let used = 0;
  const seen = new Set();
  for (const entry of [...paragraphs].sort(
    (left, right) => right.score - left.score || left.index - right.index
  )) {
    const fingerprint = entry.value.replace(/\s+/g, ' ').slice(0, 500);
    if (seen.has(fingerprint)) continue;
    const remaining = middleBudget - used;
    if (remaining <= 0) break;
    const value = entry.value.slice(0, remaining);
    selected.push({ ...entry, value });
    seen.add(fingerprint);
    used += value.length + 2;
  }
  const middle = selected
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.value)
    .join('\n\n');
  return (head + notice + middle + notice + tail).slice(0, safeLimit);
}

function compactProtectedMessages(messages) {
  if (!Array.isArray(messages)) {
    return { messages, changed: false, foldedCount: 0, originalBytes: 0, finalBytes: 0 };
  }
  const protectedMessages = messages.filter(
    (message) => message && ['system', 'developer'].includes(message.role)
  );
  const protectedBytes = protectedMessages.reduce((sum, message) => sum + jsonBytes(message), 0);
  return {
    messages,
    changed: false,
    foldedCount: 0,
    originalBytes: protectedBytes,
    finalBytes: protectedBytes,
  };
}

function buildHistoricalContinuation(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const keepRecentUserTurns = Math.max(1, Number(options.keepRecentUserTurns) || 2);
  const maxChars = Math.max(512, Number(options.maxChars) || DEFAULT_CONTINUATION_SUMMARY_CHARS);
  let userTurns = 0;
  let cutoff = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === 'user' && !isToolResponseMessage(message)) {
      userTurns += 1;
      if (userTurns >= keepRecentUserTurns) {
        cutoff = index;
        break;
      }
    }
  }
  return buildRolePreservingCheckpoint(messages.slice(0, cutoff), {
    maxChars,
    maxEntries: options.maxEntries,
  });
}

module.exports = {
  DEFAULT_CONTINUATION_SUMMARY_CHARS,
  DEFAULT_PROTECTED_CONTEXT_CHARS,
  buildHistoricalContinuation,
  compactProtectedMessages,
  compactText,
  contentText,
};
