'use strict';
const { setUtf8StreamEncoding } = require('../utf8-stream');
const { attachConversionStreamCleanup } = require('./conversion-stream-cleanup');

function attachResponsesClaudeStream(
  ctx,
  {
    proxyRes,
    clientRes,
    clientReq,
    parsed,
    targetModel,
    upstreamPath,
    startTime,
    logRequestEnd,
    guardConversionStream,
    upstreamEndpoint,
    factory = ctx.createResponsesClaudeStream,
    idPrefix = 'msg_openai_responses',
    provider = 'OpenAI Responses',
    logType = 'claude_to_responses_stream',
    converterOptions = {},
    onChunk = () => {},
  }
) {
  const seed = {
    model: parsed.model || targetModel,
    messages: parsed.messages,
    route: targetModel,
  };
  const converter = factory({
    ...converterOptions,
    id: ctx.fallbackId(idPrefix, seed),
    model: parsed.model || targetModel,
    writeEvent: ctx.writeClaudeSseEvent,
  });
  const guard = guardConversionStream(
    proxyRes,
    { clientReq, clientRes, upstreamPath, startTime },
    provider,
    logType + '_aborted',
    () => converter.dispose?.()
  );
  attachConversionStreamCleanup(clientRes, converter);
  let settled = false;
  function end(ok) {
    if (settled || guard.hasFailed() || clientRes.destroyed) return;
    settled = true;
    guard.markComplete();
    if (!ok) proxyRes.destroy?.();
    clientRes.end();
    logRequestEnd(clientReq.method, upstreamPath, startTime, ok ? 200 : 502, {
      type: logType,
      upstreamEndpoint,
    });
  }
  converter.start(clientRes);
  if (converter.state.failed) {
    end(false);
    return converter;
  }
  setUtf8StreamEncoding(proxyRes);
  proxyRes.on('data', (chunk) => {
    if (settled || guard.hasFailed() || clientRes.destroyed) return;
    try {
      onChunk(chunk);
      converter.processChunk(clientRes, chunk.toString('utf8'));
    } catch {
      converter.abort(clientRes);
    }
    if (converter.state.failed) end(false);
  });
  proxyRes.on('end', () => {
    if (settled || guard.hasFailed() || clientRes.destroyed) return;
    try {
      end(converter.finish(clientRes));
    } catch {
      converter.abort(clientRes);
      end(false);
    }
  });
  return converter;
}
module.exports = { attachResponsesClaudeStream };
