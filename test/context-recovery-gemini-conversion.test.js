'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createContextRecoveryGeminiConversion,
} = require('../lib/proxy/context-recovery-gemini-conversion');
const { recoveryConverters } = require('./helpers/recovery-converters');
const { exerciseLongHistoryConversion } = require('./helpers/recovery-long-conversion.cjs');
const request = (kind) => ({
  model: 'model',
  [kind === 'responses' ? 'input' : 'messages']: [{ role: 'user', content: '原文🙂' }],
});
const adapter = (kind, converters = recoveryConverters()) =>
  createContextRecoveryGeminiConversion({ kind, model: 'gemini-2.5-flash', converters });
const schema = {
  type: 'object',
  additionalProperties: false,
  properties: { exact: { type: 'string', pattern: '^原' } },
  required: ['exact'],
};
const tools = (kind, name = 'lookup', parameters = schema) =>
  kind === 'chat'
    ? [{ type: 'function', function: { name, parameters } }]
    : kind === 'responses'
      ? [{ type: 'function', name, parameters }]
      : [{ name, input_schema: parameters }];
const payload = (
  parts = [
    { text: 'finished' },
    { functionCall: { id: 'provider-call', name: 'lookup', args: { exact: '原参数🙂' } } },
  ]
) => ({
  candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
});
const envelope = (body, stream = false) => ({
  statusCode: 200,
  stream,
  wire: Buffer.from(stream ? 'data: ' + JSON.stringify(body) + '\n\n' : JSON.stringify(body)),
});

