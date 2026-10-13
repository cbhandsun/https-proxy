'use strict';

// Provider finish reasons must not inherit another API's success default.
function geminiStreamTerminal(value) {
  if (value === 'STOP') return { reason: 'end_turn' };
  if (value === 'MAX_TOKENS') return { reason: 'max_tokens' };
  if (
    ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'].includes(
      value
    )
  )
    return { reason: 'refusal' };
  if (value === 'MALFORMED_FUNCTION_CALL')
    return { reason: 'error', code: 'upstream_stream_invalid_tool_arguments' };
  return { reason: 'error', code: 'upstream_stream_incomplete' };
}

module.exports = { geminiStreamTerminal };
