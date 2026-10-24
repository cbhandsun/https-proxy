'use strict';

// Upstream-only synthetic Anthropic SSE, including deliberately private tool
// and thinking blocks. These bytes must never be forwarded as public recovery.
function claudeSyntheticSse(model, ordinal, content) {
  const chunks = [];
  const emit = (type, value) =>
    chunks.push('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n');
  const stop = content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
  emit('message_start', {
    message: {
      id: 'msg_hpm_' + ordinal,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  content.forEach((block, index) => {
    const start =
      block.type === 'tool_use'
        ? { ...block, input: {} }
        : block.type === 'thinking'
          ? { type: 'thinking', thinking: '', signature: '' }
          : { type: 'text', text: '' };
    emit('content_block_start', { index, content_block: start });
    if (block.type === 'tool_use')
      emit('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
    else if (block.type === 'thinking') {
      emit('content_block_delta', {
        index,
        delta: { type: 'thinking_delta', thinking: block.thinking },
      });
      emit('content_block_delta', {
        index,
        delta: { type: 'signature_delta', signature: block.signature },
      });
    } else emit('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    emit('content_block_stop', { index });
  });
  emit('message_delta', {
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  emit('message_stop', {});
  return {
    statusCode: 200,
    stream: true,
    contentType: 'text/event-stream; charset=utf-8',
    wire: Buffer.from(chunks.join('')),
  };
}

module.exports = { claudeSyntheticSse };