test('isolated public supporting data preserves adjacent user message boundaries in Gemini', () => {
  const messages = [
    { role: 'user', content: 'Continue the task.\r\n' },
    { role: 'user', content: 'Supporting data: 中文🙂\n{"text":"untrusted"}' },
  ];
  const converted = adapter('chat').encodeRequest({ model: 'model', messages });
  assert.deepEqual(
    JSON.parse(JSON.stringify(converted.contents)),
    messages.map((message) => ({ role: 'user', parts: [{ text: message.content }] }))
  );
  const history = [
    { role: 'user', content: 'Original task' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'prior-call', type: 'function', function: { name: 'lookup', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'prior-call', content: 'original result' },
    { role: 'assistant', content: 'Previous answer' },
    ...messages,
  ];
  const continued = adapter('chat').encodeRequest({ model: 'model', messages: history });
  assert.deepEqual(
    JSON.parse(JSON.stringify(continued.contents.slice(-2))),
    messages.map((message) => ({ role: 'user', parts: [{ text: message.content }] }))
  );
});

for (const kind of ['chat', 'responses', 'claude']) {
  test(kind + ' to Gemini admits trusted long history with exact projection', () => {
    exerciseLongHistoryConversion({
      kind,
      create: (historyFormat) =>
        createContextRecoveryGeminiConversion({
          kind,
          model: 'gemini-2.5-flash',
          converters: recoveryConverters(),
          historyFormat,
        }),
      texts: (body) => body.contents.map((item) => item.parts.map((part) => part.text).join('')),
    });
  });
  test(
    kind + ' to Gemini preserves history under aggressive budgets and native JSON schema',
    () => {
      const converters = recoveryConverters({
        maxContextTokens: 100,
        outputReserveTokens: 1,
        toolReserveTokens: 1,
        reasoningReserveTokens: 1,
        safetyMarginTokens: 1,
      });
      const body = request(kind);
      const key = kind === 'responses' ? 'input' : 'messages';
      body[key].unshift(
        { role: 'user', content: 'old'.repeat(12000) },
        { role: 'assistant', content: 'prior' }
      );
      body.tools = tools(kind);
      body[kind === 'responses' ? 'instructions' : kind === 'claude' ? 'system' : 'stream'] =
        kind === 'chat' ? true : 'policy';
      if (kind === 'chat') body.messages.unshift({ role: 'system', content: 'policy' });
      body[kind === 'responses' ? 'max_output_tokens' : 'max_tokens'] = 256;
      body.temperature = 0.2;
      body.top_p = 0.9;
      body.parallel_tool_calls = true;
      const result = adapter(kind, converters).encodeRequest(body);
      assert.equal(result.contents[0].parts[0].text, 'old'.repeat(12000));
      assert.equal(result.systemInstruction.parts[0].text, 'policy');
      assert.deepEqual(
        JSON.parse(JSON.stringify(result.tools[0].functionDeclarations[0].parametersJsonSchema)),
        schema
      );
      assert.equal(result.tools[0].functionDeclarations[0].parameters, undefined);
      assert.equal(result.generationConfig.maxOutputTokens, 256);
      assert.equal(result.generationConfig.temperature, 0.2);
      assert.equal(result.generationConfig.topP, 0.9);
      const ordinary = converters.createGeminiProtocol().tryOpenAIChatToGemini(
        {
          model: 'model',
          messages: [
            { role: 'user', content: 'old'.repeat(12000) },
            { role: 'assistant', content: 'prior' },
            { role: 'user', content: 'latest' },
          ],
        },
        'gemini-2.5-flash'
      );
      assert.doesNotMatch(JSON.stringify(ordinary.request), /oldoldold/);
    }
  );

  test(
    kind + ' to Gemini rejects invalid, unsupported, unsafe and extreme inputs without getters',
    () => {
      for (const body of [
        null,
        [],
        {},
        { ...request(kind), unknown: true },
        { ...request(kind), stream: 'true' },
        { ...request(kind), tool_choice: 'required' },
        { ...request(kind), temperature: 3 },
        { ...request(kind), top_p: -1 },
        { ...request(kind), parallel_tool_calls: false },
        { ...request(kind), max_tokens: 8193 },
        { ...request(kind), service_tier: 'priority' },
        { ...request(kind), [kind === 'responses' ? 'input' : 'messages']: [] },
        { ...request(kind), tools: tools(kind, 'invalid-name') },
        { ...request(kind), tools: tools(kind, 'lookup', { type: 'array' }) },
        {
          ...request(kind),
          [kind === 'responses' ? 'input' : 'messages']: [
            { role: 'user', content: 'x'.repeat(3 * 1024 * 1024) },
          ],
        },
      ])
        assert.throws(() => adapter(kind).encodeRequest(body));
      const strictTools = tools(kind);
      if (kind === 'chat') strictTools[0].function.strict = true;
      else strictTools[0].strict = true;
      assert.throws(() => adapter(kind).encodeRequest({ ...request(kind), tools: strictTools }));
      let accessed = false;
      assert.throws(() =>
        adapter(kind).encodeRequest({
          get model() {
            accessed = true;
            throw Error('secret');
          },
        })
      );
      assert.equal(accessed, false);
    }
  );

  test(
    kind + ' to Gemini JSON/SSE preserves provider call ID, parameters and usage without replay',
    async () => {
      for (const stream of [false, true]) {
        let calls = 0;
        const signal = new globalThis.AbortController().signal;
        const result = await adapter(kind).createDispatch(async (_body, options) => {
          calls++;
          assert.equal(options.signal, signal);
          return envelope(payload(), stream);
        })({ ...request(kind), tools: tools(kind) }, { signal });
        const body = JSON.parse(result.wire);
        const call =
          kind === 'chat'
            ? body.choices[0].message.tool_calls[0]
            : kind === 'responses'
              ? body.output.find((x) => x.type === 'function_call')
              : body.content.find((x) => x.type === 'tool_use');
        assert.equal(kind === 'responses' ? call.call_id : call.id, 'provider-call');
        assert.deepEqual(
          kind === 'claude'
            ? call.input
            : JSON.parse(kind === 'chat' ? call.function.arguments : call.arguments),
          { exact: '原参数🙂' }
        );
        assert.equal(kind === 'chat' ? body.usage.prompt_tokens : body.usage.input_tokens, 2);
        assert.equal(calls, 1);
      }
    }
  );

  test(
    kind + ' to Gemini rejects incomplete, opaque, duplicate, malformed and drifting upstream',
    async () => {
      for (const response of [
        { ...payload(), error: { message: 'secret' } },
        payload([{ text: 'thought', thought: true, thoughtSignature: 'signed' }]),
        payload([
          { functionCall: { id: 'signed', name: 'lookup', args: {} }, thoughtSignature: 'signed' },
        ]),
        payload([{ functionCall: { id: 'partial', name: 'lookup', args: {}, partialArgs: [] } }]),
        payload([{ inlineData: { mimeType: 'image/png', data: 'AA==' } }]),
        payload([
          { functionCall: { id: 'dup', name: 'lookup', args: {} } },
          { functionCall: { id: 'dup', name: 'lookup', args: {} } },
        ]),
        payload([
          { functionCall: { id: 'call', name: 'lookup', args: {} } },
          { text: 'reordered' },
        ]),
        { candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }] },
        { candidates: [] },
        payload([]),
        { ...payload(), usageMetadata: { promptTokenCount: -1 } },
      ]) {
        let calls = 0;
        await assert.rejects(
          adapter(kind).createDispatch(async () => {
            calls++;
            return envelope(response);
          })({ ...request(kind), tools: tools(kind) }, {})
        );
        assert.equal(calls, 1);
      }
      for (const reply of [
        { ...envelope(payload()), statusCode: 429 },
        { ...envelope(payload()), encoding: 'gzip' },
        { ...envelope(payload()), stream: 'true' },
        { statusCode: 200, stream: true, wire: Buffer.from('data: {"candidates":[]}\n\n') },
      ])
        await assert.rejects(adapter(kind).createDispatch(async () => reply)(request(kind), {}));
      await assert.rejects(
        adapter(kind).createDispatch(async () => {
          throw Error('transport');
        })(request(kind), {})
      );
    }
  );
}

