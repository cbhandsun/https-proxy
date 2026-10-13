'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const { findAvailablePorts } = require('./helpers/test-ports');
const { waitForProxyFixtureReady: ready } = require('./helpers/proxy-fixture-ready');
const { prepareProxyFixtureSecret } = require('./helpers/proxy-fixture-secret');
function request(port, requestPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        // This large protocol matrix tests independent requests; socket request limits
        // have their own transport regressions and must not truncate this fixture.
        agent: false,
        path: requestPath,
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode,
              body: String(res.headers['content-type']).includes('text/event-stream')
                ? text
                : JSON.parse(text),
            });
          } catch {
            reject(
              new Error(
                `Fixture received non-JSON response: status=${res.statusCode}, endpoint=${requestPath}, model=${body.model}, stream=${body.stream}, customHistory=${Array.isArray(body.input) && body.input.some((item) => item.type === 'custom_tool_call')}`
              )
            );
          }
        });
      }
    );
    req.setTimeout(10000, () => req.destroy(new Error('Fixture deadline')));
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
async function main() {
  const upstream = http.createServer((req, res) => {
    assert.ok(
      req.headers.authorization === 'Bearer fixture' || req.headers['x-api-key'] === 'fixture',
      'Synthetic persisted credential must decrypt before upstream dispatch'
    );
    calls++;
    let text = '';
    req.on('data', (chunk) => {
      text += chunk;
    });
    req.on('end', () => {
      const requestBody = JSON.parse(text);
      lastShape = {
        path: req.url,
        chatFormat: requestBody.response_format?.type,
        responsesFormat: requestBody.text?.format?.type,
        reasoningEffort: requestBody.reasoning?.effort,
        claudeEffort: requestBody.output_config?.effort,
        thinkingType: requestBody.thinking?.type,
        thinkingBudget: requestBody.thinking?.budget_tokens,
        outputLimit: requestBody.max_tokens,
        wireLengthMatches: Number(req.headers['content-length']) === Buffer.byteLength(text),
        nativeInputTypes: Array.isArray(requestBody.input)
          ? requestBody.input.map((item) => item.type || 'message')
          : null,
        nativeMessageRoles: Array.isArray(requestBody.input)
          ? requestBody.input.filter((item) => item.role).map((item) => item.role)
          : [],
        nativeSearchQueriesMatch:
          Array.isArray(requestBody.input) &&
          requestBody.input.some(
            (item) =>
              item.type === 'web_search_call' &&
              !Object.hasOwn(item.action, 'query') &&
              JSON.stringify(item.action.queries) === '["fixture-query"]'
          ),
        nativeImageUrlLengths: Array.isArray(requestBody.input)
          ? requestBody.input.flatMap((item) =>
              Array.isArray(item.content)
                ? item.content
                    .filter(
                      (part) => part.type === 'input_image' && typeof part.image_url === 'string'
                    )
                    .map((part) => part.image_url.length)
                : []
            )
          : [],
        nativeToolParts: Array.isArray(requestBody.input)
          ? requestBody.input.flatMap((item) =>
              Array.isArray(item.output) ? item.output.map((part) => part.type) : []
            )
          : [],
        assistantToolId: requestBody.messages?.find(
          (message) => message.role === 'assistant' && message.tool_calls?.length
        )?.tool_calls[0]?.id,
      };
      const legacy = requestBody.messages?.at(-1)?.content === 'legacy-fixture';
      const legacyFunction = { name: 'probe', arguments: '{"ok":true}' };
      const nativeResponses = /\/responses$/.test(req.url);
      const jsonMode =
        requestBody.response_format?.type === 'json_object' ||
        requestBody.text?.format?.type === 'json_object';
      const content = jsonMode ? '   ' : 'ok';
      const nativeResponse = {
        id: 'fixture',
        object: 'response',
        status: 'completed',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] },
        ],
      };
      if (/\/messages$/.test(req.url)) {
        const message = {
          id: 'fixture',
          type: 'message',
          role: 'assistant',
          model: 'deepseek-v4-flash',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        if (requestBody.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const event of [
            { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 1 },
            },
            { type: 'message_stop' },
          ])
            res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(message));
        }
        return;
      }
      if (requestBody.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (nativeResponses) {
          res.write(
            'data: ' +
              JSON.stringify({ type: 'response.output_text.delta', delta: content }) +
              '\n\n'
          );
          res.end(
            'data: ' +
              JSON.stringify({ type: 'response.completed', response: nativeResponse }) +
              '\n\ndata: [DONE]\n\n'
          );
          return;
        }
        if (legacy) {
          for (const [delta, finish_reason] of [
            [{ function_call: { name: 'pro', arguments: '{"ok":' } }, null],
            [{ function_call: { name: 'be', arguments: 'true}' } }, null],
            [{}, 'function_call'],
          ])
            res.write(
              'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'
            );
          res.end('data: [DONE]\n\n');
          return;
        }
        for (const [delta, finish_reason] of [
          [{ content: '   ' }, null],
          [{}, 'stop'],
        ]) {
          res.write(
            'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'
          );
        }
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (nativeResponses) {
        res.end(JSON.stringify(nativeResponse));
        return;
      }
      if (legacy) {
        res.end(
          JSON.stringify({
            id: 'chatcmpl_legacy',
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                finish_reason: 'function_call',
                message: { role: 'assistant', content: null, function_call: legacyFunction },
              },
            ],
          })
        );
        return;
      }
      res.end(
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion',
          model: 'deepseek-v4-flash',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: requestBody.response_format?.type === 'json_object' ? '   ' : 'ok',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      );
    });
  });
  let calls = 0;
  let lastShape;
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-deepseek-contract-'));
  const env = createIsolatedTestEnv(process.env, directory);
  const ports = await findAvailablePorts(4);
  const preload = path.join(directory, 'upstream-fixture.cjs');
  fs.writeFileSync(
    preload,
    `const https = require('node:https'); const http = require('node:http'); const original = https.request;
    https.request = function(options, ...args) {
      if (options.hostname === 'api.deepseek.com') return http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1', port: ${upstream.address().port}, agent: undefined }, ...args);
      throw new Error('Fixture blocked unexpected external request');
    };`
  );
  fs.mkdirSync(env.PROXY_CONFIG_DIR, { recursive: true });
  const protocols = ['openai-chat', 'openai-responses', 'claude'];
  const profiles = [
    {
      id: 'chat',
      protocol: 'openai',
      forceChatCompletions: true,
      targetUrl: 'https://api.deepseek.com/v1',
    },
    { id: 'claude', protocol: 'claude', targetUrl: 'https://api.deepseek.com/anthropic' },
    {
      id: 'responses',
      protocol: 'openai',
      api: 'openai-responses',
      targetUrl: 'https://api.deepseek.com',
    },
    { id: 'native-default', protocol: 'openai', targetUrl: 'https://api.deepseek.com/v1' },
  ].map((profile) => ({
    ...profile,
    apiKey: prepareProxyFixtureSecret(env, 'fixture'),
    authMode: 'api-key',
  }));
  fs.writeFileSync(
    path.join(env.PROXY_CONFIG_DIR, 'proxy.config.json'),
    JSON.stringify({
      activeProfile: 'chat',
      profiles,
      modelRoutes: profiles.map((profile) => ({
        from: `fixture-${profile.id}`,
        to: 'deepseek-v4-flash',
        profileId: profile.id,
      })),
      localServer: {
        host: '127.0.0.1',
        listenPort: ports[0],
        managementPort: ports[3],
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
      appSettings: { conversationAuditEnabled: false },
      diagnostics: { enabled: false },
    })
  );
  const child = spawn(
    process.execPath,
    ['--require', preload, path.resolve(__dirname, '../openai-proxy.js')],
    {
      env: { ...env, MGMT_PORT: String(ports[3]) },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }
  );
  try {
    await ready(child);
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    for (const profile of profiles) {
      for (let index = 0; index < 3; index++) {
        const baseline = {
          model: `fixture-${profile.id}`,
          ...(index === 1
            ? { input: 'hello' }
            : { messages: [{ role: 'user', content: 'hello' }] }),
          ...(index === 2 ? { max_tokens: 128 } : {}),
        };
        const format =
          index === 0
            ? { response_format: { type: 'json_schema', json_schema: { name: 'ok', schema } } }
            : index === 1
              ? { text: { format: { type: 'json_schema', name: 'ok', schema } } }
              : { output_config: { format: { type: 'json_schema', schema } } };
        for (const stream of [false, true]) {
          const before = calls;
          const result = await request(
            ports[index],
            ['/v1/chat/completions', '/v1/responses', '/v1/messages'][index],
            { ...baseline, stream, ...format }
          );
          assert.equal(result.status, 400);
          assert.equal(result.body.error.type, 'invalid_request_error');
          assert.match(result.body.error.message, /DeepSeek/);
          assert.equal(calls, before, 'Unsupported schemas must never dispatch upstream');
        }
      }
    }
    const normal = await request(ports[0], '/v1/chat/completions', {
      model: 'fixture-chat',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    });
    assert.equal(normal.status, 200);
    assert.equal(normal.body.choices[0].message.content, 'ok');
    assert.equal(calls, 1);
    const invalidJson = await request(ports[1], '/v1/responses', {
      model: 'fixture-chat',
      input: 'hello',
      stream: false,
      text: { format: { type: 'json_object' } },
    });
    assert.equal(invalidJson.status, 502, JSON.stringify(lastShape));
    assert.ok(invalidJson.body.error);
    assert.equal(calls, 2);
    const continuation = await request(ports[1], '/v1/responses', {
      model: 'fixture-chat',
      input: 'continue',
      previous_response_id: 'fixture',
    });
    assert.equal(continuation.status, 400);
    assert.equal(calls, 2, 'Invalid JSON output must not create continuable history');
    const invalidStream = await request(ports[1], '/v1/responses', {
      model: 'fixture-chat',
      input: 'hello',
      stream: true,
      text: { format: { type: 'json_object' } },
    });
    assert.equal(invalidStream.status, 200);
    const events = invalidStream.body
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)));
    const failures = events.filter((event) => event.type === 'response.failed');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].response.error.code, 'upstream_invalid_json_object');
    assert.equal(
      events.some((event) => event.type === 'response.completed'),
      false
    );
    const afterStream = calls;
    const streamContinuation = await request(ports[1], '/v1/responses', {
      model: 'fixture-chat',
      input: 'continue',
      previous_response_id: failures[0].response.id,
    });
    assert.equal(streamContinuation.status, 400);
    assert.equal(calls, afterStream, 'Failed JSON stream must not create continuable history');
    for (const [port, endpoint, model, format] of [
      [
        ports[0],
        '/v1/chat/completions',
        'fixture-chat',
        { response_format: { type: 'json_object' } },
      ],
      [
        ports[1],
        '/v1/responses',
        'fixture-responses',
        { text: { format: { type: 'json_object' } } },
      ],
      [
        ports[0],
        '/v1/chat/completions',
        'fixture-responses',
        { response_format: { type: 'json_object' } },
      ],
    ]) {
      for (const stream of [false, true]) {
        const result = await request(port, endpoint, {
          model,
          input: 'hello',
          messages: [{ role: 'user', content: 'hello' }],
          stream,
          ...format,
        });
        if (!stream) {
          assert.equal(result.status, 502, JSON.stringify(lastShape));
          assert.ok(result.body.error);
          if (model !== 'fixture-responses' || endpoint !== '/v1/chat/completions')
            assert.equal(result.body.error.code, 'upstream_invalid_json_object');
        } else {
          assert.equal(result.status, 200);
          assert.equal(typeof result.body, 'string');
          assert.equal(result.body.includes('upstream_invalid_json_object'), true);
          assert.equal(result.body.includes('response.completed'), false);
        }
      }
    }
    for (const stream of [false, true]) {
      const result = await request(ports[1], '/v1/responses', {
        model: 'fixture-chat',
        input: 'legacy-fixture',
        stream,
        text: { format: { type: 'json_object' } },
      });
      assert.equal(result.status, 200);
      const response = stream
        ? result.body
            .split('\n')
            .filter((line) => line.startsWith('data: {'))
            .map((line) => JSON.parse(line.slice(6)))
            .find((event) => event.type === 'response.completed')?.response
        : result.body;
      assert.equal(response?.status, 'completed');
      const tool = response.output.find((item) => item.type === 'function_call');
      assert.equal(tool?.name, 'probe');
      assert.equal(tool?.arguments, '{"ok":true}');
      assert.ok(tool.call_id);
      const continuation = await request(ports[1], '/v1/responses', {
        model: 'fixture-chat',
        previous_response_id: response.id,
        input: [{ type: 'function_call_output', call_id: tool.call_id, output: '{"ok":true}' }],
      });
      assert.equal(continuation.status, 200);
      assert.equal(
        lastShape.assistantToolId,
        tool.call_id,
        'Continuation must preserve the returned legacy call ID'
      );
    }
    const unsupportedControls = [
      { previous_response_id: 'SECRET' },
      { conversation: { id: 'SECRET' } },
      { store: true },
      { background: true },
      { parallel_tool_calls: false },
      { max_tool_calls: 1 },
      { service_tier: 'priority' },
      { metadata: { secret: 'SECRET' } },
      { include: ['reasoning.encrypted_content'] },
      { truncation: 'auto' },
      { prompt: { id: 'SECRET' } },
      { prompt_cache_key: 'SECRET' },
      { context_management: [{ type: 'compaction' }] },
      { stream_options: { include_obfuscation: false } },
      { reasoning: { summary: 'auto' } },
      { text: { verbosity: 'high' } },
    ];
    for (const [port, endpoint, model] of [
      [ports[1], '/v1/responses', 'fixture-responses'],
      [ports[1], '/v1/responses', 'fixture-native-default'],
      [ports[0], '/v1/chat/completions', 'fixture-responses'],
    ]) {
      for (const control of unsupportedControls) {
        for (const stream of [false, true]) {
          const before = calls;
          const result = await request(port, endpoint, {
            model,
            stream,
            input: 'hello',
            messages: [{ role: 'user', content: 'hello' }],
            ...control,
          });
          assert.equal(result.status, 400);
          assert.equal(result.body.error.type, 'invalid_request_error');
          assert.equal(JSON.stringify(result.body).includes('SECRET'), false);
          assert.equal(
            calls,
            before,
            'Ignored native Responses controls must not dispatch upstream'
          );
        }
      }
    }
    for (const [effort, expected] of Object.entries({
      none: undefined,
      minimal: 'low',
      low: 'low',
      medium: 'high',
      high: 'high',
      xhigh: 'high',
      max: 'max',
    })) {
      for (const index of [0, 1, 2]) {
        for (const stream of [false, true]) {
          const before = calls;
          const result = await request(
            ports[index],
            ['/v1/chat/completions', '/v1/responses', '/v1/messages'][index],
            {
              model: 'fixture-claude',
              stream,
              ...(index === 0
                ? {
                    messages: [{ role: 'user', content: 'hello' }],
                    reasoning_effort: effort,
                    max_tokens: 1024,
                  }
                : index === 1
                  ? { input: 'hello', reasoning: { effort }, max_output_tokens: 1024 }
                  : {
                      messages: [{ role: 'user', content: 'hello' }],
                      output_config: { effort },
                      max_tokens: 1024,
                    }),
            }
          );
          assert.equal(result.status, 200);
          assert.equal(calls, before + 1);
          assert.equal(lastShape.claudeEffort, expected);
          assert.equal(lastShape.thinkingType, effort === 'none' ? 'disabled' : 'enabled');
          assert.equal(lastShape.thinkingBudget, undefined);
          assert.equal(lastShape.outputLimit, 1024);
          assert.equal(lastShape.wireLengthMatches, true);
          if (index === 1 && stream) assert.match(result.body, /response.completed/);
        }
      }
    }
    for (const index of [0, 1, 2]) {
      const before = calls;
      const result = await request(
        ports[index],
        ['/v1/chat/completions', '/v1/responses', '/v1/messages'][index],
        {
          model: 'fixture-claude',
          max_tokens: 1024,
          ...(index === 1
            ? { input: 'hello' }
            : { messages: [{ role: 'user', content: 'hello' }] }),
          thinking: { type: 'enabled', budget_tokens: 2048 },
        }
      );
      assert.equal(result.status, 400);
      assert.equal(calls, before, 'Ignored absolute budgets must fail before upstream dispatch');
    }
    for (const model of ['fixture-responses', 'fixture-native-default']) {
      for (const stream of [false, true]) {
        const before = calls;
        const result = await request(ports[1], '/v1/responses', {
          model,
          stream,
          input: [
            {
              type: 'web_search_call',
              id: 'search-fixture',
              status: 'completed',
              action: { type: 'search', query: 'fixture-query' },
            },
            { role: 'user', content: 'continue' },
          ],
        });
        assert.equal(result.status, 200);
        assert.equal(calls, before + 1);
        assert.equal(lastShape.nativeSearchQueriesMatch, true);
        assert.equal(lastShape.wireLengthMatches, true);
        if (stream) assert.match(result.body, /response.completed/);
        for (const action of [
          { type: 'search', query: 'PRIVATE', queries: ['other'] },
          { type: 'search', queries: [1] },
        ]) {
          const prior = calls;
          const invalid = await request(ports[1], '/v1/responses', {
            model,
            stream,
            input: [{ type: 'web_search_call', action }],
          });
          assert.equal(invalid.status, 400);
          assert.equal(calls, prior);
          assert.doesNotMatch(JSON.stringify(invalid.body), /PRIVATE/);
        }
      }
      for (const stream of [false, true]) {
        const prefix = 'https://example.test/';
        const result = await request(ports[1], '/v1/responses', {
          model,
          stream,
          input: [
            {
              role: 'developer',
              content: [
                { type: 'input_text', text: 'fixture' },
                { type: 'input_image', image_url: prefix + 'x'.repeat(8192 - prefix.length) },
                { type: 'input_image', file_id: 'file-api-fixture' },
              ],
            },
            { role: 'user', content: 'continue' },
          ],
        });
        assert.equal(result.status, 200);
        assert.deepEqual(lastShape.nativeMessageRoles, ['developer', 'user']);
        assert.deepEqual(lastShape.nativeImageUrlLengths, [8192]);
        if (stream) assert.match(result.body, /response.completed/);
      }
      for (const stream of [false, true]) {
        const result = await request(ports[1], '/v1/responses', {
          model,
          stream,
          input: [
            {
              type: 'custom_tool_call',
              call_id: 'patch_1',
              name: 'apply_patch',
              input: '*** Begin Patch\n*** End Patch',
            },
            {
              type: 'custom_tool_call_output',
              call_id: 'patch_1',
              output: [
                { type: 'input_text', text: 'ok' },
                { type: 'input_image', image_url: 'data:image/png;base64,aGk=' },
              ],
            },
            { role: 'user', content: 'continue' },
          ],
        });
        assert.equal(result.status, 200);
        assert.deepEqual(lastShape.nativeInputTypes, [
          'custom_tool_call',
          'custom_tool_call_output',
          'message',
        ]);
        assert.deepEqual(lastShape.nativeToolParts, ['input_text', 'input_image']);
        if (stream) assert.match(result.body, /response.completed/);
      }
      for (const stream of [false, true]) {
        const result = await request(ports[1], '/v1/responses', {
          model,
          stream,
          input: 'hello',
          reasoning: { effort: 'max' },
        });
        assert.equal(result.status, 200);
        assert.equal(
          lastShape.reasoningEffort,
          'max',
          'Provider-native effort must survive preflight'
        );
      }
      for (const control of [
        {
          input: [
            {
              role: 'developer',
              content: [
                { type: 'input_image', image_url: 'https://example.test/' + 'x'.repeat(8193) },
              ],
            },
          ],
        },
        { input: [{ role: 'user', content: [{ type: 'input_image', file_id: 'SECRET' }] }] },
        {
          input: [
            { type: 'function_call', call_id: 'call_1', name: 'probe', arguments: '{SECRET' },
          ],
        },
        { input: [{ type: 'custom_tool_call', call_id: 'patch_1', name: 'SECRET', input: '' }] },
        { input: [{ type: 'custom_tool_call_output', call_id: 'missing', output: 'SECRET' }] },
        {
          input: [
            { type: 'function_call', call_id: 'call_1', name: 'probe', arguments: '{}' },
            {
              type: 'function_call_output',
              call_id: 'call_1',
              output: [{ type: 'input_text', text: 42 }],
            },
          ],
        },
        { reasoning: { effort: 'SECRET' } },
        { input: [{ type: 'function_call' }] },
        { input: [{ type: 'function_call_output', call_id: 7, output: 'SECRET' }] },
        {
          input: [
            { role: 'user', content: [{ type: 'input_image', image_url: 'javascript:SECRET' }] },
          ],
        },
      ]) {
        for (const stream of [false, true]) {
          const before = calls;
          const result = await request(ports[1], '/v1/responses', { model, stream, ...control });
          assert.equal(result.status, 400);
          assert.equal(result.body.error.type, 'invalid_request_error');
          assert.equal(JSON.stringify(result.body).includes('SECRET'), false);
          assert.equal(calls, before, 'Invalid native input must not dispatch upstream');
        }
      }
      const result = await request(ports[1], '/v1/responses', {
        model,
        stream: false,
        store: false,
        background: false,
        parallel_tool_calls: true,
        truncation: 'disabled',
        metadata: {},
        include: [],
        input: [
          { role: 'user', content: 'original' },
          { type: 'function_call', call_id: 'call_stateless', name: 'probe', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call_stateless', output: 'ok' },
          { role: 'user', content: 'continue' },
        ],
      });
      assert.equal(result.status, 200);
      assert.deepEqual(lastShape.nativeInputTypes, [
        'message',
        'function_call',
        'function_call_output',
        'message',
      ]);
    }
  } finally {
    const exited = child.exitCode === null ? once(child, 'exit') : null;
    if (exited) child.kill();
    if (exited) await exited;
    await new Promise((resolve) => upstream.close(resolve));
  }
}
main()
  .then(() => console.log('deepseek-request-routes.test.js passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
