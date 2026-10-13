'use strict';

const { parseBufferedChatCompletion } = require('./context-artifact-tool');
const { WBIPC_MAX_FRAME_BYTES } = require('./workbuddy-wbipc-frame-reader');

// WBIPC already bounds the complete authenticated wire frame. SSE event/header
// overhead is not summary content. Collapse only inside that existing wire cap,
// then reapply the caller's unchanged decoded JSON budget; semantic summary and
// task-state limits, tool/refusal/terminal checks and deadlines remain separate.
function parseWorkBuddySummaryCompletion(body, maxDecodedBytes) {
  if (
    !Number.isSafeInteger(maxDecodedBytes) ||
    maxDecodedBytes < 1 ||
    maxDecodedBytes > WBIPC_MAX_FRAME_BYTES
  )
    return null;
  const completion =
    parseBufferedChatCompletion(body, false, WBIPC_MAX_FRAME_BYTES) ||
    parseBufferedChatCompletion(body, true, WBIPC_MAX_FRAME_BYTES);
  if (!completion || Buffer.byteLength(JSON.stringify(completion)) > maxDecodedBytes) return null;
  return completion;
}

module.exports = { parseWorkBuddySummaryCompletion };
