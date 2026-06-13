const assert = require('assert');
const http = require('http');

const { createTraeBridgeUtils } = require('../lib/proxy/trae-bridge-utils');

async function withTraeSseServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const calls = [];
  const utils = createTraeBridgeUtils({
    makeRequest: async (url, options, body) => {
      calls.push({ url, options, body });
      return { statusCode: 200, body: JSON.stringify({ ok: true, text: 'done' }) };
    },
    getTraeOfficialBridgeUrl: (pathname) => `http://127.0.0.1:17861${pathname}`,
    normalizeTraeBridgeText: (payload) => payload.text,
    bridgeTimeoutMs: 'Infinity',
    liveHeartbeatMs: -1,
  });

  const result = await utils.callTraeOfficialBridge({ prompt: 'hello' });
  assert.strictEqual(result.text, 'done');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].options.timeout, 5 * 60 * 1000);

  let heartbeatCount = 0;
  const stop = utils.startLiveHeartbeat(() => {
    heartbeatCount += 1;
  });
  stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.strictEqual(heartbeatCount, 0);

  await withTraeSseServer(
    (req, res) => {
      assert.strictEqual(req.url, '/v1/chat/stream');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write('event: text_delta\ndata: {"text":"abcdef"}\n\n');
      res.end('event: done\ndata: {"ok":true,"text":"done-text-too-long"}\n\n');
    },
    async (baseUrl) => {
      const streamUtils = createTraeBridgeUtils({
        makeRequest: async () => ({ statusCode: 200, body: '{}' }),
        getTraeOfficialBridgeUrl: (pathname) => baseUrl + pathname,
        normalizeTraeBridgeText: (payload) => payload.text || '',
        maxFinalTextChars: 5,
      });
      const deltas = [];
      const streamResult = await streamUtils.streamTraeOfficialBridge(
        { prompt: 'hello' },
        { onTextDelta: (text) => deltas.push(text) }
      );
      assert.deepStrictEqual(deltas, ['abcdef']);
      assert.strictEqual(streamResult.text, 'done-');
      assert.strictEqual(streamResult.textTruncated, true);
      assert.strictEqual(streamResult.rawDone.text, 'done-');
      assert.strictEqual(streamResult.rawDone.textTruncated, true);
    }
  );

  await withTraeSseServer(
    (req, res) => {
      assert.strictEqual(req.url, '/v1/chat/stream');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write('event: text_delta\ndata: {"text":"' + 'x'.repeat(2048));
    },
    async (baseUrl) => {
      const streamUtils = createTraeBridgeUtils({
        makeRequest: async () => ({ statusCode: 200, body: '{}' }),
        getTraeOfficialBridgeUrl: (pathname) => baseUrl + pathname,
        normalizeTraeBridgeText: (payload) => payload.text || '',
        maxSseBufferChars: 1024,
      });
      await assert.rejects(
        () => streamUtils.streamTraeOfficialBridge({ prompt: 'hello' }),
        /SSE event too large/
      );
    }
  );
}

main()
  .then(() => {
    console.log('[trae-bridge-utils.test] ok');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
