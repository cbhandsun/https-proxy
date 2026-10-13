'use strict';
const { createGeminiStreamDecoder } = require('./gemini-stream-decoder');
const { createConversionStreamBudget } = require('./conversion-stream-budget');
const { claudeUsageToOpenAIChatUsage } = require('./protocol-usage-details');

function createGeminiChatStream({ deps, chatState, options = {} }) {
  const budget = createConversionStreamBudget(deps.protocolOptions);
  const output = {};
  const pending = [];
  function encode(delta, finishReason, usage) {
    const wire =
      'data: ' +
      JSON.stringify({
        id: chatState.id,
        object: 'chat.completion.chunk',
        created: chatState.created,
        model: chatState.model,
        choices: [{ index: 0, delta, finish_reason: finishReason || null }],
        ...(usage ? { usage } : {}),
      }) +
      '\n\n';
    return wire;
  }
  function write(sink, delta, finishReason, usage) {
    const wire = encode(delta, finishReason, usage);
    budget.consume(output, wire);
    sink.write(wire);
  }
  function start(sink) {
    if (chatState.started) return;
    write(sink, { role: 'assistant', content: '' });
    chatState.started = true;
  }
  return createGeminiStreamDecoder({
    deps,
    options,
    target: {
      text(sink, value) {
        start(sink);
        write(sink, { content: value });
      },
      reasoning(sink, value) {
        start(sink);
        write(sink, { reasoning_content: value });
      },
      tool(_sink, call, index) {
        pending.push(
          encode({
            tool_calls: [
              {
                index,
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              },
            ],
          })
        );
      },
      finish(sink, { usage, finishReason }) {
        start(sink);
        const frames = [
          ...pending,
          encode({}, finishReason, claudeUsageToOpenAIChatUsage(usage)),
          'data: [DONE]\n\n',
        ];
        for (const wire of frames) budget.consume(output, wire);
        for (const wire of frames) sink.write(wire);
        pending.length = 0;
        chatState.done = true;
      },
      fail(sink, code) {
        chatState.failed = true;
        pending.length = 0;
        sink.write(
          'data: ' +
            JSON.stringify({
              error: {
                code,
                type: 'protocol_conversion_error',
                message: 'Upstream Gemini stream could not be completed safely',
              },
            }) +
            '\n\n'
        );
      },
    },
  });
}
module.exports = { createGeminiChatStream };
