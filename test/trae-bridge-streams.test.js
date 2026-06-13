const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createTraeBridgeRuntime } = require('../lib/proxy/trae-bridge-runtime');
const {
  collectLogEvents,
  getNativeDeepEvents,
  startNativeDeepProgress,
} = require('../lib/proxy/trae-debug-center');
const {
  openAIChatToResponses,
  processOpenAIChatSseChunkToResponses,
  flushOpenAIChatSseToResponses,
  buildTraeBridgeOpenAIChatCompletion,
  normalizeTraeBridgeText,
} = require('../openai-proxy');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function createFakeTraeRuntime(baseUrl, overrides = {}) {
  return createTraeBridgeRuntime({
    makeRequest: async () => ({ statusCode: 200, headers: {}, body: '{}' }),
    getTraeOfficialBridgeUrl: (pathname) => baseUrl + pathname,
    normalizeTraeBridgeText,
    buildTraeBridgeOpenAIChatCompletion,
    openAIChatToResponses,
    processOpenAIChatSseChunkToResponses,
    flushOpenAIChatSseToResponses,
    writeClaudeSseEvent: () => {},
    fallbackId: (prefix) => prefix + '_test',
    stableCreated: () => 123,
    bridgeTimeoutMs: 5000,
    liveHeartbeatMs: 25,
    liveLogProgress: false,
    ...overrides,
  });
}

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

test('streams Trae bridge SSE text and interaction events', async () => {
  await withTraeSseServer(
    (req, res) => {
      assert.strictEqual(req.url, '/v1/chat/stream');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(
        'event: raw_event\ndata: {"ts":1234,"service":"chat","method":"chat","event":"plan_item","payload":{"id":"p1","agent_status":{"status":"running"},"tool_call_info":{"id":"t1","name":"finish"}}}\n\n'
      );
      res.write('event: text_delta\ndata: {"text":"hello"}\n\n');
      res.write('event: progress\ndata: {"phase":"running","elapsedMs":2000}\n\n');
      res.write(
        'event: interaction\ndata: {"interaction":{"type":"RunCommand","command":"dir","cwd":"E:/repo"}}\n\n'
      );
      res.end('event: done\ndata: {"ok":true,"text":"hello world"}\n\n');
    },
    async (baseUrl) => {
      const runtime = createFakeTraeRuntime(baseUrl);
      const deltas = [];
      const progressEvents = [];
      const interactions = [];
      const rawEvents = [];
      const result = await runtime.streamTraeOfficialBridge(
        { prompt: 'hello', model: 'gpt-5.4' },
        {
          onTextDelta: (text) => deltas.push(text),
          onProgress: (progress) => progressEvents.push(progress),
          onInteraction: (interaction) => interactions.push(interaction),
          onRawEvent: (rawEvent) => rawEvents.push(rawEvent),
        }
      );
      assert.deepStrictEqual(deltas, ['hello']);
      assert.strictEqual(progressEvents[0].phase, 'running');
      assert.strictEqual(interactions[0].type, 'RunCommand');
      assert.strictEqual(rawEvents[0].event, 'plan_item');
      assert.strictEqual(result.text, 'hello world');
    }
  );
});

test('writes compact Trae raw progress comments when debug mode is enabled', async () => {
  await withTraeSseServer(
    (req, res) => {
      assert.strictEqual(req.url, '/v1/chat/stream');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(
        'event: raw_event\ndata: {"ts":1234,"service":"chat","method":"chat","channelId":"c1","event":"plan_item","payload":{"id":"p1","task_id":"task1","thought":{"redacted":true,"chars":8},"reasoning_content":{"redacted":true,"chars":21},"agent_status":{"status":"running","run_mode":"foreground"},"tool_call_info":{"id":"t1","name":"finish","result":{"status":"success"}}}}\n\n'
      );
      res.write('event: text_delta\ndata: {"text":"done"}\n\n');
      res.end('event: done\ndata: {"ok":true,"text":"done"}\n\n');
    },
    async (baseUrl) => {
      const runtime = createFakeTraeRuntime(baseUrl, {
        rawProgressMode: 'comment',
        liveHeartbeatMs: 0,
      });
      const chunks = [];
      const clientRes = {
        writeHead(statusCode, headers) {
          this.statusCode = statusCode;
          this.headers = headers;
        },
        write(chunk) {
          chunks.push(String(chunk));
        },
        end() {
          this.ended = true;
        },
      };
      await runtime.writeTraeBridgeOpenAILiveStream(
        clientRes,
        { model: 'trae/gpt-5.4' },
        { prompt: 'hello', model: 'gpt-5.4' },
        'gpt-5.4'
      );
      const output = chunks.join('');
      assert.ok(output.includes(': trae-raw {"source":"trae-raw","event":"plan_item"'));
      assert.ok(output.includes('"agentStatus":"running"'));
      assert.ok(output.includes('"toolName":"finish"'));
      assert.ok(!output.includes('reasoning_content'));
      assert.ok(output.includes('"content":"done"'));
      assert.ok(output.includes('data: [DONE]'));
    }
  );
});

