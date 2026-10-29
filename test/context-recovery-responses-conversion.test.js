'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createContextRecoveryResponsesConversion,
} = require('../lib/proxy/context-recovery-responses-conversion');
const { recoveryConverters } = require('./helpers/recovery-converters');
const { exerciseLongHistoryConversion } = require('./helpers/recovery-long-conversion.cjs');

const request = (kind) => ({
  model: 'model',
  messages: [{ role: 'user', content: '原文🙂' }],
  ...(kind === 'claude' ? { system: 'policy', max_tokens: 64 } : {}),
});
const adapter = (kind, options = {}) =>
  createContextRecoveryResponsesConversion({
    kind,
    model: 'vendor/model',
    converters: recoveryConverters(),
    ...options,
  });
const payload = (output) => ({
  id: 'resp-original',
  status: 'completed',
  model: 'model',
  created_at: 1700000000,
  output,
  usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
});
const result = (body) => ({
  statusCode: 200,
  stream: false,
  wire: Buffer.from(JSON.stringify(body)),
});
const message = (text) => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text, annotations: [] }],
  status: 'completed',
});
const call = {
  type: 'function_call',
  call_id: 'call-external',
  id: 'fc-external',
  name: 'lookup',
  arguments: '{"exact":"原参数🙂"}',
  status: 'completed',
};

for (const kind of ['chat', 'claude']) {
  test(kind + ' to Responses admits trusted long history with exact projection', () => {
    exerciseLongHistoryConversion({
      kind,
      create: (historyFormat) => adapter(kind, { historyFormat }),
      texts: (body) =>
        body.input.map((item) =>
          typeof item.content === 'string'
            ? item.content
            : item.content.map((block) => block.text).join('')
        ),
    });
  });
  test(
    kind + ' to Responses retains full history under aggressive budgets and preserves controls',
    () => {
      const converters = recoveryConverters({
        maxContextTokens: 100,
        outputReserveTokens: 1,
        toolReserveTokens: 1,
        reasoningReserveTokens: 1,
        safetyMarginTokens: 1,
      });
      const conversion = adapter(kind, { converters });
      const body = request(kind);
      body.messages = [
        { role: 'user', content: 'old'.repeat(12000) },
        { role: 'assistant', content: 'prior' },
        ...body.messages,
      ];
      body.temperature = 0.2;
      body.top_p = 0.9;
      body.parallel_tool_calls = false;
      body.tools =
        kind === 'chat'
          ? [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }]
          : [{ name: 'lookup', input_schema: { type: 'object' } }];
      const wire = conversion.encodeRequest(body);
      assert.equal(wire.input[0].content[0].text, body.messages[0].content);
      assert.equal(wire.model, 'vendor/model');
      assert.equal(wire.stream, true);
      assert.equal(wire.store, false);
      assert.equal(wire.temperature, 0.2);
      assert.equal(wire.top_p, 0.9);
      assert.equal(wire.parallel_tool_calls, false);
      assert.equal(wire.tools[0].strict, false);
      assert.equal(wire.instructions, kind === 'chat' ? '' : 'policy');
      assert.equal(wire.__hpmDiagnostics, undefined);
      assert.throws(() => adapter(kind, { codex: true }).encodeRequest(body));
    }
  );

  test(
    kind +
      ' to Responses converts JSON/SSE tools and text without altering IDs, parameters or usage',
    async () => {
      const conversion = adapter(kind);
      for (const stream of [false, true]) {
        const original = payload([message('finished'), call]);
        const reply = stream
          ? {
              statusCode: 200,
              stream: true,
              wire: Buffer.from(
                'data: ' +
                  JSON.stringify({ type: 'response.completed', response: original }) +
                  '\n\n'
              ),
            }
          : result(original);
        const signal = new globalThis.AbortController().signal;
        const converted = await conversion.createDispatch(async (_body, options) => {
          assert.equal(options.signal, signal);
          return reply;
        })(request(kind), { signal });
        const body = JSON.parse(converted.wire);
        const calls =
          kind === 'chat'
            ? body.choices[0].message.tool_calls
            : body.content.filter((part) => part.type === 'tool_use');
        assert.equal(calls[0].id, 'call-external');
        assert.equal(
          kind === 'chat' ? calls[0].function.arguments : JSON.stringify(calls[0].input),
          call.arguments
        );
        assert.equal(kind === 'chat' ? body.usage.prompt_tokens : body.usage.input_tokens, 2);
        assert.equal(kind === 'chat' ? body.usage.completion_tokens : body.usage.output_tokens, 1);
      }
    }
  );

  test(
    kind +
      ' to Responses rejects unsupported, unsafe and malformed input without getters or silent trimming',
    () => {
      const conversion = adapter(kind);
      for (const body of [
        null,
        [],
        {},
        { ...request(kind), unknown: 'cannot-drop' },
        { ...request(kind), messages: [] },
        { ...request(kind), tool_choice: 'none' },
        { ...request(kind), stream: 'true' },
        { ...request(kind), max_tokens: 0 },
        { ...request(kind), max_tokens: 2, max_completion_tokens: 3 },
        { ...request(kind), top_p: -1 },
        { ...request(kind), temperature: 3 },
        { ...request(kind), parallel_tool_calls: 1 },
        { ...request(kind), service_tier: 'invalid' },
        { ...request(kind), system: [] },
        { ...request(kind), stop_sequences: ['unsupported'] },
        { ...request(kind), tools: [{ type: 'web_search', name: 'search' }] },
        {
          ...request(kind),
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'thinking', thinking: 'opaque', signature: 'signed' }],
            },
          ],
        },
      ])
        assert.throws(() => conversion.encodeRequest(body));
      let accessed = false;
      assert.throws(() =>
        conversion.encodeRequest({
          get messages() {
            accessed = true;
            return [];
          },
        })
      );
      assert.equal(accessed, false);
      assert.throws(() =>
        conversion.encodeRequest({ ...request(kind), model: 'x'.repeat(3 * 1024 * 1024) })
      );
    }
  );

  test(
    kind +
      ' to Responses rejects opaque, incomplete, changed and truncated upstream output without retry',
    async () => {
      for (const reply of [
        { ...result(payload([message('done')])), statusCode: 500 },
        { ...result(payload([message('done')])), encoding: 'gzip' },
        { ...result(payload([message('done')])), stream: 'false' },
        result({ ...payload([message('done')]), status: 'incomplete' }),
        result(payload([{ type: 'reasoning', encrypted_content: 'opaque' }, message('done')])),
        result(payload([{ type: 'compaction', encrypted_content: 'opaque' }])),
        result(payload([{ ...call, arguments: 'bad JSON' }])),
        result(payload([call, message('interleaved')])),
        { statusCode: 200, stream: true, wire: Buffer.from('data: {"type":"response.completed"}') },
      ]) {
        let calls = 0;
        await assert.rejects(
          adapter(kind).createDispatch(async () => {
            calls++;
            return reply;
          })(request(kind), {})
        );
        assert.equal(calls, 1);
      }
    }
  );
}

