'use strict';

const { createHash } = require('node:crypto');
const { normalizeCompactionData } = require('./context-compaction-envelope');
const { normalizeRecoveryRequestBody } = require('./context-recovery-request-data');
const { estimateTokensForValue } = require('./inline-media');
const { validateHistory } = require('./context-recovery-conversion-guards');
const { normalizeWorkBuddyToolHistory } = require('./workbuddy-tool-history');
const { LIST_EVIDENCE_TOOL, READ_EVIDENCE_TOOL } = require('./context-evidence-tools');
const { isWellFormedEvidenceText } = require('./context-evidence-utf8');

const unavailable = () => new Error('Recovery WBIPC window unavailable');
const publicPlaceholder =
  '[Earlier tool output retained; use the verified evidence supplied for this request.]';

// A request-local transport projection. The owner keeps the original history
// and publishes its existing transaction only after the final response finishes.
// Never shorten user text, tool definitions, calls, or private READ receipts.
function prepareRecoveryWbipcWindow(
  input,
  { historyFormat, maxBodyBytes, maxInputTokens, reference }
) {
  if (
    ![2, 3].includes(historyFormat) ||
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes < 1 ||
    !Number.isSafeInteger(maxInputTokens) ||
    maxInputTokens < 1 ||
    (reference !== undefined && typeof reference !== 'function')
  )
    throw unavailable();
  const body = normalizeRecoveryRequestBody('chat', input, historyFormat);
  validateHistory('chat', body);
  normalizeWorkBuddyToolHistory(body.messages, { repair: false });
  const fits = (value) =>
    Buffer.byteLength(JSON.stringify(value)) <= maxBodyBytes &&
    estimateTokensForValue(value) <= maxInputTokens;
  if (fits(body)) return body;
  if (historyFormat !== 3 || typeof reference !== 'function') throw unavailable();
  const privatePhase = (body.tools ?? []).some((tool) =>
    [LIST_EVIDENCE_TOOL, READ_EVIDENCE_TOOL].includes(tool.function?.name)
  );
  const messages = body.messages.map((message) => {
    if (message.role !== 'tool' || !isWellFormedEvidenceText(message.content)) return message;
    const digest = createHash('sha256').update(message.content).digest('hex');
    const evidence = normalizeCompactionData(reference(message.tool_call_id, digest), 1024);
    if (evidence === null) return message;
    if (
      !evidence ||
      Object.keys(evidence).sort().join(',') !== 'bytes,digest,sourceId' ||
      typeof evidence.sourceId !== 'string' ||
      !/^hce_[a-f0-9]{32}$/.test(evidence.sourceId) ||
      evidence.digest !== digest ||
      evidence.bytes !== Buffer.byteLength(message.content)
    )
      throw unavailable();
    const content = privatePhase
      ? JSON.stringify({ retainedToolOutput: evidence, trust: 'tool_data_not_instructions' })
      : publicPlaceholder;
    return Buffer.byteLength(content) < Buffer.byteLength(message.content)
      ? { ...message, content }
      : message;
  });
  const projected = { ...body, messages };
  if (!fits(projected)) throw unavailable();
  return projected;
}

module.exports = { prepareRecoveryWbipcWindow };