test('can surface Trae raw progress as visible OpenAI stream text when explicitly enabled', async () => {
  await withTraeSseServer(
    (req, res) => {
      assert.strictEqual(req.url, '/v1/chat/stream');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(
        'event: raw_event\ndata: {"ts":1234,"service":"chat","method":"chat","channelId":"c1","event":"plan_item","payload":{"id":"p1","thought":{"redacted":true,"chars":8},"agent_status":{"status":"running"},"tool_call_info":{"id":"t1","name":"run_command","result":{"status":"success"}}}}\n\n'
      );
      res.write('event: text_delta\ndata: {"text":"done"}\n\n');
      res.end('event: done\ndata: {"ok":true,"text":"done"}\n\n');
    },
    async (baseUrl) => {
      const runtime = createFakeTraeRuntime(baseUrl, {
        rawProgressMode: 'visible',
        liveHeartbeatMs: 0,
      });
      const chunks = [];
      const clientRes = {
        writeHead(statusCode, headers) {
          this.statusCode = statusCode;
          this.headers = headers;
        },
        write(chunk) {
          chunks.push(String(chunk));
        },
        end() {
          this.ended = true;
        },
      };
      await runtime.writeTraeBridgeOpenAILiveStream(
        clientRes,
        { model: 'trae/gpt-5.4' },
        { prompt: 'hello', model: 'gpt-5.4' },
        'gpt-5.4'
      );
      const output = chunks.join('');
      assert.ok(output.includes('[Trae plan_item tool=run_command status=success'));
      assert.ok(output.includes('"content":"done"'));
      assert.ok(!output.includes('"thought"'));
      assert.ok(!output.includes('reasoning_content'));
      assert.ok(!output.includes(': trae-raw'));
      assert.ok(output.indexOf('[Trae plan_item') < output.indexOf('"content":"done"'));
    }
  );
});

test('can surface Trae raw progress as Claude thinking process blocks', async () => {
  await withTraeSseServer(
    (req, res) => {
      assert.strictEqual(req.url, '/v1/chat/stream');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(
        'event: raw_event\ndata: {"ts":1234,"service":"chat","method":"chat","channelId":"c1","event":"plan_item","payload":{"id":"p1","thought":{"redacted":true,"chars":8},"agent_status":{"status":"running"},"tool_call_info":{"id":"t1","name":"run_command","result":{"status":"success"}}}}\n\n'
      );
      res.write(
        'event: raw_event\ndata: {"ts":1235,"service":"chat","method":"chat","event":"timing_events","payload":{"model_name":"minimax-m3","data":{"svr_10_first_sse_event_timing":31,"svr_11_server_processing_time":88}}}\n\n'
      );
      res.write('event: text_delta\ndata: {"text":"done"}\n\n');
      res.end('event: done\ndata: {"ok":true,"text":"done"}\n\n');
    },
    async (baseUrl) => {
      const runtime = createFakeTraeRuntime(baseUrl, {
        rawProgressMode: 'claude-process',
        liveHeartbeatMs: 0,
        writeClaudeSseEvent: (clientRes, event, data) => {
          clientRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        },
      });
      const chunks = [];
      const clientRes = {
        writeHead(statusCode, headers) {
          this.statusCode = statusCode;
          this.headers = headers;
        },
        write(chunk) {
          chunks.push(String(chunk));
        },
        end() {
          this.ended = true;
        },
      };
      await runtime.writeTraeBridgeClaudeLiveStream(
        clientRes,
        { model: 'trae/gpt-5.4', stream: true },
        { prompt: 'hello', model: 'gpt-5.4' },
        'gpt-5.4'
      );
      const output = chunks.join('');
      assert.ok(output.includes('"content_block":{"type":"thinking"'));
      assert.ok(output.includes('"type":"thinking_delta"'));
      assert.ok(output.includes('[Trae plan_item tool=run_command status=success'));
      assert.ok(output.includes('[Trae timing model=minimax-m3 first_sse=31ms server=88ms]'));
      assert.ok(output.includes('"type":"signature_delta","signature":"trae-process"'));
      assert.ok(output.includes('"content_block":{"type":"text","text":""}'));
      assert.ok(output.includes('"delta":{"type":"text_delta","text":"done"}'));
      assert.ok(output.indexOf('"type":"thinking_delta"') < output.indexOf('"type":"text_delta"'));
      assert.ok(!output.includes(': trae-raw'));
    }
  );
});

