'use strict';

const usage = Object.freeze({ input_tokens: 1, output_tokens: 1, total_tokens: 2 });

// Fixed synthetic Responses wire only. This is not the production public-output
// encoder: private function calls must remain observable by the recovery owner.
function syntheticCodexWire({ model, sequence, text, call, stream, compact = false }) {
  const id = 'resp_fixture_' + sequence;
  const item = compact
    ? { type: 'compaction', encrypted_content: 'opaque-synthetic-' + sequence }
    : call
      ? {
          type: 'function_call',
          id: 'fc_fixture_' + sequence,
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.args),
        }
      : {
          type: 'message',
          id: 'msg_fixture_' + sequence,
          role: 'assistant',
          status: 'completed',
          phase: 'final_answer',
          content: [{ type: 'output_text', text, annotations: [] }],
        };
  const response = compact
    ? { id, object: 'response.compaction', created_at: sequence, output: [item], usage }
    : { id, object: 'response', model, status: 'completed', output: [item], usage };
  if (!stream)
    return {
      statusCode: 200,
      stream: false,
      contentType: 'application/json; charset=utf-8',
      wire: Buffer.from(JSON.stringify(response)),
    };
  let number = 0;
  const chunks = [];
  const emit = (type, value) =>
    chunks.push(
      'event: ' +
        type +
        '\ndata: ' +
        JSON.stringify({ type, sequence_number: number++, ...value }) +
        '\n\n'
    );
  const start = { ...response, status: 'in_progress', output: [], usage: null };
  emit('response.created', { response: start });
  emit('response.in_progress', { response: start });
  const base = { response_id: id, item_id: item.id, output_index: 0 };
  emit('response.output_item.added', {
    ...base,
    item: call ? { ...item, arguments: '' } : { ...item, status: 'in_progress', content: [] },
  });
  if (call) {
    emit('response.function_call_arguments.delta', { ...base, delta: item.arguments });
    emit('response.function_call_arguments.done', { ...base, arguments: item.arguments });
  } else {
    const detail = { ...base, content_index: 0 },
      part = item.content[0];
    emit('response.content_part.added', { ...detail, part: { ...part, text: '' } });
    emit('response.output_text.delta', { ...detail, delta: text });
    emit('response.output_text.done', { ...detail, text });
    emit('response.content_part.done', { ...detail, part });
  }
  emit('response.output_item.done', { ...base, item });
  emit('response.completed', { response });
  return {
    statusCode: 200,
    stream: true,
    contentType: 'text/event-stream; charset=utf-8',
    wire: Buffer.from(chunks.join('')),
  };
}

module.exports = { syntheticCodexWire };
