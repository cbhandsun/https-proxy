'use strict';

const assert = require('assert');
const {
  MAX_IMAGE_PROMPT_CHARS,
  openAIImageGenerationResponseFromGemini,
  openAIImageGenerationToGemini,
  openAIImageGenerationToResponses,
  parseOpenAIImageGenerationRequest,
  parseOpenAIResponsesImageGenerationPayloads,
  parseOpenAIResponsesImageGenerationResponse,
} = require('../lib/proxy/openai-images');

const valid = parseOpenAIImageGenerationRequest({
  model: 'gemini-3.1-flash-image',
  prompt: 'Draw a red circle.',
  n: '1',
  size: '1024x1024',
  response_format: 'b64_json',
  quality: 'standard',
});
assert.strictEqual(valid.ok, true);
assert.deepStrictEqual(valid.request, {
  model: 'gemini-3.1-flash-image',
  prompt: 'Draw a red circle.',
  n: 1,
  size: '1024x1024',
  responseFormat: 'b64_json',
  options: { quality: 'standard' },
});
assert.deepStrictEqual(openAIImageGenerationToGemini(valid.request), {
  contents: [{ role: 'user', parts: [{ text: 'Draw a red circle.' }] }],
  generationConfig: {
    responseModalities: ['IMAGE'],
    imageConfig: { aspectRatio: '1:1' },
  },
});
assert.deepStrictEqual(openAIImageGenerationToResponses(valid.request, 'gpt-6-astra'), {
  model: 'gpt-6-astra',
  input: [
    {
      role: 'user',
      content: [{ type: 'input_text', text: 'Draw a red circle.' }],
    },
  ],
  tools: [
    {
      type: 'image_generation',
      model: 'gemini-3.1-flash-image',
      size: '1024x1024',
      quality: 'standard',
    },
  ],
  stream: true,
  store: false,
});

for (const body of [
  null,
  [],
  {},
  { model: 'gemini-3.1-flash-image', prompt: '' },
  { model: 'gemini-3.1-flash-image', prompt: 'x'.repeat(MAX_IMAGE_PROMPT_CHARS + 1) },
  { model: 'gemini-3.1-flash-image', prompt: 'x', n: 0 },
  { model: 'gemini-3.1-flash-image', prompt: 'x', n: 2 },
  { model: 'gemini-3.1-flash-image', prompt: 'x', size: '999x999' },
  { model: 'gemini-3.1-flash-image', prompt: 'x', response_format: 'file' },
  { model: 'gemini-3.1-flash-image', prompt: 'x', quality: '<script>' },
  { model: '../secret', prompt: 'x' },
]) {
  const parsed = parseOpenAIImageGenerationRequest(body);
  assert.strictEqual(parsed.ok, false);
  assert.strictEqual(parsed.error.type, 'invalid_request_error');
}

function convertInlineImage(part) {
  const inlineData = part && (part.inlineData || part.inline_data);
  if (!inlineData || inlineData.mimeType !== 'image/png' || !inlineData.data) return null;
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: inlineData.data },
  };
}

const geminiPayload = {
  candidates: [
    {
      content: {
        parts: [
          { text: 'A refined red circle.' },
          { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
        ],
      },
    },
  ],
};
assert.deepStrictEqual(
  openAIImageGenerationResponseFromGemini(geminiPayload, valid.request, convertInlineImage, 123),
  {
    created: 123,
    data: [{ b64_json: 'aW1hZ2U=', revised_prompt: 'A refined red circle.' }],
  }
);

const urlRequest = { ...valid.request, responseFormat: 'url' };
assert.deepStrictEqual(
  openAIImageGenerationResponseFromGemini(geminiPayload, urlRequest, convertInlineImage, 124),
  {
    created: 124,
    data: [
      {
        url: 'data:image/png;base64,aW1hZ2U=',
        revised_prompt: 'A refined red circle.',
      },
    ],
  }
);
assert.throws(
  () => openAIImageGenerationResponseFromGemini({}, valid.request, convertInlineImage),
  /did not contain a valid image/
);
assert.throws(
  () => openAIImageGenerationResponseFromGemini(geminiPayload, valid.request, null),
  /converter is unavailable/
);

assert.deepStrictEqual(
  parseOpenAIResponsesImageGenerationResponse(
    {
      output: [
        {
          type: 'image_generation_call',
          result: 'cmVzcG9uc2UtaW1hZ2U=',
          revised_prompt: 'A refined prompt.',
        },
      ],
    },
    valid.request,
    125
  ),
  {
    created: 125,
    data: [{ b64_json: 'cmVzcG9uc2UtaW1hZ2U=', revised_prompt: 'A refined prompt.' }],
  }
);
assert.deepStrictEqual(
  parseOpenAIResponsesImageGenerationResponse(
    {
      type: 'response.completed',
      response: {
        output: [{ type: 'image_generation_call', result: 'cmVzcG9uc2UtaW1hZ2U=' }],
      },
    },
    urlRequest,
    126
  ),
  {
    created: 126,
    data: [{ url: 'data:image/png;base64,cmVzcG9uc2UtaW1hZ2U=' }],
  }
);
assert.throws(
  () => parseOpenAIResponsesImageGenerationResponse({ output: [] }, valid.request),
  /did not return an image/
);
const streamedFrames = parseOpenAIResponsesImageGenerationPayloads(
  [
    'data: {"type":"response.created","response":{"id":"resp_1"}}',
    'data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"c3RyZWFtLWltYWdl"}}',
    'data: {"type":"response.done"}',
    'data: [DONE]',
  ].join('\n\n')
);
assert.deepStrictEqual(
  parseOpenAIResponsesImageGenerationResponse(streamedFrames, valid.request, 127),
  {
    created: 127,
    data: [{ b64_json: 'c3RyZWFtLWltYWdl' }],
  }
);
assert.deepStrictEqual(
  parseOpenAIResponsesImageGenerationResponse(
    [{ type: 'response.image_generation_call.partial_image', partial_image_b64: 'cGFydGlhbA==' }],
    valid.request,
    128
  ),
  {
    created: 128,
    data: [{ b64_json: 'cGFydGlhbA==' }],
  }
);
assert.throws(
  () => parseOpenAIResponsesImageGenerationPayloads('data: not-json\n\n'),
  /invalid JSON/
);

console.log('[openai-images.test] ok');