test('can surface Trae raw progress as separate Claude text process blocks', async () => {
  await withTraeSseServer(
    (req, res) => {
      assert.strictEqual(req.url, '/v1/chat/stream');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(
        'event: raw_event\ndata: {"event":"plan_item","payload":{"agent_status":{"status":"running"},"tool_call_info":{"name":"read_file","result":{"status":"success"}}}}\n\n'
      );
      res.write('event: text_delta\ndata: {"text":"answer"}\n\n');
      res.end('event: done\ndata: {"ok":true,"text":"answer"}\n\n');
    },
    async (baseUrl) => {
      const runtime = createFakeTraeRuntime(baseUrl, {
        rawProgressMode: 'claude-text',
        liveHeartbeatMs: 0,
        writeClaudeSseEvent: (clientRes, event, data) => {
          clientRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        },
      });
      const chunks = [];
      const clientRes = {
        writeHead(statusCode) {
          this.statusCode = statusCode;
        },
        write(chunk) {
          chunks.push(String(chunk));
        },
        end() {
          this.ended = true;
        },
      };
      await runtime.writeTraeBridgeClaudeLiveStream(
        clientRes,
        { model: 'trae/gpt-5.4', stream: true },
        { prompt: 'hello', model: 'gpt-5.4' },
        'gpt-5.4'
      );
      const output = chunks.join('');
      assert.ok(!output.includes('"type":"thinking_delta"'));
      assert.ok(!output.includes('"type":"signature_delta"'));
      assert.ok(output.includes('"content_block":{"type":"text","text":""}'));
      assert.ok(output.includes('Trae read_file: success'));
      assert.ok(output.includes('"delta":{"type":"text_delta","text":"answer"}'));
      assert.ok(output.indexOf('Trae read_file') < output.indexOf('"text":"answer"'));
    }
  );
});

test('can surface Trae process text for one Claude request without global debug switch', async () => {
  await withTraeSseServer(
    (req, res) => {
      assert.strictEqual(req.url, '/v1/chat/stream');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(
        'event: raw_event\ndata: {"event":"plan_item","payload":{"agent_status":{"status":"running"},"tool_call_info":{"name":"read_file","result":{"status":"success"}}}}\n\n'
      );
      res.write('event: text_delta\ndata: {"text":"answer"}\n\n');
      res.end('event: done\ndata: {"ok":true,"text":"answer"}\n\n');
    },
    async (baseUrl) => {
      const runtime = createFakeTraeRuntime(baseUrl, {
        liveHeartbeatMs: 0,
        writeClaudeSseEvent: (clientRes, event, data) => {
          clientRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        },
      });
      const chunks = [];
      const clientRes = {
        writeHead(statusCode) {
          this.statusCode = statusCode;
        },
        write(chunk) {
          chunks.push(String(chunk));
        },
        end() {
          this.ended = true;
        },
      };
      await runtime.writeTraeBridgeClaudeLiveStream(
        clientRes,
        { model: 'claude-opus-4-8', stream: true },
        { prompt: 'hello', model: 'minimax-m3' },
        'minimax-m3',
        { claudeProcessStyle: 'text' }
      );
      const output = chunks.join('');
      assert.ok(!output.includes('"type":"thinking_delta"'));
      assert.ok(output.includes('"content_block":{"type":"text","text":""}'));
      assert.ok(output.includes('Trae read_file: success'));
      assert.ok(output.includes('"delta":{"type":"text_delta","text":"answer"}'));
      assert.ok(output.indexOf('Trae read_file') < output.indexOf('"text":"answer"'));
    }
  );
});

