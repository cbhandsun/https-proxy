'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createContextRecoveryConversion } = require('../lib/proxy/context-recovery-conversion');
const { recoveryConverters } = require('./helpers/recovery-converters');

const request = (kind) =>
  kind === 'responses'
    ? { model: 'model', instructions: 'policy', input: [{ role: 'user', content: '原文🙂' }] }
    : {
        model: 'model',
        system: 'policy',
        max_tokens: 50,
        messages: [{ role: 'user', content: '原文🙂' }],
      };
const adapter = (kind) =>
  createContextRecoveryConversion({
    kind,
    model: 'vendor/model',
    converters: recoveryConverters(),
  });
const response = () => ({
  id: 'chatcmpl-source',
  model: 'vendor/model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
});
const result = (body) => ({
  statusCode: 200,
  stream: false,
  wire: Buffer.from(JSON.stringify(body)),
});

for (const kind of ['responses', 'claude']) {
  test(
    kind + ' trusted long-history conversion preserves originals and bounded replies',
    async () => {
      const history = Array.from({ length: 3 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user',
        content: String(index) + '原文🙂'.repeat(90000),
      }));
      const key = kind === 'responses' ? 'input' : 'messages';
      const body = { ...request(kind), [key]: history };
      const conversion = createContextRecoveryConversion({
        kind,
        model: 'vendor/model',
        converters: recoveryConverters(),
        historyFormat: 3,
      });
      assert.ok(Buffer.byteLength(JSON.stringify(body)) > 2 * 1024 * 1024);
      assert.throws(() => adapter(kind).encodeRequest(body));
      const upstream = conversion.encodeRequest(body);
      assert.deepEqual(
        upstream.messages.slice(1).map((item) => item.content),
        history.map((item) => item.content)
      );
      let sent = 0;
      const dispatch = conversion.createDispatch(async (wireBody) => {
        sent++;
        assert.deepEqual(
          wireBody.messages.slice(1).map((item) => item.content),
          history.map((item) => item.content)
        );
        return result(response());
      });
      assert.equal(JSON.parse((await dispatch(body, {})).wire).model, 'vendor/model');
      assert.equal(sent, 1);
      for (const invalid of [
        { ...body, [key]: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }] },
        {
          ...body,
          [kind === 'responses' ? 'instructions' : 'system']: 'x'.repeat(2 * 1024 * 1024),
        },
        { ...body, historyFormat: 3 },
        {
          ...body,
          [key]: Array.from({ length: 34 }, () => ({
            role: 'user',
            content: 'x'.repeat(1024 * 1024),
          })),
        },
      ])
        await assert.rejects(dispatch(invalid, {}));
      assert.equal(sent, 1);
      const oversized = response();
      oversized.choices[0].message.content = 'x'.repeat(2 * 1024 * 1024);
      await assert.rejects(conversion.createDispatch(async () => result(oversized))(body, {}));
    }
  );

  test(
    kind +
      ' conversion preserves text, controls, arguments, IDs and usage using production converters',
    async () => {
      const conversion = adapter(kind);
      const body = {
        ...request(kind),
        stream: true,
        temperature: 0.2,
        top_p: 0.9,
        tool_choice: kind === 'claude' ? { type: 'auto' } : 'auto',
        parallel_tool_calls: false,
        tools:
          kind === 'responses'
            ? [
                {
                  type: 'function',
                  name: 'lookup',
                  description: 'read',
                  parameters: { type: 'object' },
                  strict: false,
                },
              ]
            : [{ name: 'lookup', description: 'read', input_schema: { type: 'object' } }],
      };
      const original = JSON.stringify(body);
      const upstream = conversion.encodeRequest(body);
      assert.equal(upstream.stream, false);
      assert.equal(upstream.model, 'vendor/model');
      assert.equal(upstream.messages[0].content, 'policy');
      assert.match(JSON.stringify(upstream.messages), /原文🙂/);
      assert.equal(upstream.tools[0].function.name, 'lookup');
      assert.equal(upstream.temperature, 0.2);
      assert.equal(upstream.top_p, 0.9);
      assert.equal(upstream.parallel_tool_calls, false);
      assert.equal(JSON.stringify(body), original);
      const signal = new globalThis.AbortController().signal;
      const source = response();
      source.choices[0] = {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-external',
              type: 'function',
              function: { name: 'lookup', arguments: '{"x":"原文🙂"}' },
            },
          ],
        },
      };
      const converted = await conversion.createDispatch(async (wireBody, options) => {
        assert.equal(options.signal, signal);
        assert.equal(wireBody.stream, false);
        return result(source);
      })(body, { signal });
      const final = JSON.parse(converted.wire);
      const call = kind === 'responses' ? final.output[0] : final.content[0];
      assert.equal(kind === 'responses' ? call.call_id : call.id, 'call-external');
      assert.equal(call.name, 'lookup');
      assert.equal(final.usage.input_tokens, 4);
      assert.equal(final.usage.output_tokens, 2);
      assert.equal(
        kind === 'responses' ? call.arguments : JSON.stringify(call.input),
        '{"x":"原文🙂"}'
      );
    }
  );

  test(
    kind +
      ' conversion rejects unknown, empty, extreme, accessor and opaque inputs before dispatch',
    () => {
      const conversion = adapter(kind);
      for (const body of [
        null,
        {},
        [],
        { ...request(kind), extra: 'cannot-drop' },
        { ...request(kind), temperature: -1 },
        { ...request(kind), top_p: 2 },
        { ...request(kind), model: '' },
        { ...request(kind), stream: 'true' },
        { ...request(kind), max_tokens: 0 },
        { ...request(kind), tool_choice: 'none' },
        { ...request(kind), tools: [{ type: 'web_search', name: 'search' }] },
        { ...request(kind), system: [] },
        { ...request(kind), instructions: {} },
        { ...request(kind), store: true },
        { ...request(kind), service_tier: 'invalid' },
        { ...request(kind), parallel_tool_calls: 'false' },
        { ...request(kind), stop_sequences: [5] },
      ])
        assert.throws(() => conversion.encodeRequest(body));
      const opaque = request(kind);
      if (kind === 'responses')
        opaque.input.push({ type: 'compaction', encrypted_content: 'opaque' });
      else
        opaque.messages.push({
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'opaque', signature: 'signed' }],
        });
      assert.throws(() => conversion.encodeRequest(opaque));
      let accessed = false;
      assert.throws(() =>
        conversion.encodeRequest({
          get model() {
            accessed = true;
            return 'model';
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
    kind + ' conversion rejects failed, lossy and malformed upstream envelopes without retry',
    async () => {
      const conversion = adapter(kind);
      const cases = [
        { ...result(response()), statusCode: 500 },
        { ...result(response()), encoding: 'gzip' },
        { ...result(response()), wire: Buffer.from('bad JSON') },
        result({ ...response(), choices: [] }),
        result({ ...response(), choices: [{ ...response().choices[0], finish_reason: 'length' }] }),
        result({
          ...response(),
          choices: [
            {
              ...response().choices[0],
              message: { role: 'assistant', content: 'done', reasoning_content: 'opaque' },
            },
          ],
        }),
        result({
          ...response(),
          choices: [
            {
              ...response().choices[0],
              message: { role: 'assistant', content: [{ type: 'image', data: 'unknown' }] },
            },
          ],
        }),
        result({
          ...response(),
          choices: [
            { ...response().choices[0], message: { role: 'assistant', refusal: 'refused' } },
          ],
        }),
        result({
          ...response(),
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                tool_calls: [
                  { type: 'function', id: 'call', function: { name: 'lookup', arguments: 'bad' } },
                ],
              },
            },
          ],
        }),
      ];
      for (const item of cases) {
        let dispatched = 0;
        await assert.rejects(
          conversion.createDispatch(async () => {
            dispatched++;
            return item;
          })(request(kind), {})
        );
        assert.equal(dispatched, 1);
      }
    }
  );
}

