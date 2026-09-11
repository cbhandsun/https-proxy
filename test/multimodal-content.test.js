'use strict';

const assert = require('node:assert/strict');
const {
  inspectOpenAIMultimodalPart,
  normalizeMediaType,
  validateClaudeMultimodalBlock,
} = require('../lib/proxy/multimodal-content');
const { createRequestValidators } = require('../lib/proxy/handlers/request-validators');

const image = inspectOpenAIMultimodalPart({
  type: 'image_url',
  image_url: { url: 'data:image/png;base64,aW1hZ2U=' },
});
assert.strictEqual(image.ok, true);
assert.deepStrictEqual(image.block, {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
});

const audio = inspectOpenAIMultimodalPart({
  type: 'input_audio',
  input_audio: { data: 'YXVkaW8=', format: 'wav' },
});
assert.strictEqual(audio.ok, true);
assert.strictEqual(audio.block.source.media_type, 'audio/wav');

const video = inspectOpenAIMultimodalPart({
  type: 'input_video',
  input_video: { url: 'data:video/webm;base64,dmlkZW8=' },
});
assert.strictEqual(video.ok, true);
assert.strictEqual(video.block.type, 'video');

assert.strictEqual(normalizeMediaType('audio', 'MP3'), 'audio/mpeg');
assert.strictEqual(normalizeMediaType('video', 'audio/mp3'), '');
assert.strictEqual(
  inspectOpenAIMultimodalPart({
    type: 'image_url',
    image_url: { url: 'https://example.com/private.png' },
  }).ok,
  false
);
assert.strictEqual(
  inspectOpenAIMultimodalPart({
    type: 'input_audio',
    input_audio: { data: '', format: 'wav' },
  }).ok,
  false
);
assert.strictEqual(
  inspectOpenAIMultimodalPart({
    type: 'input_video',
    input_video: { data: 'not-base64!', format: 'mp4' },
  }).ok,
  false
);
assert.match(
  inspectOpenAIMultimodalPart(
    { type: 'input_audio', input_audio: { data: 'YXVkaW8=', format: 'wav' } },
    { maxBytes: 3 }
  ).error,
  /exceeds/
);

const inherited = Object.create({ data: 'YXVkaW8=', format: 'wav' });
assert.strictEqual(
  inspectOpenAIMultimodalPart({ type: 'input_audio', input_audio: inherited }).ok,
  false
);
assert.strictEqual(
  validateClaudeMultimodalBlock({
    type: 'audio',
    source: { type: 'url', url: 'https://example.com/audio.wav' },
  }).ok,
  false
);

let response = null;
const validators = createRequestValidators({
  sendJsonError(_clientRes, statusCode, payload) {
    response = { statusCode, payload };
  },
});

assert.strictEqual(
  validators.rejectUnsupportedOpenAIChatNonOpenAIConversion(
    {},
    {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_audio', input_audio: { data: 'YXVkaW8=', format: 'wav' } },
            { type: 'video_url', video_url: { url: 'data:video/mp4;base64,dmlkZW8=' } },
          ],
        },
      ],
    },
    'Gemini'
  ),
  false
);

assert.strictEqual(
  validators.rejectUnsupportedResponsesNonOpenAIConversion(
    {},
    {
      input: [
        {
          type: 'message',
          content: [
            { type: 'input_audio', input_audio: { data: 'YXVkaW8=', format: 'wav' } },
            { type: 'input_video', input_video: { data: 'dmlkZW8=', format: 'mp4' } },
          ],
        },
      ],
    },
    'Gemini'
  ),
  false
);

assert.strictEqual(
  validators.rejectUnsupportedOpenAIChatNonOpenAIConversion(
    {},
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data: 'YXVkaW8=', format: 'wav' } }],
        },
      ],
    },
    'Claude'
  ),
  true
);
assert.strictEqual(response.statusCode, 400);
assert.match(response.payload.error.message, /audio input cannot be converted to Claude/);

const secret = '<script>secret-token</script>';
assert.strictEqual(
  validators.rejectUnsupportedOpenAIChatNonOpenAIConversion(
    {},
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'video_url', video_url: { data: secret, format: 'mp4' } }],
        },
      ],
    },
    'Gemini'
  ),
  true
);
assert.strictEqual(response.statusCode, 400);
assert.doesNotMatch(response.payload.error.message, /script|secret-token/i);

console.log('[multimodal-content.test] ok');