test('formats real Trae raw stream shape into concise Claude-visible process text', async () => {
  await withTraeSseServer(
    (req, res) => {
      assert.strictEqual(req.url, '/v1/chat/stream');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      const nestedPlan = {
        ts: 1234,
        event: 'plan_item',
        payload: {
          event: 'plan_item',
          payload: {
            id: '6a2716b805d6ed9f5b87cfc9',
            task_id: '6a2716b805d6ed9f5b87cfc1',
            reasoning_content: { redacted: true, chars: 27 },
            thought: { redacted: true, chars: 2 },
            agent_status: { status: 'running', run_mode: 'foreground' },
            tool_call_info: {
              id: 'tool-1',
              name: 'run_command',
              params: { command: 'git status' },
              result: {},
            },
          },
        },
      };
      const flatPlan = {
        ts: 1234,
        sessionId: 'session-1',
        agentMessageId: 'message-1',
        event: 'plan_item',
        payload: nestedPlan.payload.payload,
      };
      res.write(
        'event: raw_event\ndata: ' +
          JSON.stringify({
            ts: 1233,
            event: 'metadata',
            payload: {
              event: 'metadata',
              payload: {
                metadata_status: 'done',
                request_client: 'AhaNet',
                agent_task_service_strategy: 'cloud_agent',
                agent_name: 'Agent',
                user_message_context: {
                  model_info: { model_name: 'minimax-m3', config_name: 'minimax-m3' },
                },
              },
            },
          }) +
          '\n\n'
      );
      res.write('event: raw_event\ndata: ' + JSON.stringify(nestedPlan) + '\n\n');
      res.write('event: raw_event\ndata: ' + JSON.stringify(flatPlan) + '\n\n');
      res.write(
        'event: raw_event\ndata: ' +
          JSON.stringify({
            ts: 1235,
            event: 'token_usage',
            payload: {
              input: 12,
              output: 3,
              prompt_tokens: 120,
              completion_tokens: 3,
              total_tokens: 123,
              reasoning_tokens: 9,
            },
          }) +
          '\n\n'
      );
      res.write(
        'event: raw_event\ndata: ' +
          JSON.stringify({
            ts: 1236,
            event: 'timing_events',
            payload: {
              model_name: 'minimax-m3',
              data: {
                svr_01_queue_timing: 2,
                svr_10_first_sse_event_timing: 31,
                svr_11_server_processing_time: 88,
                svr_11_gateway_server_processing_time: 91,
              },
            },
          }) +
          '\n\n'
      );
      res.write(
        'event: raw_event\ndata: ' +
          JSON.stringify({
            ts: 1237,
            event: 'done',
            payload: { status: 'completed', chat_start_time: 1000, chat_end_time: 1123 },
          }) +
          '\n\n'
      );
      res.write('event: text_delta\ndata: {"text":"OK"}\n\n');
      res.end('event: done\ndata: {"ok":true,"text":"OK"}\n\n');
    },
    async (baseUrl) => {
      const runtime = createFakeTraeRuntime(baseUrl, {
        liveHeartbeatMs: 0,
        writeClaudeSseEvent: (clientRes, event, data) => {
          clientRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        },
      });
      const chunks = [];
      const clientRes = {
        writeHead(statusCode) {
          this.statusCode = statusCode;
        },
        write(chunk) {
          chunks.push(String(chunk));
        },
        end() {
          this.ended = true;
        },
      };
      await runtime.writeTraeBridgeClaudeLiveStream(
        clientRes,
        { model: 'claude-opus-4-8', stream: true },
        { prompt: 'hello', model: 'minimax-m3' },
        'minimax-m3',
        { claudeProcessStyle: 'text' }
      );
      const output = chunks.join('');
      assert.ok(
        output.includes('Trae 已连接: Agent Agent · 模型 minimax-m3 · 客户端 AhaNet · 状态 done')
      );
      assert.ok(output.includes('Trae run_command: running · foreground'));
      assert.strictEqual((output.match(/Trae run_command: running/g) || []).length, 1);
      assert.ok(output.includes('Trae Token 用量 · total=123 · reasoning=9'));
      assert.ok(output.includes('Trae 时延: 首包 31ms · 服务 88ms'));
      assert.ok(output.includes('Trae 完成: completed · 123ms'));
      assert.ok(output.includes('"delta":{"type":"text_delta","text":"OK"}'));
    }
  );
});

