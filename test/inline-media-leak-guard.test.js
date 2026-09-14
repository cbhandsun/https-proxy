'use strict';

/**
 * Regression: no protocol converter may flatten inline media base64 into a text
 * field. The original incident (commit c38805d) fixed the tool-output arrays. A
 * follow-up sweep found the same defect class in the JSON fallbacks of the
 * Responses -> Chat normalizer, the Claude system/response helpers, and the Gemini
 * generic part converters. Serializing base64 as text makes upstream tokenizers
 * bill it per character, which is what blew the context window.
 *
 * These tests drive the production wiring (openai-proxy.js) and only pass when
 * every reachable branch redacts or preserves inline media structurally.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-inline-media-leak-'));
process.env.PROXY_CONFIG_DIR = path.join(runtimeDir, 'config');
process.env.PROXY_RUNTIME_DIR = path.join(runtimeDir, 'runtime');
process.env.NODE_ENV = 'test';

const proxy = require('../openai-proxy');
const {
  INLINE_MEDIA_PLACEHOLDER,
  estimateTokensForValue,
  isInlineMediaPart,
  redactInlineMedia,
  stringifyWithoutInlineMedia,
} = require('../lib/proxy/inline-media');

const BASE64 = Buffer.alloc(4096, 0xab).toString('base64');
const DATA_URL = 'data:image/png;base64,' + BASE64;
const IMAGE_BLOCK = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: BASE64 },
};

/** True only when a string is exactly a legitimate media carrier. */
function isLegitimateMediaString(text) {
  const trimmed = text.trim();
  if (trimmed === BASE64) return true;
  return /^data:[^,]*,[A-Za-z0-9+/=]+$/.test(trimmed);
}

/** Walk a converted payload and report paths where base64 leaked into text. */
function leakedTextPaths(node, jsonPath, hits = []) {
  if (typeof node === 'string') {
    if (node.includes(BASE64) && !isLegitimateMediaString(node)) hits.push(jsonPath);
    return hits;
  }
  if (!node || typeof node !== 'object') return hits;
  if (Array.isArray(node)) {
    node.forEach((item, index) => leakedTextPaths(item, jsonPath + '[' + index + ']', hits));
    return hits;
  }
  for (const [key, value] of Object.entries(node)) {
    leakedTextPaths(value, key === 'data' ? 'data' : jsonPath + '.' + key, hits);
  }
  return hits;
}

function assertNoInlineMediaLeak(label, converted) {
  assert.deepStrictEqual(
    leakedTextPaths(converted, '$'),
    [],
    label + ' must not flatten inline media base64 into a text field'
  );
}

// --- Responses -> Chat fallbacks ---

assertNoInlineMediaLeak(
  'responses top-level media item',
  proxy.openAIResponsesToChat({
    model: 'm',
    input: [{ type: 'input_image', image_url: DATA_URL }],
  })
);

assertNoInlineMediaLeak(
  'responses media item without a type',
  proxy.openAIResponsesToChat({
    model: 'm',
    input: [{ output: [{ type: 'input_image', image_url: DATA_URL }] }],
  })
);

assertNoInlineMediaLeak(
  'responses web search result carrying media',
  proxy.openAIResponsesToChat({
    model: 'm',
    input: [{ type: 'web_search_result', result: [{ type: 'input_image', image_url: DATA_URL }] }],
  })
);

assertNoInlineMediaLeak(
  'responses web search call output carrying media',
  proxy.openAIResponsesToChat({
    model: 'm',
    input: [
      { type: 'web_search_call_output', output: [{ type: 'input_image', image_url: DATA_URL }] },
    ],
  })
);

assertNoInlineMediaLeak(
  'responses reasoning carrying media',
  proxy.openAIResponsesToChat({
    model: 'm',
    input: [{ type: 'reasoning', content: [{ type: 'input_image', image_url: DATA_URL }] }],
  })
);

assertNoInlineMediaLeak(
  'responses message with an unknown content part',
  proxy.openAIResponsesToChat({
    model: 'm',
    input: [{ type: 'message', role: 'user', content: [{ type: 'mystery', payload: DATA_URL }] }],
  })
);

assertNoInlineMediaLeak(
  'responses tool output sent as a single media object',
  proxy.openAIResponsesToChat({
    model: 'm',
    input: [
      {
        type: 'function_call_output',
        call_id: 'c1',
        output: { type: 'input_image', image_url: DATA_URL },
      },
    ],
  })
);

