'use strict';

const { isToolResponseMessage } = require('./context-optimizer');

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

function compactContent(content, maxChars, query) {
  if (typeof content === 'string') {
    const compacted = compactText(content, maxChars, query);
    return { content: compacted, changed: compacted !== content };
  }
  if (!Array.isArray(content)) return { content, changed: false };
  let changed = false;
  const textParts = content.filter(
    (part) => part && typeof part === 'object' && typeof part.text === 'string'
  );
  const perPart = Math.max(256, Math.floor(maxChars / Math.max(1, textParts.length)));
  const compacted = content.map((part) => {
    if (!part || typeof part !== 'object' || typeof part.text !== 'string') return part;
    const text = compactText(part.text, perPart, query);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });
  return { content: changed ? compacted : content, changed };
}

function compactProtectedMessages(messages, options = {}) {
  if (!Array.isArray(messages)) {
    return { messages, changed: false, foldedCount: 0, originalBytes: 0, finalBytes: 0 };
  }
  const protectedMessages = messages.filter(
    (message) => message && ['system', 'developer'].includes(message.role)
  );
  const totalChars = Math.max(
    1024,
    Number(options.maxTotalChars) || DEFAULT_PROTECTED_CONTEXT_CHARS
  );
  const perMessage = Math.max(512, Math.floor(totalChars / Math.max(1, protectedMessages.length)));
  let foldedCount = 0;
  const compacted = messages.map((message) => {
    if (!message || !['system', 'developer'].includes(message.role)) return message;
    const result = compactContent(message.content, perMessage, options.query);
    if (!result.changed) return message;
    foldedCount += 1;
    return { ...message, content: result.content };
  });
  return {
    messages: foldedCount > 0 ? compacted : messages,
    changed: foldedCount > 0,
    foldedCount,
    originalBytes: protectedMessages.reduce((sum, message) => sum + jsonBytes(message), 0),
    finalBytes: compacted
      .filter((message) => message && ['system', 'developer'].includes(message.role))
      .reduce((sum, message) => sum + jsonBytes(message), 0),
  };
}

function messageSummary(message) {
  if (!message || typeof message !== 'object') return '';
  if (isToolResponseMessage(message)) {
    const name = typeof message.name === 'string' ? message.name : '';
    return `- Tool result${name ? ` (${name})` : ''} was processed and omitted from active context.`;
  }
  const calls = Array.isArray(message.tool_calls)
    ? message.tool_calls
        .map((call) => call && call.function && call.function.name)
        .filter(Boolean)
        .slice(0, 8)
    : [];
  const text = contentText(message.content).replace(/\s+/g, ' ').trim().slice(0, 320);
  const role = typeof message.role === 'string' ? message.role : 'unknown';
  if (calls.length > 0) return `- ${role}: invoked ${calls.join(', ')}.${text ? ` ${text}` : ''}`;
  return text ? `- ${role}: ${text}` : '';
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
  const lines = messages
    .slice(0, cutoff)
    .filter((message) => message && !['system', 'developer'].includes(message.role))
    .map(messageSummary)
    .filter(Boolean);
  if (lines.length === 0) return null;
  const header =
    '[Continuation summary of earlier conversation; original tool outputs can be reread if needed]\n';
  return {
    role: 'system',
    content: (header + lines.join('\n')).slice(0, maxChars),
  };
}

module.exports = {
  DEFAULT_CONTINUATION_SUMMARY_CHARS,
  DEFAULT_PROTECTED_CONTEXT_CHARS,
  buildHistoricalContinuation,
  compactProtectedMessages,
  compactText,
  contentText,
};
