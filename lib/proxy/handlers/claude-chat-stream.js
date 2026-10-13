'use strict';

const { setUtf8StreamEncoding } = require('../utf8-stream');

function attachClaudeChatStream({
  proxyRes,
  clientRes,
  sink = clientRes,
  state,
  streamGuard,
  processChunk,
  flush,
  afterFlush = () => {},
  reportEnd,
}) {
  let settled = false;
  function finish() {
    if (settled || streamGuard.hasFailed() || clientRes.destroyed) return;
    settled = true;
    streamGuard.markComplete();
    flush(sink, state);
    afterFlush();
    clientRes.end();
    reportEnd(state.failed ? 502 : 200);
  }
  setUtf8StreamEncoding(proxyRes);
  proxyRes.on('data', (chunk) => {
    if (settled || streamGuard.hasFailed() || clientRes.destroyed) return;
    processChunk(sink, chunk.toString('utf8'), state);
    if (state.done) {
      finish();
      proxyRes.destroy?.();
    }
  });
  proxyRes.once('end', finish);
}

module.exports = { attachClaudeChatStream };