assertNoInlineMediaLeak(
  'responses tool output nested object holding media',
  proxy.openAIResponsesToChat({
    model: 'm',
    input: [
      {
        type: 'function_call_output',
        call_id: 'c1',
        output: { content: [{ type: 'input_image', image_url: DATA_URL }] },
      },
    ],
  })
);

// --- Claude -> OpenAI ---

assertNoInlineMediaLeak(
  'claude system image block',
  proxy.claudeMessagesToOpenAIChat(
    { model: 'm', system: [IMAGE_BLOCK], messages: [{ role: 'user', content: 'hi' }] },
    'gpt-5'
  )
);

// Intentional exception: image-generation results are returned to the *client* as
// renderable markdown (`![generated image](data:...)`), covered by
// test/protocol-openai.test.js and test/responses-gemini-multimodal.test.js.
// That response never re-enters a prompt as text, so it is not a leak site.
const generatedImageResponse = proxy.claudeResponseToOpenAIChat(
  { id: 'r1', content: [IMAGE_BLOCK] },
  'gpt-5'
);
assert.strictEqual(
  generatedImageResponse.choices[0].message.content,
  '![generated image](' + DATA_URL + ')'
);

assertNoInlineMediaLeak(
  'claude user media block with a non-standard shape',
  proxy.claudeMessagesToOpenAIChat(
    {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'input_image', image_url: DATA_URL },
          ],
        },
      ],
    },
    'gpt-5'
  )
);

// --- Claude -> Gemini ---

assertNoInlineMediaLeak(
  'claude system image block for Gemini',
  proxy.claudeMessagesToGemini(
    { model: 'm', system: [IMAGE_BLOCK], messages: [{ role: 'user', content: 'hi' }] },
    'gemini-3.8-flash'
  )
);

assertNoInlineMediaLeak(
  'unknown gemini part with an inline data payload',
  proxy.geminiResponseToClaude(
    {
      candidates: [
        {
          content: { parts: [{ inlineData: { mimeType: 'image/png', data: BASE64 }, extra: 'x' }] },
          finishReason: 'STOP',
        },
      ],
    },
    'gemini-3.8-flash'
  )
);

// --- Behavioural guards ---

// Media-free payloads keep their previous JSON shape (no accidental placeholder).
assert.strictEqual(
  stringifyWithoutInlineMedia([{ type: 'input_text', text: 'no media here' }]),
  '[{"type":"input_text","text":"no media here"}]'
);

// Remote URLs are not mistaken for inline media and keep being counted as text.
assert.strictEqual(isInlineMediaPart({ type: 'input_image', image_url: 'https://x/y.png' }), false);
assert.strictEqual(
  stringifyWithoutInlineMedia({ type: 'input_image', image_url: 'https://x/y.png' }),
  '{"type":"input_image","image_url":"https://x/y.png"}'
);

// The literal "[inline media omitted]" marker appears where the base64 used to be.
const redacted = stringifyWithoutInlineMedia({
  type: 'function_call_output',
  output: [{ type: 'input_image', image_url: DATA_URL }],
});
assert.ok(redacted.includes(INLINE_MEDIA_PLACEHOLDER));
assert.strictEqual(redacted.includes(BASE64), false);

// --- Token estimate ---

// A 4096-byte image part is one media charge, not `base64 chars / 4` tokens.
assert.strictEqual(estimateTokensForValue({ type: 'input_image', image_url: DATA_URL }), 100);
assert.ok(
  estimateTokensForValue({ type: 'input_image', image_url: DATA_URL }) <
    estimateTokensForValue(DATA_URL),
  'inline media must estimate far below its base64 character count'
);
assert.strictEqual(
  estimateTokensForValue({ text: 'abcd', image: { type: 'input_image', image_url: DATA_URL } }),
  101
);

// Text-only structures keep the previous length/4 behaviour.
assert.strictEqual(
  estimateTokensForValue({ text: '12345678', arr: ['1234', null], flag: true }),
  4
);

// Empty and malformed media must not create false media charges: the carrier is
// counted as ordinary short text, never as a 100-token media block.
assert.ok(estimateTokensForValue({ type: 'input_image', image_url: '' }) < 100);
assert.strictEqual(isInlineMediaPart({ type: 'input_image', image_url: 'not-base64' }), false);
assert.strictEqual(isInlineMediaPart(null), false);
assert.strictEqual(isInlineMediaPart([]), false);

// redactInlineMedia must not mutate the input.
const original = { type: 'input_image', image_url: DATA_URL };
redactInlineMedia(original);
assert.strictEqual(original.image_url, DATA_URL);

fs.rmSync(runtimeDir, { recursive: true, force: true });
console.log('[inline-media-leak-guard.test] ok');