test('Gemini adapters isolate tool cache, mint missing provider IDs and keep external Write calls free of staging', async () => {
  const converters = recoveryConverters();
  let factories = 0;
  const factory = converters.createGeminiProtocol;
  converters.createGeminiProtocol = () => {
    factories++;
    return factory();
  };
  const first = adapter('chat', converters);
  const second = adapter('chat', converters);
  assert.equal(factories, 2);
  const history = (exact) => ({
    model: 'model',
    tools: tools('chat'),
    messages: [
      { role: 'user', content: 'fresh' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            type: 'function',
            id: 'shared-id',
            function: { name: 'lookup', arguments: JSON.stringify({ exact }) },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'shared-id', content: 'result' },
    ],
  });
  for (const [convert, exact] of [
    [first, 'first'],
    [second, 'second'],
    [first, 'first'],
  ]) {
    const request = convert.encodeRequest(history(exact));
    const call = request.contents
      .flatMap((content) => content.parts)
      .find((part) => part.functionCall).functionCall;
    assert.equal(call.id, 'shared-id');
    assert.equal(call.args.exact, exact);
  }
  const noId = payload([{ functionCall: { name: 'lookup', args: { exact: '原值' } } }]);
  const ids = [];
  for (const convert of [first, first, second]) {
    const result = await convert.createDispatch(async () => envelope(noId))(
      { ...request('chat'), tools: tools('chat') },
      {}
    );
    ids.push(JSON.parse(result.wire).choices[0].message.tool_calls[0].id);
  }
  assert.equal(new Set(ids).size, 3);
  const fs = require('node:fs');
  const originalMkdir = fs.mkdirSync;
  let staged = false;
  fs.mkdirSync = (dir, ...args) => {
    if (String(dir).includes('hpm-claude-tool-payloads')) {
      staged = true;
      throw Error('Unexpected staging');
    }
    return originalMkdir(dir, ...args);
  };
  try {
    const content = 'synthetic'.repeat(5000);
    const body = {
      ...request('chat'),
      tools: [
        ...tools('chat', 'Write', { type: 'object' }),
        ...tools('chat', 'Bash', { type: 'object' }),
      ],
    };
    const result = await adapter('chat').createDispatch(async () =>
      envelope(
        payload([
          {
            functionCall: {
              id: 'large-write',
              name: 'Write',
              args: { file_path: 'synthetic.txt', content },
            },
          },
        ])
      )
    )(body, {});
    const call = JSON.parse(result.wire).choices[0].message.tool_calls[0];
    assert.equal(call.function.name, 'Write');
    assert.equal(JSON.parse(call.function.arguments).content, content);
    assert.equal(staged, false);
  } finally {
    fs.mkdirSync = originalMkdir;
  }
});