test('Chat history instruction precedence and tool pairing are validated before conversion', () => {
  const conversion = adapter('chat');
  const toolCall = { id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' } };
  const history = [
    { role: 'system', content: 'policy' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: null, tool_calls: [toolCall] },
    { role: 'tool', tool_call_id: 'call', content: 'original' },
  ];
  assert.equal(
    conversion.encodeRequest({ model: 'model', messages: history }).instructions,
    'policy'
  );
  for (const messages of [
    history.slice(0, -1),
    [...history, history.at(-1)],
    [...history, history[2], history[3]],
    [history[1], history[0]],
    [
      { role: 'system', content: 'system' },
      { role: 'developer', content: 'developer' },
      history[1],
    ],
    [{ role: 'tool', tool_call_id: 'unknown', content: 'unknown' }],
    [{ role: 'user', content: ' ', unknown: true }],
  ])
    assert.throws(() => conversion.encodeRequest({ model: 'model', messages }));
});

test('Claude tool errors preserve status and argument cleaning/history loss cannot qualify', () => {
  const body = {
    model: 'model',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call', name: 'lookup', input: { exact: '原参数' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call', content: 'failure', is_error: true }],
      },
    ],
  };
  const conversion = adapter('claude');
  const converted = conversion.encodeRequest(body);
  assert.equal(converted.input.at(-1).status, 'error');
  const converters = recoveryConverters();
  const altered = adapter('claude', {
    converters: {
      ...converters,
      claudeMessagesToResponsesRequest: (...args) => {
        const output = converters.claudeMessagesToResponsesRequest(...args);
        output.input[0].arguments = '{}';
        return output;
      },
    },
  });
  assert.throws(() => altered.encodeRequest(body));
});

test('Responses adapter rejects converter control drift and response argument mutation', async () => {
  const converters = recoveryConverters();
  for (const [key, value] of [
    ['model', 'other'],
    ['temperature', 0.8],
    ['tool_choice', 'required'],
    ['max_output_tokens', 1],
  ]) {
    const conversion = adapter('chat', {
      converters: {
        ...converters,
        openAIChatToResponsesRequest: (...args) => ({
          ...converters.openAIChatToResponsesRequest(...args),
          [key]: value,
        }),
      },
    });
    assert.throws(() => conversion.encodeRequest(request('chat')));
  }
  const conversion = adapter('claude', {
    converters: {
      ...converters,
      responsesResponseToClaude: (...args) => {
        const output = converters.responsesResponseToClaude(...args);
        output.content[0].input = {};
        return output;
      },
    },
  });
  await assert.rejects(
    conversion.createDispatch(async () => result(payload([call])))(request('claude'), {})
  );
});
