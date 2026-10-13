'use strict';

const { CLAUDE_STREAM_EVENT } = require('../internal-stream-events');
const {
  createConversionStreamBudget,
  conversionFailureCode,
} = require('../conversion-stream-budget');
const { createConversionStreamOutput } = require('../conversion-stream-output');
const { parseBoundedInteger } = require('../sse-buffer');
const { terminateClientAfterUpstreamFailure } = require('./failure-terminal');

// Native Claude filtering keeps executable tools private until both message_stop
// and normal transport end. Text before the first tool remains incremental.
function bindClaudeFilteredStream({
  proxyRes,
  clientRes,
  clientReq,
  upstreamPath,
  startTime,
  state,
  streamGuard,
  protocolOptions = {},
  processChunk,
  finish,
  sampleChunk = () => {},
  logRequestEnd,
  onFailure,
  onOutputFailure,
  onComplete,
}) {
  const budget = createConversionStreamBudget(protocolOptions);
  const maxQueuedBytes = parseBoundedInteger(
    protocolOptions.maxConversionOutputBufferBytes,
    8 * 1024 * 1024,
    1,
    32 * 1024 * 1024
  );
  const queue = [];
  let queuedBytes = 0,
    holdingTools = false,
    bufferingFinal = false,
    terminal = false,
    failed = false;
  let stopReason;
  function clear() {
    queue.length = 0;
    queuedBytes = 0;
    state.buffer = '';
    state.pendingClaudeTool = null;
    state.pendingOpenAITool = null;
  }
  const output = createConversionStreamOutput({
    proxyRes,
    clientRes,
    clientReq,
    upstreamPath,
    startTime,
    logRequestEnd,
    protocolOptions,
    onStop(code) {
      failed = true;
      clear();
      streamGuard.markComplete();
      onOutputFailure(code);
    },
  });
  function reject(code) {
    if (failed || output.isStopped() || streamGuard.hasFailed()) return;
    failed = true;
    clear();
    output.dispose();
    streamGuard.markComplete();
    onFailure(code);
    terminateClientAfterUpstreamFailure(clientRes, {
      stream: true,
      payload: { code, message: 'Upstream Claude stream could not be completed safely' },
    });
    proxyRes.destroy?.();
  }
  function write(wire) {
    if (holdingTools || bufferingFinal) {
      queuedBytes += Buffer.byteLength(wire);
      if (queuedBytes > maxQueuedBytes || queue.length >= 8192) {
        const error = new RangeError('Claude filtered output exceeds buffer limit');
        error.code = 'upstream_stream_conversion_limit';
        throw error;
      }
      queue.push(wire);
      return true;
    }
    return output.clientRes.write(wire);
  }
  const sink = new Proxy(output.clientRes, {
    get(target, key) {
      if (key === 'write') return write;
      if (key === CLAUDE_STREAM_EVENT)
        return (event, data, wire) => {
          if (terminal && event !== 'ping') {
            const error = new Error('Claude event follows terminal');
            error.code = 'upstream_stream_invalid_tool_arguments';
            throw error;
          }
          if (event === 'content_block_start' && data.content_block?.type === 'tool_use')
            holdingTools = true;
          if (event === 'message_delta') {
            stopReason = data.delta?.stop_reason;
            bufferingFinal = true;
          }
          if (event === 'message_stop') {
            terminal = true;
            bufferingFinal = true;
          }
          if (event === 'error') {
            const error = new Error('Claude provider stream error');
            error.code = 'upstream_stream_conversion_error';
            throw error;
          }
          return write(wire);
        };
      return Reflect.get(target, key, target);
    },
  });
  proxyRes.on('data', (chunk) => {
    if (failed || streamGuard.hasFailed()) {
      clear();
      return;
    }
    try {
      const text = chunk.toString('utf8');
      budget.consume(state, text);
      sampleChunk(text);
      processChunk(sink, text, state);
    } catch (error) {
      reject(conversionFailureCode(error));
    }
  });
  proxyRes.on('end', () => {
    if (failed || streamGuard.hasFailed()) {
      clear();
      output.dispose();
      return;
    }
    try {
      finish(sink, state);
      if (!terminal || (holdingTools && !['end_turn', 'tool_use'].includes(stopReason))) {
        reject('upstream_stream_invalid_tool_arguments');
        return;
      }
      for (const wire of queue) {
        if (output.isStopped()) return;
        output.clientRes.write(wire);
      }
      clear();
      if (output.isStopped()) return;
      streamGuard.markComplete();
      onComplete(output.logRequestEnd);
      output.clientRes.end();
    } catch (error) {
      reject(conversionFailureCode(error));
    }
  });
  proxyRes.once('close', () => {
    clear();
    if (streamGuard.hasFailed()) output.dispose();
  });
  return { isFailed: () => failed, queuedBytes: () => queuedBytes };
}

module.exports = { bindClaudeFilteredStream };
