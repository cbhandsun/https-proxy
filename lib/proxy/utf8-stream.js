'use strict';

/**
 * Ask Node's stream decoder to preserve UTF-8 code points that cross transport
 * chunk boundaries. Calling Buffer#toString on each raw chunk can otherwise
 * replace a split multibyte character with U+FFFD before the SSE parser sees it.
 */
function setUtf8StreamEncoding(stream) {
  if (!stream || typeof stream.setEncoding !== 'function') return false;
  stream.setEncoding('utf8');
  return true;
}

module.exports = { setUtf8StreamEncoding };