test('conversion capabilities validate kind, model and converter functions', () => {
  for (const options of [
    {},
    { kind: 'chat', model: 'model' },
    { kind: 'responses', model: '' },
    { kind: 'claude', model: 'bad\nmodel' },
    { kind: 'responses', model: 'model', converters: {} },
  ])
    assert.throws(() => createContextRecoveryConversion(options));
  assert.throws(() => adapter('responses').createDispatch(null));
});

test('conversion refuses production tool-argument cleaning and tool-definition loss', async () => {
  const converters = recoveryConverters();
  const altered = createContextRecoveryConversion({
    kind: 'claude',
    model: 'model',
    converters: {
      ...converters,
      openAIResponseToClaudeMessage: (...args) => {
        const output = converters.openAIResponseToClaudeMessage(...args);
        output.content[0].input = {};
        return output;
      },
    },
  });
  const source = response();
  source.choices[0] = {
    index: 0,
    finish_reason: 'tool_calls',
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'external',
          type: 'function',
          function: { name: 'lookup', arguments: '{"must":"preserve"}' },
        },
      ],
    },
  };
  await assert.rejects(altered.createDispatch(async () => result(source))(request('claude'), {}));
  const lostTools = createContextRecoveryConversion({
    kind: 'responses',
    model: 'model',
    converters: {
      ...converters,
      openAIResponsesToChat: (body) => {
        const output = converters.openAIResponsesToChat(body);
        delete output.tools;
        return output;
      },
    },
  });
  assert.throws(() =>
    lostTools.encodeRequest({
      ...request('responses'),
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
    })
  );
});

test('conversion validates history without filtering opaque blocks or tool errors', () => {
  const responses = adapter('responses');
  const good = {
    ...request('responses'),
    input: [
      { role: 'user', content: [{ type: 'input_text', text: '原文' }] },
      { type: 'function_call', call_id: 'call', name: 'lookup', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call', output: 'result' },
    ],
  };
  assert.equal(responses.encodeRequest(good).messages.at(-1).tool_call_id, 'call');
  for (const item of [
    null,
    { role: 'invalid', content: 'text' },
    { role: 'user', content: [{ type: 'input_image', image_url: 'url' }] },
    { role: 'assistant', status: 'incomplete', content: 'text' },
    { type: 'function_call', call_id: 'bad', name: 'lookup', arguments: '[]' },
    { type: 'function_call_output', call_id: 'call', output: {} },
  ])
    assert.throws(() => responses.encodeRequest({ ...good, input: [item] }));
  const claude = adapter('claude');
  for (const item of [
    null,
    { role: 'tool', content: 'text' },
    { role: 'user', content: null },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'lookup', input: [] }] },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call', content: 'error', is_error: true }],
    },
  ])
    assert.throws(() => claude.encodeRequest({ ...request('claude'), messages: [item] }));
  assert.throws(() => responses.encodeRequest({ ...good, input: [] }));
  assert.throws(() => claude.encodeRequest({ ...request('claude'), messages: [] }));
});
