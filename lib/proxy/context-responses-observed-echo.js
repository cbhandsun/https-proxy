'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = ['metadata', 'internal_chat_message_metadata_passthrough'];

// Only an independently observed output may mint this alternative frontier.
// Inbound history is never projected: changed metadata, arguments, content or
// extra fields must still match an exact published window or remain isolated.
// The raw output and its original frontier remain unchanged.
function observedResponsesEcho(input) {
  const output = normalizeCompactionData(input, 2 * 1024 * 1024);
  if (!Array.isArray(output) || !output.length || output.length > 16384 || !output.every(record))
    throw new TypeError('Invalid observed Responses output');
  let changed = false;
  const echo = output.map((item) => {
    if (
      !['function_call', 'custom_tool_call', 'message'].includes(item.type) ||
      (item.type === 'message' && item.role !== 'assistant') ||
      !fields.some((field) => Object.hasOwn(item, field))
    )
      return item;
    const projected = { ...item };
    for (const field of fields) delete projected[field];
    changed = true;
    return projected;
  });
  return changed ? echo : null;
}

function publishedBindingFrontiers(snapshot, continuity = false) {
  const primary = continuity ? snapshot.publishedContinuityFrontier : snapshot.publishedFrontier;
  const echo = continuity ? snapshot.echoContinuityFrontier : snapshot.echoFrontier;
  return echo === undefined ? [primary] : [primary, echo];
}

module.exports = { observedResponsesEcho, publishedBindingFrontiers };
