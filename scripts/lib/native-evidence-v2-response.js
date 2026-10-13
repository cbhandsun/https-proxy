'use strict';

const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const { createSseEventParser } = require('../../lib/proxy/sse-buffer');
const { createNativeCompactionObserver } = require('./native-compaction-observer');
const { summarizeNativeBenchmarkFailure } = require('./native-benchmark-failure-summary');
const { nativeEvidenceV2Options } = require('./native-evidence-v2-options');
const fail = () =>
  Object.assign(new Error('Native response observation failed'), {
    code: 'native_v2_stream_invalid',
  });

function createNativeEvidenceV2Response(input) {
  const {
    compact,
    standalone,
    status,
    now = Date.now,
  } = nativeEvidenceV2Options(input, ['compact', 'standalone', 'status', 'now']);
  if (
    typeof compact !== 'boolean' ||
    typeof standalone !== 'boolean' ||
    !Number.isSafeInteger(status) ||
    status < 100 ||
    status > 599 ||
    typeof now !== 'function'
  )
    throw fail();
  const started = now();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parse = createSseEventParser(2 * 1024 * 1024);
  const state = { buffer: '' };
  const native = compact && !standalone && status === 200 ? createNativeCompactionObserver() : null;
  const chunks = [];
  const result = {
    status,
    responseCompletedEvents: 0,
    responseFailedEvents: 0,
    outputFunctionCallCount: 0,
    firstVisibleTextMs: null,
    responseBytes: 0,
  };
  let ended = false;
  let failed = false;
  const reject = (reason) => {
    result.observationFailureReason ??= reason;
    failed = true;
    throw fail();
  };
  function decode(chunk, streaming) {
    try {
      return decoder.decode(chunk, { stream: streaming });
    } catch {
      return reject('invalid_utf8');
    }
  }
  function parseEvents(text) {
    try {
      parse(state, text, 'native-v2', event);
    } catch {
      return reject(result.observationFailureReason ?? 'event_limit_or_data_invalid');
    }
  }
  function event(frame) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!data || data === '[DONE]') return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return reject('invalid_event_json');
    }
    const value = normalizeCompactionData(parsed, 2 * 1024 * 1024);
    if (!value || Array.isArray(value) || typeof value.type !== 'string')
      return reject('invalid_event_shape');
    if (native) native.observe(value);
    if (
      value.type === 'response.output_text.delta' &&
      typeof value.delta === 'string' &&
      value.delta
    )
      result.firstVisibleTextMs ??= now() - started;
    if (
      value.type === 'response.output_item.done' &&
      ['function_call', 'custom_tool_call'].includes(value.item?.type)
    )
      result.outputFunctionCallCount++;
    if (value.type === 'response.completed') {
      result.responseCompletedEvents++;
      if (
        !value.response ||
        typeof value.response !== 'object' ||
        Array.isArray(value.response) ||
        (value.response.status != null && value.response.status !== 'completed') ||
        value.response.error != null
      ) {
        result.responseFailedEvents++;
        if (result.responseFailedEvents > 64) return reject('failure_event_limit');
        (result.safeStreamFailures ??= []).push({ event: 'invalid_completed_response' });
      }
      const u = value.response?.usage;
      const count = (n) => Number.isSafeInteger(n) && n >= 0;
      if (u && ['input_tokens', 'output_tokens', 'total_tokens'].every((key) => count(u[key])))
        result.usage = {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          totalTokens: u.total_tokens,
          cachedInputTokens: count(u.input_tokens_details?.cached_tokens)
            ? u.input_tokens_details.cached_tokens
            : null,
          cacheWriteInputTokens: count(u.input_tokens_details?.cache_write_tokens)
            ? u.input_tokens_details.cache_write_tokens
            : null,
        };
    }
    if (['response.failed', 'response.incomplete', 'error'].includes(value.type)) {
      result.responseFailedEvents++;
      if (result.responseFailedEvents > 64) return reject('failure_event_limit');
      (result.safeStreamFailures ??= []).push({
        event: value.type,
        ...summarizeNativeBenchmarkFailure(value),
      });
    }
  }
  return {
    push(chunk) {
      if (ended || failed) throw fail();
      if (!Buffer.isBuffer(chunk)) return reject('invalid_chunk');
      result.responseBytes += chunk.length;
      if (result.responseBytes > 16 * 1024 * 1024) {
        return reject('response_size_limit');
      }
      try {
        if (standalone || status >= 400) {
          if (status < 400 || result.responseBytes <= 65536) chunks.push(chunk);
        } else parseEvents(decode(chunk, true));
      } catch {
        failed = true;
        throw fail();
      }
    },
    finish() {
      if (ended || failed) throw fail();
      ended = true;
      try {
        if (!standalone && status < 400) {
          parseEvents(decode(undefined, false));
          if (state.buffer.trim()) return reject('unfinished_event');
        } else {
          let value;
          try {
            value = normalizeCompactionData(
              JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
              16 * 1024 * 1024
            );
          } catch {
            value = null;
          }
          if (status >= 400)
            result.safeError = summarizeNativeBenchmarkFailure({ error: value?.error });
          else {
            const checkpoint = value?.output?.[0];
            result.validNativeWindow =
              value?.output?.length === 1 &&
              checkpoint?.type === 'compaction' &&
              typeof checkpoint.encrypted_content === 'string' &&
              checkpoint.encrypted_content.length > 0;
            if (result.validNativeWindow) result.compactOutputItems = 1;
          }
        }
        result.totalMs = now() - started;
        if (native) {
          result.nativeObservation = native.finish();
          result.validNativeWindow = result.nativeObservation.valid;
          if (result.validNativeWindow) result.compactOutputItems = 1;
        }
        return { ...result };
      } catch {
        failed = true;
        throw fail();
      }
    },
    getCheckpoint() {
      return native?.getCheckpoint() ?? null;
    },
    inspect() {
      return normalizeCompactionData(result, 65536);
    },
  };
}

module.exports = { createNativeEvidenceV2Response };