test('surfaces Trae native deep progress as Claude content deltas', async () => {
  await withTraeSseServer(
    (req, res) => {
      assert.strictEqual(req.url, '/v1/chat/stream');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write('event: text_delta\ndata: {"text":"done"}\n\n');
      res.end('event: done\ndata: {"ok":true,"text":"done"}\n\n');
    },
    async (baseUrl) => {
      const runtime = createFakeTraeRuntime(baseUrl, {
        liveHeartbeatMs: 0,
        rawProgressMode: 'visible',
        writeClaudeSseEvent: (clientRes, event, data) => {
          clientRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        },
        startNativeDeepProgress: (writeVisibleText) => {
          writeVisibleText(
            '[Trae native_response_chunk url=coresg-normal.trae.ai/api/agent/v3/create_agent_task bytes=648 signals=reasoning,task]'
          );
          return () => {};
        },
      });
      const chunks = [];
      const clientRes = {
        writeHead(statusCode, headers) {
          this.statusCode = statusCode;
          this.headers = headers;
        },
        write(chunk) {
          chunks.push(String(chunk));
        },
        end() {
          this.ended = true;
        },
      };
      await runtime.writeTraeBridgeClaudeLiveStream(
        clientRes,
        { model: 'trae/gpt-5.4', stream: true },
        { prompt: 'hello', model: 'gpt-5.4' },
        'gpt-5.4'
      );
      const output = chunks.join('');
      assert.ok(output.includes('event: content_block_delta'));
      assert.ok(output.includes('[Trae native_response_chunk'));
      assert.ok(output.includes('signals=reasoning,task'));
      assert.ok(output.includes('"text":"done"'));
    }
  );
});

test('does not inject Trae native deep progress into Claude content by default', async () => {
  await withTraeSseServer(
    (req, res) => {
      assert.strictEqual(req.url, '/v1/chat/stream');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write('event: text_delta\ndata: {"text":"done"}\n\n');
      res.end('event: done\ndata: {"ok":true,"text":"done"}\n\n');
    },
    async (baseUrl) => {
      let nativePumpStarted = false;
      const runtime = createFakeTraeRuntime(baseUrl, {
        liveHeartbeatMs: 0,
        writeClaudeSseEvent: (clientRes, event, data) => {
          clientRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        },
        startNativeDeepProgress: () => {
          nativePumpStarted = true;
          return () => {};
        },
      });
      const chunks = [];
      const clientRes = {
        writeHead(statusCode) {
          this.statusCode = statusCode;
        },
        write(chunk) {
          chunks.push(String(chunk));
        },
        end() {
          this.ended = true;
        },
      };
      await runtime.writeTraeBridgeClaudeLiveStream(
        clientRes,
        { model: 'trae/gpt-5.4', stream: true },
        { prompt: 'hello', model: 'gpt-5.4' },
        'gpt-5.4'
      );
      const output = chunks.join('');
      assert.strictEqual(nativePumpStarted, false);
      assert.ok(!output.includes('[Trae native_'));
      assert.ok(output.includes('"text":"done"'));
    }
  );
});

test('can surface Trae raw progress using runtime debug switch without restart', async () => {
  let debugSettings = { rawProgressMode: '', logProgressMode: '', liveLogProgress: false };
  await withTraeSseServer(
    (req, res) => {
      assert.strictEqual(req.url, '/v1/chat/stream');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(
        'event: raw_event\ndata: {"event":"plan_item","payload":{"agent_status":{"status":"running"},"tool_call_info":{"name":"run_command","result":{"status":"success"}}}}\n\n'
      );
      res.write('event: text_delta\ndata: {"text":"done"}\n\n');
      res.end('event: done\ndata: {"ok":true,"text":"done"}\n\n');
    },
    async (baseUrl) => {
      const runtime = createFakeTraeRuntime(baseUrl, {
        liveHeartbeatMs: 0,
        getTraeDebugSettings: () => debugSettings,
      });
      const firstChunks = [];
      const firstRes = {
        writeHead(statusCode) {
          this.statusCode = statusCode;
        },
        write(chunk) {
          firstChunks.push(String(chunk));
        },
        end() {
          this.ended = true;
        },
      };
      await runtime.writeTraeBridgeOpenAILiveStream(
        firstRes,
        { model: 'trae/gpt-5.4' },
        { prompt: 'hello', model: 'gpt-5.4' },
        'gpt-5.4'
      );
      assert.ok(!firstChunks.join('').includes('[Trae plan_item'));

      debugSettings = {
        rawProgressMode: 'visible',
        logProgressMode: 'visible',
        liveLogProgress: true,
      };
      const secondChunks = [];
      const secondRes = {
        writeHead(statusCode) {
          this.statusCode = statusCode;
        },
        write(chunk) {
          secondChunks.push(String(chunk));
        },
        end() {
          this.ended = true;
        },
      };
      await runtime.writeTraeBridgeOpenAILiveStream(
        secondRes,
        { model: 'trae/gpt-5.4' },
        { prompt: 'hello', model: 'gpt-5.4' },
        'gpt-5.4'
      );
      const output = secondChunks.join('');
      assert.ok(output.includes('[Trae plan_item tool=run_command status=success'));
      assert.ok(output.includes('"content":"done"'));
    }
  );
});

