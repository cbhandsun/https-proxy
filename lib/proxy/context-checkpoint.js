'use strict';

const { createHash } = require('node:crypto');
const { isToolResponseMessage } = require('./context-optimizer');

const CHECKPOINT_MARKER = '[HPM_CONTEXT_CHECKPOINT_V1]';
const EVIDENCE_MARKER = '[HPM_EVIDENCE_RECEIPT_V1]';
const DEFAULT_CHECKPOINT_CHARS = 6000;
const DEFAULT_CHECKPOINT_ENTRIES = 8;
const MAX_DIGEST_INPUT_CHARS = 1024 * 1024;
const CHECKPOINT_SCHEMA = 'hpm.context.checkpoint';
const storedReceipts = new WeakSet();

function boundedInteger(value, fallback, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(maximum, Math.floor(numeric));
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function safeSerializedContent(content) {
  if (typeof content === 'string') return content.slice(0, MAX_DIGEST_INPUT_CHARS);
  try {
    const serialized = JSON.stringify(content);
    return typeof serialized === 'string' ? serialized.slice(0, MAX_DIGEST_INPUT_CHARS) : '';
  } catch (_error) {
    return '[unserializable]';
  }
}

function createEvidenceReceipt(message, options = {}) {
  // Completed rounds may be archived again after an earlier result-only fold.
  // Its receipt is a reference to the original evidence, not the evidence text.
  // Never store that reference as a new artifact and silently redirect recovery
  // to the receipt JSON. Actual read authorization/integrity remains in the store.
  if (
    message?.role === 'tool' &&
    typeof message.content === 'string' &&
    message.content.startsWith(`${EVIDENCE_MARKER} `) &&
    message.content.length <= 4096
  ) {
    try {
      const receipt = boundedReceipt(JSON.parse(message.content.slice(EVIDENCE_MARKER.length + 1)));
      if (
        receipt &&
        typeof message.tool_call_id === 'string' &&
        receipt.callId === message.tool_call_id
      ) {
        return receipt;
      }
    } catch (_error) {
      // A malformed/unbound marker is ordinary untrusted tool content.
    }
  }
  const serialized = safeSerializedContent(message?.content);
  const callId =
    typeof message?.tool_call_id === 'string' ? message.tool_call_id.slice(0, 128) : undefined;
  const name = typeof message?.name === 'string' ? message.name.slice(0, 128) : undefined;
  const stored =
    options.artifactStore &&
    typeof options.artifactStore.put === 'function' &&
    typeof options.artifactOwner === 'string' &&
    typeof options.artifactScope === 'string'
      ? options.artifactStore.put(options.artifactOwner, options.artifactScope, message?.content)
      : null;
  const receipt = {
    kind: 'historical_tool_evidence',
    ...(callId ? { callId } : {}),
    ...(name ? { name } : {}),
    bytes: Buffer.byteLength(serialized),
    digest: stored?.digest || createHash('sha256').update(serialized).digest('hex').slice(0, 24),
    ...(stored ? { locator: stored.locator, scope: options.artifactScope } : {}),
    recovery: stored ? 'read_context_artifact' : 'rerun_or_reread_original_tool',
  };
  if (stored) storedReceipts.add(receipt);
  return receipt;
}

function evidenceReceiptWasStored(receipt) {
  return storedReceipts.has(receipt);
}

function assistantEntry(message, maxChars, receiptFactory) {
  const toolNames = [
    ...(Array.isArray(message?.tool_calls) ? message.tool_calls : []).map(
      (call) => call?.function?.name
    ),
    ...(Array.isArray(message?.content) ? message.content : []).map((part) =>
      part?.type === 'tool_use' ? part.name : part?.functionCall?.name
    ),
  ]
    .filter((name) => typeof name === 'string' && name)
    .slice(0, 8)
    .map((name) => name.slice(0, 128));
  const text = contentText(message?.content).replace(/\s+/g, ' ').trim().slice(0, maxChars);
  if (!text && toolNames.length === 0) return null;
  return {
    ...(text ? { text } : {}),
    ...(toolNames.length > 0 ? { invokedTools: toolNames } : {}),
    ...(toolNames.length > 0 && typeof receiptFactory === 'function'
      ? {
          callReceipt: receiptFactory(
            {
              role: 'tool',
              name: 'completed_tool_call',
              content: message,
            },
            message
          ),
        }
      : {}),
  };
}

function buildCheckpointMessage(role, payload, maxChars) {
  const entries = Array.isArray(payload.entries) ? [...payload.entries] : [];
  const evidenceReceipts = Array.isArray(payload.evidenceReceipts)
    ? [...payload.evidenceReceipts]
    : undefined;
  while (true) {
    if (entries.length === 0 && (!evidenceReceipts || evidenceReceipts.length === 0)) return null;
    const boundedPayload = {
      schema: CHECKPOINT_SCHEMA,
      version: 1,
      sourceRole: role,
      entries,
      ...(evidenceReceipts ? { evidenceReceipts } : {}),
    };
    const content = `${CHECKPOINT_MARKER}\n${JSON.stringify(boundedPayload)}`;
    if (content.length <= maxChars) return { role, content };
    if (evidenceReceipts && evidenceReceipts.length > 0) {
      evidenceReceipts.pop();
      continue;
    }
    if (entries.length > 0) {
      entries.pop();
      continue;
    }
    return null;
  }
}

function checkpointPayload(message) {
  if (!message || typeof message.content !== 'string') return null;
  if (!message.content.startsWith(`${CHECKPOINT_MARKER}\n`)) return null;
  try {
    const payload = JSON.parse(message.content.slice(CHECKPOINT_MARKER.length + 1));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    return payload;
  } catch (_error) {
    return null;
  }
}

function boundedReceipt(receipt) {
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt) ||
    receipt.kind !== 'historical_tool_evidence' ||
    !Number.isSafeInteger(receipt.bytes) ||
    receipt.bytes < 0 ||
    typeof receipt.digest !== 'string' ||
    !/^[a-f0-9]{24,64}$/.test(receipt.digest)
  )
    return null;
  const recoverable =
    typeof receipt.locator === 'string' &&
    /^hca_[a-f0-9]{32}$/.test(receipt.locator) &&
    typeof receipt.scope === 'string' &&
    receipt.scope.length > 0 &&
    receipt.scope.length <= 256;
  return {
    kind: 'historical_tool_evidence',
    bytes: receipt.bytes,
    digest: receipt.digest,
    ...(typeof receipt.callId === 'string' ? { callId: receipt.callId.slice(0, 128) } : {}),
    ...(typeof receipt.name === 'string' ? { name: receipt.name.slice(0, 128) } : {}),
    ...(recoverable ? { locator: receipt.locator, scope: receipt.scope } : {}),
    recovery: recoverable ? 'read_context_artifact' : 'rerun_or_reread_original_tool',
  };
}

