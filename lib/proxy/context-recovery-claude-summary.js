'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { normalizeCompactionData } = require('./context-compaction-envelope');

const MAX_BYTES = 2 * 1024 * 1024;
const PREFIX = '<!-- hpm-context-summary:';
const BILLING =
  /^(x-anthropic-billing-header: cc_version=\d{1,4}\.\d{1,4}\.\d{1,4})\.[a-f0-9]{3}(; cc_entrypoint=(?:cli|sdk-cli);)$/;
const RECEIPT = /^hcs1_[a-f0-9]{48}_[a-f0-9]{64}_[1-9][0-9]{0,6}$/;
const hash = (text) => createHash('sha256').update(text).digest('hex');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// Policy/request/receipt inputs come from the bounded JSON parser in protocol
// admission or the session boundary; no raw host objects are accepted there.

// Equality projection only. The checksum is derived from the native window and
// changes on compaction; the client version, entrypoint and every instruction
// remain scoped. Unknown header shapes and extra block fields stay significant.
function claudeRecoveryPolicyIdentity(policy) {
  const block = policy?.system?.[0];
  if (
    !Array.isArray(policy?.system) ||
    !record(block) ||
    block.type !== 'text' ||
    typeof block.text !== 'string' ||
    Object.keys(block).sort().join(',') !== 'text,type' ||
    !BILLING.test(block.text)
  )
    return policy;
  return {
    ...policy,
    system: [
      { ...block, text: block.text.replace(BILLING, '$1.[window-checksum]$2') },
      ...policy.system.slice(1),
    ],
  };
}

function isClaudeSummaryRequest(body) {
  const billing = body?.system?.[0];
  if (!record(billing) || typeof billing.text !== 'string' || !BILLING.test(billing.text))
    return false;
  const last = Array.isArray(body?.messages) ? body.messages.at(-1) : null;
  if (last?.role !== 'user') return false;
  const text =
    typeof last.content === 'string'
      ? last.content
      : Array.isArray(last.content)
        ? last.content.at(-1)?.text
        : null;
  return (
    typeof text === 'string' &&
    // Native versions add a compaction preamble before this instruction. This
    // classifier controls annotation only; it grants no binding authority.
    text.includes('Your task is to create a detailed summary of the conversation so far') &&
    text.includes('<analysis>') &&
    text.includes('<summary>')
  );
}

// This is not a root selector or a standalone authorization token. The random
// ID is indexed only by a successfully published, currently authorized session.
// Parsing checks the exact summary fragment; registry lookup still checks the
// current principal/target/full policy and the committed branch's lifetime.
function parseClaudeSummaryReceipt(history) {
  const first = history?.[0];
  if (first?.role !== 'user') return null;
  const text =
    typeof first.content === 'string'
      ? first.content
      : Array.isArray(first.content) &&
          first.content.length === 1 &&
          first.content[0]?.type === 'text'
        ? first.content[0].text
        : null;
  if (typeof text !== 'string' || text.length > MAX_BYTES) return null;
  const offset = text.lastIndexOf(PREFIX);
  if (offset < 0) return null;
  const end = text.indexOf(' -->', offset + PREFIX.length);
  if (end < 0 || end - offset > 180) return null;
  const receipt = text.slice(offset + PREFIX.length, end);
  if (!RECEIPT.test(receipt)) return null;
  const [, , digest, length] = receipt.split('_');
  const count = Number(length);
  const before = text.slice(0, offset).trimEnd();
  if (count > before.length || hash(before.slice(-count)) !== digest) return null;
  return receipt;
}

function isClaudeSummaryReceipt(value) {
  return typeof value === 'string' && RECEIPT.test(value);
}

// Only the admitted private runner calls this on an already bound native
// summarization request. The observer remains byte preserving. Signed/opaque,
// mixed-tool, ambiguous summary envelopes and oversized responses are unchanged.
function sealClaudeSummaryResponse(input) {
  const response = normalizeCompactionData(input, MAX_BYTES);
  if (
    response?.role !== 'assistant' ||
    Object.keys(response).some(
      (key) =>
        ![
          'id',
          'type',
          'role',
          'model',
          'stop_reason',
          'stop_sequence',
          'content',
          'usage',
        ].includes(key)
    ) ||
    response.stop_reason !== 'end_turn' ||
    !Array.isArray(response.content) ||
    response.content.length !== 1 ||
    response.content[0]?.type !== 'text' ||
    typeof response.content[0].text !== 'string' ||
    Object.keys(response.content[0]).sort().join(',') !== 'text,type'
  )
    return null;
  const text = response.content[0].text;
  const open = text.indexOf('<summary>');
  const close = text.indexOf('</summary>');
  if (
    open < 0 !== close < 0 ||
    (open >= 0 &&
      (close < open + 9 ||
        text.indexOf('<summary>', open + 9) >= 0 ||
        text.indexOf('</summary>', close + 10) >= 0))
  )
    return null;
  const summary = (open < 0 ? text : text.slice(open + 9, close)).trim();
  if (!summary || summary.length > 1024 * 1024) return null;
  const receipt =
    'hcs1_' + randomBytes(24).toString('hex') + '_' + hash(summary) + '_' + summary.length;
  const marker = '\n\n' + PREFIX + receipt + ' -->';
  const insertion = close < 0 ? text.length : close;
  const content = [
    { type: 'text', text: text.slice(0, insertion) + marker + text.slice(insertion) },
  ];
  const sealed = { ...response, content };
  if (Buffer.byteLength(JSON.stringify(sealed)) > MAX_BYTES) return null;
  return { response: sealed, output: [{ role: 'assistant', content }], responseId: receipt };
}

module.exports = {
  claudeRecoveryPolicyIdentity,
  isClaudeSummaryRequest,
  parseClaudeSummaryReceipt,
  isClaudeSummaryReceipt,
  sealClaudeSummaryResponse,
};