test('writes OpenAI live stream chunks from Trae bridge SSE', async () => {
  await withTraeSseServer(
    (req, res) => {
      assert.strictEqual(req.url, '/v1/chat/stream');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write('event: text_delta\ndata: {"text":"first"}\n\n');
      res.write('event: progress\ndata: {"phase":"running","elapsedMs":2000}\n\n');
      res.write(
        'event: interaction\ndata: {"interaction":{"type":"RunCommand","command":"dir","cwd":"E:/repo"}}\n\n'
      );
      res.end('event: done\ndata: {"ok":true,"text":"first"}\n\n');
    },
    async (baseUrl) => {
      const runtime = createFakeTraeRuntime(baseUrl);
      const chunks = [];
      const clientRes = {
        writeHead(statusCode, headers) {
          this.statusCode = statusCode;
          this.headers = headers;
        },
        write(chunk) {
          chunks.push(String(chunk));
        },
        end() {
          this.ended = true;
        },
      };
      await runtime.writeTraeBridgeOpenAILiveStream(
        clientRes,
        { model: 'trae/gpt-5.4' },
        { prompt: 'hello', model: 'gpt-5.4' },
        'gpt-5.4'
      );
      const output = chunks.join('');
      assert.strictEqual(clientRes.statusCode, 200);
      assert.ok(output.includes('"role":"assistant"'));
      assert.ok(output.includes('"content":"first"'));
      assert.ok(output.includes(': trae-progress {"phase":"running","elapsedMs":2000}'));
      assert.ok(output.includes('Trae 请求执行命令 cwd=E:/repo command=dir'));
      assert.ok(output.includes('data: [DONE]'));
      assert.strictEqual(clientRes.ended, true);
    }
  );
});

test('writes proxy heartbeat while Trae bridge is waiting for final text', async () => {
  await withTraeSseServer(
    (req, res) => {
      assert.strictEqual(req.url, '/v1/chat/stream');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      setTimeout(() => {
        res.write('event: text_delta\ndata: {"text":"late"}\n\n');
        res.end('event: done\ndata: {"ok":true,"text":"late"}\n\n');
      }, 80);
    },
    async (baseUrl) => {
      const runtime = createFakeTraeRuntime(baseUrl);
      const chunks = [];
      const clientRes = {
        writeHead(statusCode, headers) {
          this.statusCode = statusCode;
          this.headers = headers;
        },
        write(chunk) {
          chunks.push(String(chunk));
        },
        end() {
          this.ended = true;
        },
      };
      await runtime.writeTraeBridgeOpenAILiveStream(
        clientRes,
        { model: 'trae/gpt-5.4' },
        { prompt: 'hello', model: 'gpt-5.4' },
        'gpt-5.4'
      );
      const output = chunks.join('');
      const heartbeatIndex = output.indexOf(': trae-progress {"phase":"running"');
      const textIndex = output.indexOf('"content":"late"');
      assert.ok(heartbeatIndex >= 0);
      assert.ok(output.includes('"source":"proxy"'));
      assert.ok(textIndex > heartbeatIndex);
      assert.strictEqual(clientRes.ended, true);
    }
  );
});

