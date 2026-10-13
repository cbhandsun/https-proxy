'use strict';

// Private, synchronous handoff between converters. Wire text is retained for
// identical resource accounting; only the redundant parsing is bypassed.
const CLAUDE_STREAM_EVENT = Symbol('claudeStreamEvent');
const CHAT_STREAM_CHUNK = Symbol('chatStreamChunk');

function checkInternalEventSize(wire, maxChars) {
  if (typeof wire !== 'string' || !wire.endsWith('\n\n'))
    throw new TypeError('Invalid internal stream frame');
  if (wire.length - 2 > maxChars) {
    const error = new RangeError('Internal stream event exceeds size limit');
    error.code = 'upstream_stream_event_too_large';
    throw error;
  }
}

module.exports = { CLAUDE_STREAM_EVENT, CHAT_STREAM_CHUNK, checkInternalEventSize };
