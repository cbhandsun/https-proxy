'use strict';

const assert = require('node:assert/strict');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const {
  parseGeminiImageResponse,
  openAIImageGenerationResponseFromGemini,
} = require('../lib/proxy/openai-images');
const { geminiInlineImageToClaudeBlock } = createGeminiProtocol({});
const request = { n: 1, responseFormat: 'b64_json' };
const imagePart = { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } };
const imageFrame = { candidates: [{ content: { parts: [imagePart] } }] };
const terminal = { candidates: [{ finishReason: 'STOP' }], usageMetadata: {} };
const unwrap = (value) => value && (value.response || value);
const convert = (payload) =>
  openAIImageGenerationResponseFromGemini(payload, request, geminiInlineImageToClaudeBlock, 123);
const sse = (frames) => frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');

for (const body of [
  JSON.stringify(imageFrame),
  JSON.stringify({ response: imageFrame }),
  JSON.stringify([imageFrame, terminal]),
  JSON.stringify([{ response: imageFrame }, { response: terminal }]),
  sse([imageFrame, terminal]) + 'data: [DONE]\n\n',
  sse([{ response: imageFrame }, { response: terminal }]),
  ': heartbeat\r\n\r\n' + sse([imageFrame, terminal]).replace(/\n/g, '\r\n'),
  'event: message\n' + sse([imageFrame, terminal]),
]) {
  assert.deepEqual(convert(parseGeminiImageResponse(body, unwrap)), {
    created: 123,
    data: [{ b64_json: 'aW1hZ2U=' }],
  });
}

for (const body of [
  '',
  '[]',
  'null',
  '42',
  '"secret"',
  '[[]]',
  'data: [DONE]\n\n',
  '{"secret":invalid}',
  sse([imageFrame]) + 'data: {"secret":invalid}\n\n',
  sse([imageFrame, { error: { message: 'secret' } }]),
]) {
  assert.throws(
    () => parseGeminiImageResponse(body, unwrap),
    (error) => {
      assert.ok(!error.message.includes('secret'));
      return true;
    }
  );
}

// Many small candidates must not hit the JavaScript spread argument limit.
const many = { candidates: [...Array(140000).fill(null), ...imageFrame.candidates] };
assert.equal(convert(parseGeminiImageResponse(JSON.stringify(many))).data.length, 1);

for (const payload of [null, {}, { candidates: [null, 1, {}] }]) {
  assert.throws(() => convert(payload), /no image parts/);
}
assert.throws(() => convert({ candidates: [{ finishReason: 'NO_IMAGE' }] }), /NO_IMAGE/);
assert.throws(() => convert({ promptFeedback: { blockReason: 'SAFETY' } }), /SAFETY/);
assert.throws(
  () =>
    convert({
      candidates: [
        {
          finishReason: 'secret',
          content: {
            parts: [{ text: 'secret' }],
          },
        },
      ],
    }),
  (error) => /text only/.test(error.message) && !error.message.includes('secret')
);
assert.throws(
  () =>
    convert({
      candidates: [
        {
          content: { parts: [{ inlineData: { mimeType: 'image/svg+xml', data: 'PHNjcmlwdD4=' } }] },
        },
      ],
    }),
  /invalid or unsupported/
);

// Intermediate thought images/text must not become the final image or revised prompt.
const thoughtPayload = {
  candidates: [
    {
      content: {
        parts: [
          { thought: true, text: 'private reasoning' },
          { thought: true, inlineData: { mimeType: 'image/png', data: 'ZHJhZnQ=' } },
          imagePart,
        ],
      },
    },
  ],
};
assert.deepEqual(convert(thoughtPayload).data, [{ b64_json: 'aW1hZ2U=' }]);
assert.throws(
  () => convert({ candidates: [{ content: { parts: [{ thought: true, ...imagePart }] } }] }),
  /no image parts/
);

console.log('[gemini-image-response.test] ok');