test('finishes OpenAI live stream with visible Trae bridge error after headers are sent', async () => {
  await withTraeSseServer(
    (req, res) => {
      assert.strictEqual(req.url, '/v1/chat/stream');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.end(
        'event: error\ndata: {"error":"Now session is not waiting input, sessionId: test"}\n\n'
      );
    },
    async (baseUrl) => {
      const runtime = createFakeTraeRuntime(baseUrl, { liveHeartbeatMs: 0 });
      const chunks = [];
      const clientRes = {
        writeHead(statusCode, headers) {
          this.statusCode = statusCode;
          this.headers = headers;
        },
        write(chunk) {
          chunks.push(String(chunk));
        },
        end() {
          this.ended = true;
        },
      };
      await runtime.writeTraeBridgeOpenAILiveStream(
        clientRes,
        { model: 'trae/gpt-5.4' },
        { prompt: 'hello', model: 'gpt-5.4' },
        'gpt-5.4'
      );
      const output = chunks.join('');
      assert.strictEqual(clientRes.statusCode, 200);
      assert.ok(output.includes(': trae-progress {"phase":"error"'));
      assert.ok(
        output.includes('[Trae bridge busy: Now session is not waiting input, sessionId: test]')
      );
      assert.ok(output.includes('data: [DONE]'));
      assert.strictEqual(clientRes.ended, true);
    }
  );
});

