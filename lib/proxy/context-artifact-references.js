'use strict';

const {
  EVIDENCE_MARKER,
  checkpointPayload,
  validateCheckpointMessages,
} = require('./context-checkpoint');

const MAX_REFERENCE_COUNT = 4096;

// Only recognized receipt fields are references. A locator mentioned in user
// text or arbitrary tool data must not keep an unused staged artifact alive.
function collectContextArtifactReferences(messages, scope) {
  const references = new Map();
  function add(receipt) {
    if (
      references.size >= MAX_REFERENCE_COUNT ||
      !receipt ||
      typeof receipt !== 'object' ||
      Array.isArray(receipt) ||
      receipt.kind !== 'historical_tool_evidence' ||
      receipt.scope !== scope ||
      typeof receipt.locator !== 'string' ||
      !/^hca_[a-f0-9]{32}$/.test(receipt.locator) ||
      typeof receipt.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(receipt.digest)
    )
      return;
    const key = `${receipt.locator}:${receipt.digest}`;
    references.set(key, { locator: receipt.locator, digest: receipt.digest, scope });
  }
  function fromText(text, callId) {
    if (typeof text !== 'string' || text.length > 4096 || !text.startsWith(`${EVIDENCE_MARKER} `))
      return;
    try {
      const receipt = JSON.parse(text.slice(EVIDENCE_MARKER.length + 1));
      if (typeof callId === 'string' && receipt?.callId === callId) add(receipt);
    } catch (_error) {
      // Invalid markers are ordinary data, never references.
    }
  }
  if (!Array.isArray(messages) || typeof scope !== 'string') return [];
  for (const message of messages) {
    if (references.size >= MAX_REFERENCE_COUNT) break;
    if (!message || typeof message !== 'object') continue;
    if (typeof message.content === 'string' && message.content.length <= 64 * 1024) {
      const checkpoint = checkpointPayload(message);
      if (
        checkpoint &&
        message.role === 'assistant' &&
        validateCheckpointMessages([message], 64 * 1024)
      ) {
        for (const receipt of (checkpoint.evidenceReceipts || []).slice(0, 32)) add(receipt);
        for (const entry of checkpoint.entries.slice(0, 32)) add(entry?.callReceipt);
      } else if (message.role === 'tool') fromText(message.content, message.tool_call_id);
    }
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content.slice(0, 1024)) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'tool_result') fromText(part.content, part.tool_use_id);
      if (message.role === 'tool') fromText(part.text, message.tool_call_id);
    }
  }
  return [...references.values()];
}

module.exports = { collectContextArtifactReferences };
