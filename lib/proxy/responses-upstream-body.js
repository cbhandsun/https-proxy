'use strict';
const { createResponsesCollector } = require('./forced-stream-collector');

function parseResponsesUpstreamBody(text, parseFallback, { maxBytes = 16 * 1024 * 1024 } = {}) {
  if (typeof text !== 'string') throw new TypeError('Responses upstream body must be text');
  if (!/^\s*(?:event:|data:|:)/.test(text)) return parseFallback(text);
  const collector = createResponsesCollector(maxBytes);
  try {
    collector.push(Buffer.from(text));
    return collector.finish();
  } finally {
    collector.discard();
  }
}

module.exports = { parseResponsesUpstreamBody };
