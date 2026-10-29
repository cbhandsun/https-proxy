'use strict';

// Header-routing fixtures must also complete the real response converters.
// No credentials, request bodies or private evidence enter these responses.
function protocolUpstreamResponse(pathname) {
  if (typeof pathname !== 'string') throw new TypeError('Invalid fixture pathname');
  if (pathname.includes('/chat/completions'))
    return {
      id: 'fixture-chat',
      object: 'chat.completion',
      created: 1,
      model: 'fixture',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'fixture' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  if (pathname.includes('/responses'))
    return {
      id: 'fixture-response',
      object: 'response',
      status: 'completed',
      model: 'fixture',
      output: [
        {
          id: 'fixture-output',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'fixture', annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
  if (pathname.includes('GenerateContent') || pathname.includes('generateContent')) {
    const response = {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'fixture' }] },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    };
    return pathname.includes('v1internal') ? { response } : response;
  }
  if (pathname.includes('/messages'))
    return {
      id: 'fixture-message',
      type: 'message',
      role: 'assistant',
      model: 'fixture',
      content: [{ type: 'text', text: 'fixture' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  return { ok: true };
}

module.exports = { protocolUpstreamResponse };
