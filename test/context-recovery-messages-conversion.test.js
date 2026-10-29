'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createContextRecoveryMessagesConversion,
} = require('../lib/proxy/context-recovery-messages-conversion');
const { recoveryConverters } = require('./helpers/recovery-converters');
const { exerciseLongHistoryConversion } = require('./helpers/recovery-long-conversion.cjs');

const request = (kind) => ({
  model: 'model',
  [kind === 'chat' ? 'messages' : 'input']: [{ role: 'user', content: '原文🙂' }],
});
const adapter = (kind, converters = recoveryConverters()) =>
  createContextRecoveryMessagesConversion({ kind, model: 'vendor/model', converters });
const tool = {
  type: 'tool_use',
  id: 'call-external',
  name: 'lookup',
  input: { exact: '原参数🙂' },
};
const payload = (content = [{ type: 'text', text: 'finished' }, tool]) => ({
  id: 'msg-1',
  type: 'message',
  role: 'assistant',
  model: 'model',
  content,
  stop_reason: content.some((x) => x.type === 'tool_use') ? 'tool_use' : 'end_turn',
  usage: { input_tokens: 2, output_tokens: 1 },
});
const envelope = (body, stream = false) => {
  if (!stream) return { statusCode: 200, stream, wire: Buffer.from(JSON.stringify(body)) };
  const events = [{ type: 'message_start', message: { ...body, content: [], stop_reason: null } }];
  body.content.forEach((block, index) => {
    events.push({ type: 'content_block_start', index, content_block: block });
    events.push({ type: 'content_block_stop', index });
  });
  events.push(
    {
      type: 'message_delta',
      delta: { stop_reason: body.stop_reason },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' }
  );
  return {
    statusCode: 200,
    stream,
    wire: Buffer.from(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('')),
  };
};

for (const kind of ['chat', 'responses']) {
  test(kind + ' to Messages admits trusted long history with exact projection', () => {
    exerciseLongHistoryConversion({
      kind,
      create: (historyFormat) =>
        createContextRecoveryMessagesConversion({
          kind,
          model: 'vendor/model',
          converters: recoveryConverters(),
          historyFormat,
        }),
      texts: (body) =>
        body.messages.map((item) =>
          typeof item.content === 'string'
            ? item.content
            : item.content.map((block) => block.text).join('')
        ),
    });
  });
  test(
    kind + ' to Messages preserves full history, instructions, controls and tool contract',
    () => {
      const converters = recoveryConverters({
        maxContextTokens: 100,
        outputReserveTokens: 1,
        toolReserveTokens: 1,
        reasoningReserveTokens: 1,
        safetyMarginTokens: 1,
      });
      const body = request(kind);
      const key = kind === 'chat' ? 'messages' : 'input';
      body[key].unshift(
        { role: 'user', content: 'old'.repeat(12000) },
        { role: 'assistant', content: 'prior' }
      );
      if (kind === 'chat') body.messages.unshift({ role: 'system', content: 'policy' });
      else body.instructions = 'policy';
      body[kind === 'chat' ? 'max_completion_tokens' : 'max_output_tokens'] = 128;
      body.temperature = 0.2;
      body.top_p = 0.9;
      body.parallel_tool_calls = false;
      body.tools =
        kind === 'chat'
          ? [
              {
                type: 'function',
                function: { name: 'lookup', parameters: { type: 'object' }, strict: true },
              },
            ]
          : [{ type: 'function', name: 'lookup', parameters: { type: 'object' }, strict: true }];
      const result = adapter(kind, converters).encodeRequest(body);
      assert.equal(
        typeof result.messages[0].content === 'string'
          ? result.messages[0].content
          : result.messages[0].content[0].text,
        'old'.repeat(12000)
      );
      assert.equal(result.system, 'policy');
      assert.equal(result.model, 'vendor/model');
      assert.equal(result.max_tokens, 128);
      assert.equal(result.temperature, 0.2);
      assert.equal(result.stream, false);
      assert.deepEqual(
        { ...result.tool_choice },
        { type: 'auto', disable_parallel_tool_use: true }
      );
      assert.equal(result.tools[0].strict, true);
    }
  );

  test(
    kind + ' to Messages rejects unsafe, malformed, unknown and extreme input without getters',
    () => {
      for (const body of [
        null,
        [],
        {},
        { ...request(kind), unknown: true },
        { ...request(kind), stream: 'yes' },
        { ...request(kind), tool_choice: 'required' },
        { ...request(kind), temperature: 2 },
        { ...request(kind), top_p: -1 },
        { ...request(kind), parallel_tool_calls: 1 },
        { ...request(kind), service_tier: 'priority' },
        { ...request(kind), [kind === 'chat' ? 'messages' : 'input']: [] },
        { ...request(kind), tools: [{ type: 'web_search' }] },
        {
          ...request(kind),
          [kind === 'chat' ? 'messages' : 'input']: [
            { role: 'user', content: 'x'.repeat(3 * 1024 * 1024) },
          ],
        },
      ])
        assert.throws(() => adapter(kind).encodeRequest(body));
      let accessed = false;
      const body = {
        get model() {
          accessed = true;
          throw Error('secret');
        },
      };
      assert.throws(() => adapter(kind).encodeRequest(body));
      assert.equal(accessed, false);
    }
  );

  test(
    kind + ' to Messages validates exact JSON/SSE response text, tools, usage and no replay',
    async () => {
      for (const stream of [false, true]) {
        let calls = 0;
        const signal = new globalThis.AbortController().signal;
        const result = await adapter(kind).createDispatch(async (_input, options) => {
          calls++;
          assert.equal(options.signal, signal);
          return envelope(payload(), stream);
        })(request(kind), { signal });
        const body = JSON.parse(result.wire);
        const call =
          kind === 'chat'
            ? body.choices[0].message.tool_calls[0]
            : body.output.find((x) => x.type === 'function_call');
        assert.equal(kind === 'chat' ? call.id : call.call_id, tool.id);
        assert.deepEqual(
          JSON.parse(kind === 'chat' ? call.function.arguments : call.arguments),
          tool.input
        );
        assert.equal(kind === 'chat' ? body.usage.prompt_tokens : body.usage.input_tokens, 2);
        assert.equal(calls, 1);
      }
      for (const response of [
        payload([{ type: 'thinking', thinking: 'opaque', signature: 'signed' }]),
        payload([tool, { type: 'text', text: 'reordered' }]),
        { ...payload(), stop_reason: 'max_tokens' },
        { ...payload(), content: [] },
      ]) {
        let calls = 0;
        await assert.rejects(
          adapter(kind).createDispatch(async () => {
            calls++;
            return envelope(response);
          })(request(kind), {})
        );
        assert.equal(calls, 1);
      }
    }
  );

  test(kind + ' to Messages rejects production converter parameter and output drift', async () => {
    for (const mutate of [
      (x) => {
        x.temperature = 0.8;
      },
      (x) => {
        x.messages[0].content = 'changed';
      },
      (x) => {
        x.max_tokens++;
      },
      (x) => {
        x.tools = [];
      },
    ]) {
      const converters = recoveryConverters();
      const original = converters.openAIChatToClaudeMessages;
      converters.openAIChatToClaudeMessages = (...args) => {
        const result = original(...args);
        mutate(result);
        return result;
      };
      const body = request(kind);
      body.tools =
        kind === 'chat'
          ? [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }]
          : [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }];
      assert.throws(() => adapter(kind, converters).encodeRequest(body));
    }
    const converters = recoveryConverters();
    const original = converters.claudeResponseToOpenAIChat;
    converters.claudeResponseToOpenAIChat = (...args) => {
      const result = original(...args);
      result.choices[0].message.tool_calls[0].function.arguments = '{}';
      return result;
    };
    await assert.rejects(
      adapter(kind, converters).createDispatch(async () => envelope(payload()))(request(kind), {})
    );
  });

  test(
    kind + ' to Messages fails malformed upstream and dispatch errors without retry',
    async () => {
      for (const response of [
        { ...envelope(payload()), statusCode: 429 },
        { ...envelope(payload()), stream: 'true' },
        { ...envelope(payload()), encoding: 'gzip' },
        { statusCode: 200, stream: false, wire: Buffer.from('{') },
        { statusCode: 200, stream: true, wire: Buffer.from('data: {"type":"message_start"}\n\n') },
        envelope(payload([tool, { ...tool }])),
      ]) {
        let calls = 0;
        await assert.rejects(
          adapter(kind).createDispatch(async () => {
            calls++;
            return response;
          })(request(kind), {})
        );
        assert.equal(calls, 1);
      }
      let calls = 0;
      await assert.rejects(
        adapter(kind).createDispatch(async () => {
          calls++;
          throw Error('transport-failed');
        })(request(kind), {})
      );
      assert.equal(calls, 1);
      assert.throws(() => adapter(kind).createDispatch(null));
    }
  );
}

