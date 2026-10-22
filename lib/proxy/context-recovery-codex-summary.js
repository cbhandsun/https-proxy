'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { normalizeCompactionData } = require('./context-compaction-envelope');
const { normalizeRecoveryRequestBody } = require('./context-recovery-request-data');
const { codexToolInventory } = require('./context-recovery-codex-tools');

const MAX_BYTES = 2 * 1024 * 1024;
const PREFIX = '<!-- hpm-codex-summary:';
const RECEIPT = /^hcr1_[a-f0-9]{48}_[a-f0-9]{64}_[1-9][0-9]{0,6}$/;
const hash = (text) => createHash('sha256').update(text).digest('hex');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function opaqueSummaryMetadata(value) {
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, child]) =>
      ['signature', 'encrypted_content', 'redacted_thinking'].includes(key) ||
      opaqueSummaryMetadata(child)
  );
}

// Classification only grants access to the existing observed-compaction index.
// An exact, unique ancestor under principal/target/instructions/system is still
// mandatory. Ordinary generation never ignores its tool policy.
function isCodexSummaryRequest(input, historyFormat = 2) {
  try {
    const body = normalizeRecoveryRequestBody('responses', input, historyFormat);
    const last = Array.isArray(body?.input) ? body.input.at(-1) : null;
    const inventory = codexToolInventory(body.input);
    return Boolean(
      record(body) &&
      Array.isArray(body.input) &&
      (body.tools === undefined || (Array.isArray(body.tools) && body.tools.length === 0)) &&
      (!inventory || inventory.tools.length === 0) &&
      body.tool_choice === 'auto' &&
      body.previous_response_id === undefined &&
      last?.role === 'user' &&
      Array.isArray(last.content) &&
      last.content.length === 1 &&
      last.content[0]?.type === 'input_text' &&
      typeof last.content[0].text === 'string' &&
      last.content[0].text.includes('CONTEXT CHECKPOINT COMPACTION') &&
      last.content[0].text.includes('handoff summary')
    );
  } catch {
    return false;
  }
}

function isCodexSummaryReceipt(value) {
  return typeof value === 'string' && RECEIPT.test(value);
}

// Native local summaries are echoed as user input, after the initial client
// instructions. Once assistant/tool history exists, its observed frontier wins
// over any older receipt. The receipt is never a standalone root selector.
function parseCodexSummaryReceipt(input, historyFormat = 2) {
  try {
    const history = normalizeRecoveryRequestBody('responses', { input }, historyFormat).input;
    if (
      !Array.isArray(history) ||
      !history.every((item) => record(item) && ['user', 'developer', 'system'].includes(item.role))
    )
      return null;
    let found = null;
    for (const item of history) {
      if (item.role !== 'user' || !Array.isArray(item.content)) continue;
      for (const block of item.content) {
        if (block?.type !== 'input_text' || typeof block.text !== 'string') continue;
        const text = block.text;
        const offset = text.indexOf(PREFIX);
        if (offset < 0) continue;
        if (found || text.indexOf(PREFIX, offset + PREFIX.length) >= 0) return null;
        const end = text.indexOf(' -->', offset + PREFIX.length);
        if (end < 0 || end - offset > 180) return null;
        const receipt = text.slice(offset + PREFIX.length, end);
        if (!isCodexSummaryReceipt(receipt)) return null;
        const [, , digest, length] = receipt.split('_');
        const count = Number(length);
        const before = text.slice(0, offset).trimEnd();
        if (count > before.length || hash(before.slice(-count)) !== digest) return null;
        found = receipt;
      }
    }
    return found;
  } catch {
    return null;
  }
}

// The admitted recovery owner calls this only for a bound native local-summary
// turn. Signed/opaque, mixed-tool and ambiguous outputs cannot mint a receipt.
function sealCodexSummaryResponse(input) {
  try {
    const response = normalizeCompactionData(input, MAX_BYTES);
    const message = response?.output?.[0];
    const block = message?.content?.[0];
    if (
      response?.status !== 'completed' ||
      response.signature !== undefined ||
      response.encrypted_content !== undefined ||
      !Array.isArray(response.output) ||
      response.output.length !== 1 ||
      message?.type !== 'message' ||
      message.role !== 'assistant' ||
      (message.status !== undefined && message.status !== 'completed') ||
      Object.keys(message).some(
        (key) =>
          ![
            'type',
            'id',
            'role',
            'status',
            'content',
            'metadata',
            'internal_chat_message_metadata_passthrough',
            'phase',
          ].includes(key)
      ) ||
      (message.phase != null &&
        !['analysis', 'final', 'commentary', 'final_answer'].includes(message.phase)) ||
      (message.metadata != null && !record(message.metadata)) ||
      (message.internal_chat_message_metadata_passthrough != null &&
        !record(message.internal_chat_message_metadata_passthrough)) ||
      opaqueSummaryMetadata(message.metadata) ||
      opaqueSummaryMetadata(message.internal_chat_message_metadata_passthrough) ||
      !Array.isArray(message.content) ||
      message.content.length !== 1 ||
      block?.type !== 'output_text' ||
      typeof block.text !== 'string' ||
      Object.keys(block).some(
        (key) => !['type', 'text', 'annotations', 'logprobs'].includes(key)
      ) ||
      // A receipt adds text without provider token probabilities. Only an empty
      // optional probability array can remain aligned and byte preserving.
      (block.logprobs !== undefined &&
        (!Array.isArray(block.logprobs) || block.logprobs.length !== 0)) ||
      (block.annotations !== undefined &&
        (!Array.isArray(block.annotations) || block.annotations.length !== 0))
    )
      return null;
    const text = block.text.trimEnd();
    if (!text.trim() || text.length > 1024 * 1024 || text.includes(PREFIX)) return null;
    const receipt =
      'hcr1_' + randomBytes(24).toString('hex') + '_' + hash(text) + '_' + text.length;
    const output = [
      {
        ...message,
        content: [{ ...block, text: text + '\n\n' + PREFIX + receipt + ' -->' }],
      },
    ];
    const sealed = { ...response, output };
    if (Buffer.byteLength(JSON.stringify(sealed)) > MAX_BYTES) return null;
    return { response: sealed, output, responseId: receipt };
  } catch {
    return null;
  }
}

module.exports = {
  isCodexSummaryRequest,
  isCodexSummaryReceipt,
  parseCodexSummaryReceipt,
  sealCodexSummaryResponse,
};
