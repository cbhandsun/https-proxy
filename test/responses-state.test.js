const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createResponsesState } = require('../lib/proxy/handlers/responses-state');

function createProxyRes() {
  const proxyRes = new EventEmitter();
  proxyRes.destroyed = false;
  proxyRes.destroy = () => {
    proxyRes.destroyed = true;
  };
  return proxyRes;
}

function createState(overrides = {}) {
  const calls = {
    jsonErrors: [],
    proxyEvents: [],
    requestEnds: [],
    warnings: [],
  };
  const state = createResponsesState({
    log: {
      warn(...args) {
        calls.warnings.push(args.join(' '));
      },
      info() {},
    },
    sendJsonError(res, statusCode, body) {
      calls.jsonErrors.push({ res, statusCode, body });
    },
    logProxyEvent(eventName, payload) {
      calls.proxyEvents.push({ eventName, payload });
    },
    logRequestEnd(method, path, startTime, statusCode, meta) {
      calls.requestEnds.push({ method, path, startTime, statusCode, meta });
    },
    fallbackId: () => 'id',
    stableCreated: () => 1,
    processOpenAIChatSseChunkToResponses() {},
    flushOpenAIChatSseToResponses() {},
    openAIResponsesToChat: () => ({}),
    conversionResponseLimit: 8,
    limit: 20,
    ...overrides,
  });
  return { state, calls };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(() => {
  let capturedState = null;
  const { state } = createState({
    processOpenAIChatSseChunkToResponses(_res, _chunk, responseState) {
      capturedState = responseState;
    },
  });
  const bridge = state.createChatToResponsesBridge(
    { write() {} },
    {
      model: 'gemini-3.8-flash',
      input: [
        {
          type: 'additional_tools',
          tools: [
            {
              type: 'namespace',
              name: 'functions',
              tools: [{ type: 'custom', name: 'exec', description: 'Run code' }],
            },
          ],
        },
        { role: 'user', content: 'hello' },
      ],
    },
    'gemini-3.8-flash-tiered'
  );

  bridge.chatRes.write('data: {}\n\n');
  assert.ok(capturedState.customToolNames.has('exec'));
  assert.ok(bridge.responseState.customToolNames.has('exec'));
})();

(() => {
  const { state, calls } = createState();
  const proxyRes = createProxyRes();
  const clientRes = { headersSent: false };
  let completed = false;

  state.collectBoundedResponse(
    proxyRes,
    clientRes,
    '/v1/responses',
    'responses_to_chat',
    () => {
      completed = true;
    },
    { method: 'POST', startTime: 123 }
  );

  proxyRes.emit('data', Buffer.from('12345'));
  proxyRes.emit('data', Buffer.from('6789'));
  proxyRes.emit('end');

  assert.strictEqual(completed, false);
  assert.strictEqual(proxyRes.destroyed, true);
  assert.strictEqual(calls.jsonErrors[0].statusCode, 502);
  assert.strictEqual(calls.jsonErrors[0].body.error.type, 'upstream_response_too_large');
  assert.deepStrictEqual(calls.proxyEvents[0], {
    eventName: 'upstream_response_too_large',
    payload: {
      path: '/v1/responses',
      type: 'responses_to_chat',
      bytes: 9,
      limit: 8,
    },
  });
  assert.deepStrictEqual(calls.requestEnds[0], {
    method: 'POST',
    path: '/v1/responses',
    startTime: 123,
    statusCode: 502,
    meta: {
      type: 'responses_to_chat_response_too_large',
      errorType: 'upstream_response_too_large',
      bytes: 9,
      limit: 8,
    },
  });
})();

(() => {
  const { state, calls } = createState();
  const proxyRes = createProxyRes();
  const clientRes = { headersSent: false };
  const err = new Error('aborted');
  err.code = 'ECONNRESET';

  state.collectBoundedResponse(
    proxyRes,
    clientRes,
    '/v1/chat/completions',
    'openai_to_gemini',
    () => {},
    { method: 'POST', startTime: 456 }
  );
  proxyRes.emit('error', err);

  assert.strictEqual(calls.jsonErrors[0].body.error.type, 'proxy_error');
  assert.deepStrictEqual(calls.proxyEvents[0], {
    eventName: 'upstream_response_error',
    payload: {
      path: '/v1/chat/completions',
      type: 'openai_to_gemini',
      error: 'aborted',
      code: 'ECONNRESET',
    },
  });
  assert.deepStrictEqual(calls.requestEnds[0], {
    method: 'POST',
    path: '/v1/chat/completions',
    startTime: 456,
    statusCode: 502,
    meta: {
      type: 'openai_to_gemini_response_error',
      errorType: 'proxy_error',
      error: 'aborted',
      code: 'ECONNRESET',
    },
  });
})();

(() => {
  const { state, calls } = createState();
  const proxyRes = createProxyRes();
  const clientRes = { headersSent: false };
  let body = null;

  state.collectBoundedResponse(
    proxyRes,
    clientRes,
    '/ok',
    'ok_type',
    (responseBody) => {
      body = responseBody;
    },
    { method: 'GET', startTime: 789 }
  );
  proxyRes.emit('data', Buffer.from('ok'));
  proxyRes.emit('end');

  assert.strictEqual(body, 'ok');
  assert.strictEqual(calls.jsonErrors.length, 0);
  assert.strictEqual(calls.requestEnds.length, 0);
})();

(async () => {
  const oversizedCachePath = path.join(
    os.tmpdir(),
    'responses-history-cache-' + process.pid + '.json'
  );
  const oldCachePath = oversizedCachePath + '.old';
  try {
    fs.writeFileSync(oldCachePath, 'x'.repeat(2048));
    const { state: skipped } = createState({
      cacheFile: oldCachePath,
      cacheFileMaxBytes: 1024,
    });
    assert.strictEqual(skipped.responsesHistory.size, 0);

    const { state } = createState({
      cacheFile: oversizedCachePath,
      cacheFileMaxBytes: 1024,
      cacheSaveDelayMs: 0,
    });
    state.rememberResponsesHistory('resp_old', [{ role: 'user', content: 'a'.repeat(600) }]);
    state.rememberResponsesHistory('resp_mid', [{ role: 'user', content: 'b'.repeat(600) }]);
    state.rememberResponsesHistory('resp_new', [{ role: 'user', content: 'c'.repeat(600) }]);
    await wait(20);

    const raw = fs.readFileSync(oversizedCachePath, 'utf8');
    assert.ok(Buffer.byteLength(raw, 'utf8') <= 1024);
    const entries = JSON.parse(raw);
    assert.ok(entries.length < 3);
    assert.strictEqual(entries[entries.length - 1][0], 'resp_new');
  } finally {
    fs.rmSync(oversizedCachePath, { force: true });
    fs.rmSync(oldCachePath, { force: true });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-responses-cache-'));
  const cacheFile = path.join(tmpDir, 'responses-history.json');
  try {
    const { state } = createState({ cacheFile, cacheSaveDelayMs: 0 });
    state.rememberResponsesHistory('resp_1', [{ role: 'user', content: 'hello' }]);
    await wait(20);

    const entries = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert.deepStrictEqual(entries, [['resp_1', [{ role: 'user', content: 'hello' }]]]);
    const leftovers = fs.readdirSync(tmpDir).filter((name) => name.endsWith('.tmp'));
    assert.deepStrictEqual(leftovers, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const tmpDirFailure = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-responses-cache-fail-'));
  const failureCacheFile = path.join(tmpDirFailure, 'responses-history.json');
  try {
    fs.writeFileSync(failureCacheFile, '[["old",[]]]', 'utf8');
    const { state, calls } = createState({
      cacheFile: failureCacheFile,
      cacheSaveDelayMs: 0,
      writeHistoryCacheFile() {
        throw new Error('disk full');
      },
    });
    state.rememberResponsesHistory('resp_2', [{ role: 'assistant', content: 'later' }]);
    await wait(20);

    assert.strictEqual(fs.readFileSync(failureCacheFile, 'utf8'), '[["old",[]]]');
    assert.ok(
      calls.warnings.some((warning) =>
        warning.includes('Failed to save responses history cache: disk full')
      ),
      'cache write failure should be logged'
    );
  } finally {
    fs.rmSync(tmpDirFailure, { recursive: true, force: true });
  }

  // Regression: trimming the cache to its byte budget used to re-stringify the
  // whole history on every dropped entry (O(n^2)), which blocked the event loop
  // for seconds on large contexts. Keep the trim cost near-linear.
  const tmpDirPerf = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-responses-cache-perf-'));
  const perfCacheFile = path.join(tmpDirPerf, 'responses-history.json');
  try {
    const bigPayload = 'x'.repeat(180 * 1024);
    let stringifyCalls = 0;
    const originalStringify = JSON.stringify;
    const { state } = createState({
      cacheFile: perfCacheFile,
      cacheSaveDelayMs: 0,
      limit: 200,
    });
    JSON.stringify = function stringifyWithCount(...args) {
      stringifyCalls += 1;
      return originalStringify.apply(this, args);
    };
    try {
      for (let i = 0; i < 80; i += 1) {
        state.rememberResponsesHistory('resp_big_' + i, [{ role: 'user', content: bigPayload }]);
      }
      state.rememberResponsesHistory('resp_final', [{ role: 'user', content: 'z'.repeat(1024) }]);
      await wait(60);
    } finally {
      JSON.stringify = originalStringify;
    }
    const raw = fs.readFileSync(perfCacheFile, 'utf8');
    const parsed = JSON.parse(raw);
    assert.ok(parsed.length > 0, 'large history cache should keep at least one entry');
    assert.strictEqual(parsed[parsed.length - 1][0], 'resp_final');
    assert.ok(
      Buffer.byteLength(raw, 'utf8') <= 4 * 1024 * 1024,
      'serialized cache must stay within the byte budget'
    );
    assert.ok(
      stringifyCalls <= 90,
      'cache trim should serialize each entry once, stringify calls=' + stringifyCalls
    );
  } finally {
    fs.rmSync(tmpDirPerf, { recursive: true, force: true });
  }

  console.log('[responses-state.test] ok');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