test('Messages conversion rejects ambiguous instructions and malformed tool pairing', () => {
  for (const messages of [
    [
      { role: 'system', content: 'a' },
      { role: 'developer', content: 'b' },
      { role: 'user', content: 'hi' },
    ],
    [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'late' },
    ],
    [{ role: 'tool', tool_call_id: 'missing', content: 'orphan' }],
    [
      {
        role: 'assistant',
        tool_calls: [
          { type: 'function', id: 'pending', function: { name: 'lookup', arguments: '{}' } },
        ],
      },
    ],
  ])
    assert.throws(() => adapter('chat').encodeRequest({ model: 'model', messages }));
  for (const options of [
    { kind: 'claude', model: 'model', converters: recoveryConverters() },
    { kind: 'chat', model: 'model', converters: {} },
    { kind: 'chat', model: '\n', converters: recoveryConverters() },
  ])
    assert.throws(() => createContextRecoveryMessagesConversion(options));
});

test('Messages admission snapshots contracts before converters can mutate source objects', () => {
  for (const mutate of [
    (body) => {
      body.tools[0].function.parameters.properties = { changed: { type: 'string' } };
    },
    (body) => {
      body.temperature = 0.8;
    },
    (body) => {
      body.max_tokens = 512;
    },
    (body) => {
      body.parallel_tool_calls = true;
    },
  ]) {
    const converters = recoveryConverters();
    const original = converters.openAIChatToClaudeMessages;
    converters.openAIChatToClaudeMessages = (body, ...args) => {
      mutate(body);
      return original(body, ...args);
    };
    assert.throws(() =>
      adapter('chat', converters).encodeRequest({
        ...request('chat'),
        temperature: 0.2,
        max_tokens: 128,
        parallel_tool_calls: false,
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
      })
    );
  }
  for (const mutate of [
    (body) => {
      delete body.temperature;
    },
    (body) => {
      delete body.max_tokens;
    },
    (body) => {
      body.parallel_tool_calls = true;
    },
  ]) {
    const converters = recoveryConverters();
    const original = converters.openAIResponsesToChat;
    converters.openAIResponsesToChat = (...args) => {
      const result = original(...args);
      mutate(result);
      return result;
    };
    assert.throws(() =>
      adapter('responses', converters).encodeRequest({
        ...request('responses'),
        temperature: 0.2,
        max_output_tokens: 128,
        parallel_tool_calls: false,
      })
    );
  }
});
