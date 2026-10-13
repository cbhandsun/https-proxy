'use strict';

const { setUtf8StreamEncoding } = require('../utf8-stream');
const { attachConversionStreamCleanup } = require('./conversion-stream-cleanup');

function attachGeminiResponsesStream({
  proxyRes,
  clientReq,
  clientRes,
  outputFlow,
  outputGate,
  bridge,
  converter,
  outputRecovery,
  geminiBody,
  guardConversionStream,
  rememberResponsesFromBridge,
  chatBody,
  upstreamPath,
  startTime,
  logRequestEnd,
  requestBodyDiagnostic,
}) {
  const state = converter.state;
  attachConversionStreamCleanup(clientRes, converter);
  const sink = outputGate.sink;
  let settled = false;
  const guard = guardConversionStream(
    proxyRes,
    { clientReq, clientRes, upstreamPath, startTime },
    'Gemini',
    'responses_to_gemini_stream_aborted',
    () => {
      state.streamFailed = true;
      converter.dispose?.();
    }
  );
  function reportFailure() {
    if (!state.failed || settled) return false;
    settled = true;
    outputGate.commit();
    clientRes.end();
    logRequestEnd(clientReq.method, upstreamPath, startTime, 502, {
      type: 'responses_to_gemini_stream',
      code: bridge.responseState.failure?.code,
    });
    guard.markComplete();
    proxyRes.destroy?.();
    return true;
  }
  setUtf8StreamEncoding(proxyRes);
  proxyRes.on('data', (chunk) => {
    if (settled || guard.hasFailed() || clientRes.destroyed) return;
    converter.processChunk(sink, chunk.toString('utf8'));
    if (reportFailure()) return;
    outputGate.commitIfOutput(state);
  });
  proxyRes.on('end', () => {
    if (settled || guard.hasFailed() || state.streamFailed || clientRes.destroyed) return;
    converter.flushInput(sink);
    if (reportFailure()) return;
    guard.markComplete();
    outputGate.commitIfOutput(state);
    if (
      outputRecovery.retryEmpty({
        budget: geminiBody.__hpmDiagnostics?.outputBudget,
        stopReason: state.stopReason,
        state,
        committed: outputGate.isCommitted(),
        usage: state.usage,
      })
    ) {
      settled = true;
      outputFlow.dispose();
      outputGate.discard();
      converter.dispose?.();
      return;
    }
    outputGate.commit();
    converter.finish(sink);
    if (reportFailure()) return;
    settled = true;
    rememberResponsesFromBridge(bridge, chatBody);
    clientRes.end();
    logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
      type: 'responses_to_gemini_stream',
      usage: state.usage,
      requestBodyDiagnostic,
    });
  });
}

module.exports = { attachGeminiResponsesStream };