test('writes redacted Trae log progress comments while waiting for final text', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-log-progress-'));
  const logRoot = path.join(tempRoot, '20260606T000000');
  const rendererDir = path.join(logRoot, 'window1');
  const modularDir = path.join(logRoot, 'Modular');
  fs.mkdirSync(rendererDir, { recursive: true });
  fs.mkdirSync(modularDir, { recursive: true });
  const rendererLog = path.join(rendererDir, 'renderer.log');
  const agentLog = path.join(modularDir, 'ai-agent_0_1_stdout.log');
  fs.writeFileSync(rendererLog, 'old renderer line\n');
  fs.writeFileSync(agentLog, 'old agent line\n');
  try {
    await withTraeSseServer(
      (req, res) => {
        assert.strictEqual(req.url, '/v1/chat/stream');
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        setTimeout(() => {
          fs.appendFileSync(
            rendererLog,
            '2026-06-06T00:00:00.001-07:00 [info] [tooling] [message:msg_1] 11111111-1111-4111-8111-111111111111 icube.common.commands.tooling.listFolder start \n'
          );
          fs.appendFileSync(
            rendererLog,
            '2026-06-06T00:00:00.002-07:00 [info] [tooling] 11111111-1111-4111-8111-111111111111 icube.common.commands.tooling.listFolder end, cost=3ms [{"code":"0"}]\n'
          );
          fs.appendFileSync(
            agentLog,
            '2026-06-06T00:00:00.003-07:00 INFO process_ipc_request:route:chat:do_chat: ai_agent::domain::plan::simple_service_v2: first token flushed thought, thought="", reasoning=Some("redacted") trace_id="trace_1" task_id=task_1 message_id=message_1\n'
          );
        }, 20);
        setTimeout(() => {
          res.write('event: text_delta\ndata: {"text":"late"}\n\n');
          res.end('event: done\ndata: {"ok":true,"text":"late"}\n\n');
        }, 420);
      },
      async (baseUrl) => {
        const runtime = createFakeTraeRuntime(baseUrl, {
          liveHeartbeatMs: 0,
          liveLogProgress: true,
          traeLogRoot: logRoot,
        });
        const chunks = [];
        const clientRes = {
          writeHead(statusCode, headers) {
            this.statusCode = statusCode;
            this.headers = headers;
          },
          write(chunk) {
            chunks.push(String(chunk));
          },
          end() {
            this.ended = true;
          },
        };
        await runtime.writeTraeBridgeOpenAILiveStream(
          clientRes,
          { model: 'trae/gpt-5.4' },
          { prompt: 'hello', model: 'gpt-5.4' },
          'gpt-5.4'
        );
        const output = chunks.join('');
        assert.ok(output.includes('"source":"trae-log"'));
        assert.ok(output.includes('"kind":"tool_start"'));
        assert.ok(output.includes('"kind":"tool_end"'));
        assert.ok(output.includes('"kind":"model_first_token"'));
        assert.ok(!output.includes('redacted'));
        assert.ok(output.indexOf('"kind":"tool_start"') < output.indexOf('"content":"late"'));
        assert.strictEqual(clientRes.ended, true);
      }
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Trae debug log collection bounds numeric options', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-log-bounds-'));
  const logRoot = path.join(tempRoot, '20260606T000000');
  fs.mkdirSync(logRoot, { recursive: true });
  fs.writeFileSync(
    path.join(logRoot, 'renderer.log'),
    [
      'body_len=999999999999 url=https://coresg-normal.trae.ai/api/agent/run?token=secret',
      'send chat',
      'before prepare loop',
    ].join('\n')
  );
  try {
    const oneEvent = collectLogEvents({ logRoot: tempRoot, limit: -100 });
    assert.strictEqual(oneEvent.length, 1);

    const events = collectLogEvents({ logRoot: tempRoot, limit: 'Infinity' });
    const requestShape = events.find((event) => event.kind === 'native_request_shape');
    assert.ok(requestShape);
    assert.strictEqual(requestShape.bodyLen, 1024 * 1024 * 1024);
    assert.ok(!requestShape.urlPath.includes('token=secret'));

    const snapshot = getNativeDeepEvents({ limit: 'Infinity' });
    assert.ok(Array.isArray(snapshot.events));
    const stop = startNativeDeepProgress(() => {}, { intervalMs: 'Infinity' });
    stop();
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('can surface Trae log progress as visible OpenAI stream text when explicitly enabled', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-log-visible-progress-'));
  const logRoot = path.join(tempRoot, '20260606T000000');
  const rendererDir = path.join(logRoot, 'window1');
  const modularDir = path.join(logRoot, 'Modular');
  fs.mkdirSync(rendererDir, { recursive: true });
  fs.mkdirSync(modularDir, { recursive: true });
  const rendererLog = path.join(rendererDir, 'renderer.log');
  const agentLog = path.join(modularDir, 'ai-agent_0_1_stdout.log');
  fs.writeFileSync(rendererLog, 'old renderer line\n');
  fs.writeFileSync(agentLog, 'old agent line\n');
  try {
    await withTraeSseServer(
      (req, res) => {
        assert.strictEqual(req.url, '/v1/chat/stream');
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        setTimeout(() => {
          fs.appendFileSync(
            rendererLog,
            '2026-06-06T00:00:00.001-07:00 [info] [tooling] [message:msg_1] 11111111-1111-4111-8111-111111111111 icube.common.commands.tooling.listFolder start \n'
          );
          fs.appendFileSync(
            agentLog,
            '2026-06-06T00:00:00.003-07:00 INFO process_ipc_request:route:chat:do_chat: ai_agent::domain::plan::simple_service_v2: first token flushed thought, thought="", reasoning=Some("redacted") trace_id="trace_1" task_id=task_1 message_id=message_1\n'
          );
        }, 20);
        setTimeout(() => {
          res.write('event: text_delta\ndata: {"text":"late"}\n\n');
          res.end('event: done\ndata: {"ok":true,"text":"late"}\n\n');
        }, 420);
      },
      async (baseUrl) => {
        const runtime = createFakeTraeRuntime(baseUrl, {
          liveHeartbeatMs: 0,
          liveLogProgress: true,
          liveLogProgressMode: 'visible',
          traeLogRoot: logRoot,
        });
        const chunks = [];
        const clientRes = {
          writeHead(statusCode, headers) {
            this.statusCode = statusCode;
            this.headers = headers;
          },
          write(chunk) {
            chunks.push(String(chunk));
          },
          end() {
            this.ended = true;
          },
        };
        await runtime.writeTraeBridgeOpenAILiveStream(
          clientRes,
          { model: 'trae/gpt-5.4' },
          { prompt: 'hello', model: 'gpt-5.4' },
          'gpt-5.4'
        );
        const output = chunks.join('');
        assert.ok(output.includes('Trae 正在调用工具: listFolder'));
        assert.ok(output.includes('Trae 模型开始输出'));
        assert.ok(output.includes('"content":"late"'));
        assert.ok(!output.includes('reasoning'));
        assert.ok(output.indexOf('Trae 正在调用工具') < output.indexOf('"content":"late"'));
      }
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

(async () => {
  for (const item of tests) {
    try {
      await item.fn();
      console.log('ok - ' + item.name);
    } catch (err) {
      console.error('not ok - ' + item.name);
      console.error(err.stack || err.message);
      process.exitCode = 1;
    }
  }
  if (process.exitCode) process.exit(process.exitCode);
  console.log('[trae-bridge-streams.test] ok');
  process.exit(0);
})();
