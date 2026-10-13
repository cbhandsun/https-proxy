'use strict';
const { createChatCompletionCollector } = require('../forced-stream-collector');
const { setUtf8StreamEncoding } = require('../utf8-stream');
const { attachConversionStreamCleanup } = require('./conversion-stream-cleanup');

function attachGeminiChatStream({
  ctx,
  proxyRes,
  clientRes,
  clientReq,
  guardConversionStream,
  parsed,
  targetModel,
  claudeBody,
  useCodeAssist,
  collapseUpstreamStream,
  upstreamPath,
  startTime,
  logRequestEnd,
  maxChars,
  maxConversionResponseBytes,
}) {
  const seed = {
    model: parsed.model || targetModel,
    messages: parsed.messages,
    route: targetModel,
  };
  const collector = collapseUpstreamStream
    ? createChatCompletionCollector(maxConversionResponseBytes)
    : null;
  const sink = collector ? { write: (wire) => collector.push(Buffer.from(wire)) } : clientRes;
  const converter = ctx.createGeminiChatStream(
    {
      id: ctx.fallbackId('chatcmpl', seed),
      created: ctx.stableCreated(seed),
      model: parsed.model || targetModel,
    },
    {
      tools: claudeBody.tools,
      maxChars,
      unwrapPayload: useCodeAssist ? ctx.unwrapCodeAssistResponse : undefined,
    }
  );
  const guard = guardConversionStream(
    proxyRes,
    { clientReq, clientRes, upstreamPath, startTime },
    'Gemini',
    'openai_chat_to_gemini_stream_aborted',
    () => converter.dispose?.()
  );
  attachConversionStreamCleanup(clientRes, converter);
  let settled = false;
  function fail() {
    if (settled) return;
    settled = true;
    guard.markComplete();
    proxyRes.destroy?.();
    if (collector)
      ctx.sendJsonError(clientRes, 502, {
        error: {
          type: 'protocol_conversion_error',
          message: 'Upstream Gemini response could not be converted safely',
        },
      });
    else clientRes.end();
    logRequestEnd(clientReq.method, upstreamPath, startTime, 502, {
      type: 'openai_to_gemini_conversion_error',
    });
  }
  setUtf8StreamEncoding(proxyRes);
  proxyRes.on('data', (chunk) => {
    if (settled || guard.hasFailed() || clientRes.destroyed || converter.state.failed) return;
    const text = chunk.toString('utf8');
    ctx.sampleResponseChunk?.('gemini-upstream', text, {
      upstreamPath,
      targetModel,
      entryProtocol: 'openai-chat',
    });
    try {
      converter.processChunk(sink, text);
    } catch {
      converter.state.failed = true;
    }
    if (converter.state.failed) fail();
  });
  proxyRes.on('end', () => {
    if (settled || guard.hasFailed() || clientRes.destroyed) return;
    guard.markComplete();
    try {
      converter.finish(sink);
      if (converter.state.failed) {
        fail();
        return;
      }
      if (collector) ctx.writeJsonResponse(clientRes, 200, collector.finish());
      else clientRes.end();
    } catch {
      fail();
      return;
    }
    settled = true;
    logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
      type: collector ? 'openai_to_gemini_stream_collapsed' : 'openai_to_gemini_stream',
      usage: converter.state.usage,
    });
  });
  return converter;
}
module.exports = { attachGeminiChatStream };
