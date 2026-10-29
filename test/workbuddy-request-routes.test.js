'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const { findAvailablePorts } = require('./helpers/test-ports');
const { waitForProxyFixtureReady: ready } = require('./helpers/proxy-fixture-ready');
const WORKBUDDY_FIXTURE_STARTUP_TIMEOUT_MS = 60_000;

function request(port, requestPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, text }));
        res.on('error', reject);
      }
    );
    req.setTimeout(10000, () => req.destroy(new Error('Fixture request deadline')));
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
async function run(hostMode, policyVersion) {
  let received = 0;
  const upstream = http.createServer((req, res) => {
    received++;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
      );
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const [managementPort, ...ports] = await findAvailablePorts(4);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-workbuddy-contract-'));
  const env = createIsolatedTestEnv(process.env, dataDir);
  const hostCalls = path.join(dataDir, 'host-calls.txt');
  const sentCount = () =>
    hostMode
      ? fs.existsSync(hostCalls)
        ? fs.readFileSync(hostCalls, 'utf8').trim().split('\n').filter(Boolean).length
        : 0
      : received;
  const latestHostCall = () => {
    if (!hostMode || !fs.existsSync(hostCalls)) return null;
    const lines = fs.readFileSync(hostCalls, 'utf8').trim().split('\n').filter(Boolean);
    return lines.length > 0 ? JSON.parse(lines.at(-1)) : null;
  };
  const preload = path.join(dataDir, 'host-fixture.cjs');
  if (hostMode) {
    fs.writeFileSync(
      preload,
      `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      require(${JSON.stringify(path.resolve(__dirname, '../lib/proxy/workbuddy-official'))}).readWorkBuddyAuthInfo = () => ({ accessTokenEncrypted: true, uid: 'fixture' });
      require(${JSON.stringify(path.resolve(__dirname, '../lib/proxy/workbuddy-wbipc-client'))}).createWorkBuddyWbipcClient = () => ({ async request(params) {
        assert.deepEqual(Object.keys(params.headers).sort(), ['accept', 'content-type']);
        assert.equal(params.method, 'POST');
        assert.ok(params.path.endsWith('/chat/completions'));
        const body = JSON.parse(params.body);
        if (body.messages[0]?.content?.startsWith('You are a dedicated historical-context summarizer')) {
          assert.equal(body.stream, true, 'Host summaries require SSE even for JSON client compaction');
          assert.equal(body.tools, undefined);
          assert.equal(body.tool_choice, undefined);
          fs.appendFileSync(${JSON.stringify(hostCalls)}, JSON.stringify({ compactionSummary: true }) + '\\n');
          const { summaryFixture } = require(${JSON.stringify(path.resolve(__dirname, './helpers/compaction-summary-fixture'))});
          const { encodeWorkBuddyToolCompletion } = require(${JSON.stringify(path.resolve(__dirname, '../lib/proxy/workbuddy-mixed-tool-phase'))});
          return { ok: true, status: 200, headers: { 'content-type': 'text/event-stream' }, body: encodeWorkBuddyToolCompletion({
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: summaryFixture(body) } }],
            usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
          }, body.stream) };
        }
        assert.equal(body.stream, true);
        assert.equal(body.include, undefined);
        assert.equal(body.prompt_cache_key, undefined);
        assert.equal(body.reasoning, undefined);
        assert.ok(
          body.reasoning_effort == null ||
            ['low', 'medium', 'high', 'xhigh', 'max'].includes(body.reasoning_effort)
        );
        assert.ok(body.messages.every(m => m.role !== 'developer'));
        fs.appendFileSync(${JSON.stringify(hostCalls)}, JSON.stringify({
          reasoningEffort: body.reasoning_effort ?? null,
          hasInclude: Object.hasOwn(body, 'include'),
          hasPromptCacheKey: Object.hasOwn(body, 'prompt_cache_key'),
          hasReasoning: Object.hasOwn(body, 'reasoning'),
        }) + '\\n');
        if (body.messages.some(message => message.content === 'malformed-workbuddy-fixture')) {
          return { ok: true, status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'data: SECRET\\n\\n' };
        }
        const first = { id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok', function_call: { name: '', arguments: '' } }, finish_reason: '' }] };
        const last = { id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { function_call: { name: '', arguments: '' } }, finish_reason: 'stop' }] };
        return { ok: true, status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'data: ' + JSON.stringify(first) + '\\n\\ndata: ' + JSON.stringify(last) + '\\n\\ndata: [DONE]\\n\\n' };
      } });
    `
    );
  }
  fs.mkdirSync(env.PROXY_CONFIG_DIR, { recursive: true });
  const protocols = ['openai-chat', 'openai-responses', 'claude'];
  fs.writeFileSync(
    path.join(env.PROXY_CONFIG_DIR, 'proxy.config.json'),
    JSON.stringify({
      activeProfile: 'fixture',
      localServer: {
        host: '127.0.0.1',
        listenPort: ports[0],
        managementPort,
        basePath: '/v1',
        protocol: protocols[0],
      },
      entryServers: protocols.map((protocol, index) => ({
        host: '127.0.0.1',
        listenPort: ports[index],
        basePath: '/v1',
        protocol,
        enabled: true,
        tls: false,
      })),
      profiles: [
        {
          id: 'fixture',
          protocol: 'workbuddy',
          authMode: hostMode ? 'official-login' : 'api-key',
          apiKey: 'fixture',
          targetUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
        },
      ],
      modelRoutes: [],
      appSettings: { conversationAuditEnabled: false, contextPolicyVersion: policyVersion },
    })
  );
  const child = spawn(
    process.execPath,
    [...(hostMode ? ['--require', preload] : []), path.resolve(__dirname, '../openai-proxy.js')],
    {
      env: { ...env, MGMT_PORT: String(managementPort), PROXY_DISABLE_CONVERSATION_AUDIT: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }
  );
  try {
    await ready(child, {
      setTimer: (callback) => setTimeout(callback, WORKBUDDY_FIXTURE_STARTUP_TIMEOUT_MS),
    });
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    for (let index = 0; index < ports.length; index++) {
      const requestPath = ['/v1/chat/completions', '/v1/responses', '/v1/messages'][index];
      const baseline = {
        model: 'deepseek-v4-flash',
        ...(index === 1 ? { input: 'hello' } : { messages: [{ role: 'user', content: 'hello' }] }),
        ...(index === 2 ? { max_tokens: 128 } : {}),
        tools:
          index === 2
            ? [{ name: 'SECRET', input_schema: schema }]
            : index === 1
              ? [{ type: 'function', name: 'SECRET', parameters: schema }]
              : [{ type: 'function', function: { name: 'SECRET', parameters: schema } }],
      };
      if (index === 1) {
        Object.assign(baseline, {
          include: ['reasoning.encrypted_content'],
          prompt_cache_key: 'fixture-thread',
          prompt_cache_retention: '24h',
          reasoning: { effort: 'medium', summary: 'auto', context: 'all_turns' },
        });
      }
      const formats =
        index === 2
          ? [{ output_config: { format: { type: 'json_schema', schema } } }]
          : index === 1
            ? [
                { text: { format: { type: 'json_schema', name: 'ok', schema } } },
                { text: { format: { type: 'json_object' } } },
              ]
            : [
                { response_format: { type: 'json_schema', json_schema: { name: 'ok', schema } } },
                { response_format: { type: 'json_object' } },
              ];
      const choices =
        index === 2
          ? [{ type: 'any' }, { type: 'tool', name: 'SECRET' }]
          : ['required', { type: 'function', function: { name: 'SECRET' } }];
      for (const stream of [false, true]) {
        for (const extra of [...formats, ...choices.map((tool_choice) => ({ tool_choice }))]) {
          const before = sentCount();
          const result = await request(ports[index], requestPath, {
            ...baseline,
            stream,
            ...extra,
          });
          assert.equal(result.status, 400);
          assert.equal(JSON.parse(result.text).error.type, 'invalid_request_error');
          assert.equal(
            JSON.parse(result.text).error.message,
            'Requested output format or tool choice cannot be preserved by this WorkBuddy model'
          );
          assert.ok(!result.text.includes('SECRET'));
          assert.equal(
            sentCount(),
            before,
            'Unsupported controls must fail before upstream dispatch'
          );
        }
        for (const choice of [undefined, 'auto', 'none']) {
          const before = sentCount();
          const tool_choice = index === 2 && choice ? { type: choice } : choice;
          const result = await request(ports[index], requestPath, {
            ...baseline,
            stream,
            tool_choice,
          });
          assert.equal(result.status, 200);
          assert.ok(result.text.includes('ok'));
          assert.equal(sentCount(), before + 1);
          if (hostMode && index === 1) {
            assert.deepEqual(latestHostCall(), {
              reasoningEffort: 'medium',
              hasInclude: false,
              hasPromptCacheKey: false,
              hasReasoning: false,
            });
          }
          if (stream && index === 1) {
            assert.ok(
              result.text.includes('event: response.completed'),
              'Responses stream must complete authoritatively'
            );
            assert.ok(!result.text.includes('event: error'));
            assert.ok(!result.text.includes('event: response.failed'));
          }
          if (stream && index === 2) {
            assert.ok(result.text.includes('message_stop'));
            assert.ok(!result.text.includes('event: error'));
          }
        }
      }
    }
    if (hostMode) {
      for (const effort of ['low', 'high', 'xhigh', 'max']) {
        const before = sentCount();
        const result = await request(ports[1], '/v1/responses', {
          model: 'deepseek-v4.1-flash',
          input: 'hello',
          reasoning: { effort, summary: 'auto' },
        });
        assert.equal(result.status, 200);
        assert.equal(sentCount(), before + 1);
        assert.equal(latestHostCall().reasoningEffort, effort);
      }
      for (const summary of ['auto', 'concise', 'detailed']) {
        const before = sentCount();
        const result = await request(ports[1], '/v1/responses', {
          model: 'deepseek-v4.1-flash',
          input: 'hello',
          reasoning: { effort: 'medium', summary },
        });
        assert.equal(result.status, 200);
        assert.equal(sentCount(), before + 1);
        assert.deepEqual(latestHostCall(), {
          reasoningEffort: 'medium',
          hasInclude: false,
          hasPromptCacheKey: false,
          hasReasoning: false,
        });
      }
      for (const context of ['auto', 'current_turn', 'all_turns']) {
        const before = sentCount();
        const result = await request(ports[1], '/v1/responses', {
          model: 'deepseek-v4.1-flash',
          input: 'hello',
          reasoning: { effort: 'medium', summary: 'detailed', context },
        });
        assert.equal(result.status, 200);
        assert.equal(sentCount(), before + 1);
        assert.deepEqual(latestHostCall(), {
          reasoningEffort: 'medium',
          hasInclude: false,
          hasPromptCacheKey: false,
          hasReasoning: false,
        });
      }
    }
    for (const incompatible of [
      { include: ['reasoning.encrypted_content', 'unknown'] },
      { prompt_cache_key: 'x'.repeat(65) },
      { prompt_cache_retention: '7d' },
      { reasoning: { summary: 'auto' } },
      { reasoning: { effort: 'medium', summary: 'full' } },
      { reasoning: { effort: 'medium', context: '' } },
      { reasoning: { effort: 'medium', context: 'all-turns' } },
      { reasoning: { effort: 'medium', context: 'x'.repeat(4096) } },
      { reasoning: { effort: 'medium', context: { value: 'all_turns' } } },
    ]) {
      const before = sentCount();
      const result = await request(ports[1], '/v1/responses', {
        model: 'deepseek-v4.1-flash',
        input: 'hello',
        ...incompatible,
      });
      assert.equal(result.status, 400);
      assert.equal(JSON.parse(result.text).error.type, 'invalid_request_error');
      assert.equal(sentCount(), before, 'Invalid compatibility controls must not dispatch');
    }
    if (hostMode) {
      // The same large, complete history must succeed through legacy planning
      // and fail before host dispatch when automatic planning is disabled.
      for (let index = 0; index < ports.length; index++) {
        const messages = [{ role: 'user', content: 'native-capacity-fixture' }];
        const input = [{ role: 'user', content: 'native-capacity-fixture' }];
        for (let round = 0; round < 6; round++) {
          const id = 'native-fixture-' + round;
          const output = 'synthetic-evidence'.repeat(6000);
          if (index === 2)
            messages.push(
              { role: 'assistant', content: [{ type: 'tool_use', id, name: 'read', input: {} }] },
              { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output }] }
            );
          else
            messages.push(
              {
                role: 'assistant',
                tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{}' } }],
              },
              { role: 'tool', tool_call_id: id, content: output }
            );
          input.push(
            { type: 'function_call', call_id: id, name: 'read', arguments: '{}' },
            { type: 'function_call_output', call_id: id, output }
          );
        }
        messages.push({ role: 'user', content: 'continue' });
        input.push({ role: 'user', content: 'continue' });
        const tool = { name: 'read', parameters: { type: 'object' } };
        const before = sentCount();
        const result = await request(
          ports[index],
          ['/v1/chat/completions', '/v1/responses', '/v1/messages'][index],
          {
            model: 'deepseek-v4-flash',
            ...(index === 1 ? { input } : { messages }),
            ...(index === 2 ? { max_tokens: 128 } : {}),
            tools:
              index === 2
                ? [{ name: tool.name, input_schema: tool.parameters }]
                : index === 1
                  ? [{ type: 'function', ...tool }]
                  : [{ type: 'function', function: tool }],
          }
        );
        if (policyVersion === 2) {
          assert.ok([400, 413].includes(result.status), result.text);
          assert.ok(
            ['context_length_exceeded', 'workbuddy_request_too_large'].includes(
              JSON.parse(result.text).error.code
            )
          );
          assert.equal(
            sentCount(),
            before,
            'Native admission must not dispatch, summarize or retry'
          );
        } else {
          assert.equal(result.status, 200, result.text);
          assert.ok(sentCount() > before);
        }
      }
      for (const compactPath of ['/v1/responses/compact', '/responses/compact?fixture=1']) {
        const before = sentCount();
        const history = [
          { role: 'user', content: '保留约束🙂' + compactPath, future: { exact: true } },
          ...['old', 'recent1', 'recent2'].flatMap((call_id) => [
            { type: 'function_call', call_id, name: 'read', arguments: '{}' },
            { type: 'function_call_output', call_id, output: call_id },
          ]),
        ];
        const response = await request(ports[1], compactPath, {
          model: 'deepseek-v4-flash',
          input: history,
        });
        assert.equal(response.status, 200, response.text);
        const compacted = JSON.parse(response.text);
        assert.equal(compacted.object, 'response.compaction');
        assert.equal(compacted.hpm_compaction.origin, 'hpm-local-compaction-v1');
        assert.deepEqual(
          compacted.output.find((item) => item.role === 'user'),
          history[0]
        );
        assert.deepEqual(compacted.usage, {
          input_tokens: 80,
          output_tokens: 20,
          total_tokens: 100,
        });
        assert.equal(sentCount(), before + 1);
        const next = await request(ports[1], '/v1/responses', {
          model: 'deepseek-v4-flash',
          input: [...compacted.output, { role: 'user', content: '继续🙂' }],
          stream: true,
          store: false,
        });
        assert.equal(next.status, 200, next.text);
        assert.ok(next.text.includes('event: response.completed'));
        assert.equal(sentCount(), before + 2);
      }
      for (const extra of [
        { stream: true },
        { previous_response_id: 'resp_untrusted' },
        { tools: [] },
      ]) {
        const before = sentCount();
        const response = await request(ports[1], '/v1/responses/compact', {
          model: 'deepseek-v4-flash',
          input: '要求🙂',
          ...extra,
        });
        assert.equal(response.status, 400);
        assert.equal(sentCount(), before);
      }
      const before = sentCount();
      const failure = await request(ports[1], '/v1/responses', {
        model: 'deepseek-v4-flash',
        input: 'malformed-workbuddy-fixture',
        stream: true,
      });
      assert.equal(failure.status, 502);
      assert.equal(JSON.parse(failure.text).error.type, 'api_error');
      assert.ok(!failure.text.includes('SECRET'));
      assert.equal(sentCount(), before + 1, 'Malformed stream must not retry or dispatch twice');
      assert.equal(received, 0, 'Encrypted credentials must never select direct HTTP');
    } else {
      const before = sentCount();
      const response = await request(ports[1], '/v1/responses/compact', {
        model: 'deepseek-v4-flash',
        input: '要求🙂',
      });
      assert.equal(response.status, 501);
      assert.equal(sentCount(), before);
    }
    process.stdout.write(
      `workbuddy-request-routes.test.js passed (${hostMode ? 'host' : 'api-key'})\n`
    );
  } finally {
    if (child.exitCode == null && child.signalCode == null) {
      const stopped = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await stopped;
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    assert.equal(path.dirname(dataDir), os.tmpdir());
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
async function main() {
  await run(false);
  await run(true);
  await run(false, 2);
  await run(true, 2);
}
main().catch((error) => {
  process.stderr.write(String(error.stack) + '\n');
  process.exitCode = 1;
});