function validateCheckpointMessages(messages, maxChars = DEFAULT_CHECKPOINT_CHARS) {
  if (!Array.isArray(messages)) return false;
  return messages.every((message) => {
    const payload = checkpointPayload(message);
    return !!(
      payload &&
      ['user', 'assistant'].includes(message.role) &&
      message.content.length <= maxChars &&
      payload.schema === CHECKPOINT_SCHEMA &&
      payload.version === 1 &&
      payload.sourceRole === message.role &&
      Array.isArray(payload.entries) &&
      (!Object.hasOwn(payload, 'evidenceReceipts') || Array.isArray(payload.evidenceReceipts))
    );
  });
}

function buildRolePreservingCheckpoint(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const maxChars = boundedInteger(options.maxChars, DEFAULT_CHECKPOINT_CHARS, 64 * 1024);
  const maxEntries = boundedInteger(
    options.maxEntries,
    DEFAULT_CHECKPOINT_ENTRIES,
    DEFAULT_CHECKPOINT_ENTRIES * 4
  );
  const entryChars = Math.max(128, Math.floor(maxChars / Math.max(2, maxEntries)));
  const userEntries = [];
  const assistantEntries = [];
  const evidenceReceipts = [];
  for (const message of [...messages].reverse()) {
    if (!message || ['system', 'developer'].includes(message.role)) continue;
    const previous = checkpointPayload(message);
    if (previous && validateCheckpointMessages([message], 64 * 1024)) {
      const entries = message.role === 'user' ? userEntries : assistantEntries;
      for (const entry of previous.entries) {
        if (entries.length >= maxEntries) break;
        // Parse only known fields, with bounded strings and no prototype merging.
        if (!entry || typeof entry !== 'object') continue;
        const text = typeof entry.text === 'string' ? entry.text.slice(0, entryChars) : '';
        const invokedTools =
          message.role === 'assistant' && Array.isArray(entry.invokedTools)
            ? entry.invokedTools
                .filter((name) => typeof name === 'string')
                .slice(0, 8)
                .map((name) => name.slice(0, 128))
            : [];
        const callReceipt = message.role === 'assistant' ? boundedReceipt(entry.callReceipt) : null;
        if (text || invokedTools.length)
          entries.push({
            ...(text ? { text } : {}),
            ...(invokedTools.length ? { invokedTools } : {}),
            ...(callReceipt ? { callReceipt } : {}),
          });
      }
      for (const receipt of previous.evidenceReceipts || []) {
        if (evidenceReceipts.length >= maxEntries) break;
        const bounded = message.role === 'assistant' ? boundedReceipt(receipt) : null;
        if (bounded) evidenceReceipts.push(bounded);
      }
      continue;
    }
    if (isToolResponseMessage(message)) {
      if (evidenceReceipts.length < maxEntries) {
        evidenceReceipts.push(
          typeof options.receiptFactory === 'function'
            ? options.receiptFactory(message)
            : createEvidenceReceipt(message, options)
        );
      }
      continue;
    }
    if (message.role === 'user' && userEntries.length < maxEntries) {
      const text = contentText(message.content).replace(/\s+/g, ' ').trim().slice(0, entryChars);
      if (text) userEntries.push({ text });
      continue;
    }
    if (message.role === 'assistant' && assistantEntries.length < maxEntries) {
      const entry = assistantEntry(message, entryChars, options.receiptFactory);
      if (entry) assistantEntries.push(entry);
    }
  }
  const checkpoints = [];
  const checkpointCount =
    Number(userEntries.length > 0) +
    Number(assistantEntries.length > 0 || evidenceReceipts.length > 0);
  const perMessageChars = Math.max(1, Math.floor(maxChars / Math.max(1, checkpointCount)));
  if (userEntries.length > 0) {
    const checkpoint = buildCheckpointMessage('user', { entries: userEntries }, perMessageChars);
    if (checkpoint) checkpoints.push(checkpoint);
  }
  if (assistantEntries.length > 0 || evidenceReceipts.length > 0) {
    const checkpoint = buildCheckpointMessage(
      'assistant',
      { entries: assistantEntries, evidenceReceipts },
      perMessageChars
    );
    if (checkpoint) checkpoints.push(checkpoint);
  }
  return checkpoints.length > 0 && validateCheckpointMessages(checkpoints, perMessageChars)
    ? checkpoints
    : null;
}

module.exports = {
  CHECKPOINT_MARKER,
  CHECKPOINT_SCHEMA,
  DEFAULT_CHECKPOINT_CHARS,
  EVIDENCE_MARKER,
  buildRolePreservingCheckpoint,
  checkpointPayload,
  createEvidenceReceipt,
  evidenceReceiptWasStored,
  validateCheckpointMessages,
};