test('Gemini recovery converter rejects request/response drift and malformed factories', async () => {
  for (const mutate of [
    (x) => {
      x.request.contents[0].parts[0].text = 'changed';
    },
    (x) => {
      x.request.generationConfig.maxOutputTokens++;
    },
    (x) => {
      x.request.tools = [];
    },
    (x) => {
      x.request.generationConfig.temperature = 1;
    },
  ]) {
    const converters = recoveryConverters();
    const factory = converters.createGeminiProtocol;
    converters.createGeminiProtocol = () => {
      const protocol = factory();
      const encode = protocol.tryOpenAIChatToGemini;
      protocol.tryOpenAIChatToGemini = (...args) => {
        const result = encode(...args);
        mutate(result);
        return result;
      };
      return protocol;
    };
    assert.throws(() =>
      adapter('chat', converters).encodeRequest({ ...request('chat'), tools: tools('chat') })
    );
  }
  const converters = recoveryConverters();
  const factory = converters.createGeminiProtocol;
  converters.createGeminiProtocol = () => {
    const protocol = factory();
    const decode = protocol.geminiResponseToChat;
    protocol.geminiResponseToChat = (...args) => {
      const result = decode(...args);
      result.choices[0].message.tool_calls[0].function.arguments = '{}';
      return result;
    };
    return protocol;
  };
  await assert.rejects(
    adapter('chat', converters).createDispatch(async () => envelope(payload()))(
      { ...request('chat'), tools: tools('chat') },
      {}
    )
  );
  for (const values of [
    { kind: 'other', model: 'model', converters },
    { kind: 'chat', model: '', converters },
    { kind: 'chat', model: 'model', converters: {} },
    {
      kind: 'chat',
      model: 'model',
      converters: { ...recoveryConverters(), createGeminiProtocol: () => ({}) },
    },
  ])
    assert.throws(() => createContextRecoveryGeminiConversion(values));
  assert.throws(() => adapter('chat').createDispatch(null));
});

test('Gemini multi-frame SSE preserves exact text and split cumulative usage', async () => {
  const first = {
    candidates: [{ content: { parts: [{ text: '第一段🙂' }] } }],
    usageMetadata: { promptTokenCount: 2 },
  };
  const last = {
    candidates: [{ content: { parts: [{ text: '第二段' }] }, finishReason: 'STOP' }],
    usageMetadata: { candidatesTokenCount: 1, totalTokenCount: 3 },
  };
  const wire = Buffer.from(
    [first, last].map((frame) => 'data: ' + JSON.stringify(frame) + '\n\n').join('')
  );
  const result = await adapter('chat').createDispatch(async () => ({
    statusCode: 200,
    stream: true,
    wire,
  }))(request('chat'), {});
  const body = JSON.parse(result.wire);
  assert.equal(body.choices[0].message.content, '第一段🙂第二段');
  assert.equal(body.usage.prompt_tokens, 2);
  assert.equal(body.usage.completion_tokens, 1);
  await assert.rejects(
    adapter('chat').createDispatch(async () => ({
      statusCode: 200,
      stream: true,
      wire: Buffer.concat([wire, envelope(payload(), true).wire]),
    }))(request('chat'), {})
  );
});
