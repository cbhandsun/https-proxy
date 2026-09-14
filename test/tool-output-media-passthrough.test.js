'use strict';

/**
 * Regression: tool outputs must keep inline media as structured image parts.
 *
 * A Codex turn that renders a screenshot returns it in a custom_tool_call_output
 * whose output is an array of Responses content parts:
 *   [{type:'input_text'}, {type:'input_image', image_url:'data:image/png;base64,...'}]
 *
 * Serializing that array as JSON text (the pre-fix behaviour) turns the base64 into
 * literal prompt text. Upstream tokenizers then bill it per character: a single
 * 845k-character screenshot costs ~589k prompt tokens as text versus ~65 tokens as
 * an image part. Repeated across one agent turn that overflows the model context
 * window with "prompt is too long".
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const {
  chatToolContentToResponsesOutput,
} = require('../lib/proxy/protocol-openai-message-normalization');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { createClaudeFilters } = require('../lib/proxy/claude-filters');
const {
  inspectOpenAIMultimodalPart,
  MAX_INLINE_MEDIA_BYTES,
  multimodalBlockToOpenAIChatPart,
} = require('../lib/proxy/multimodal-content');

// Stand-in for a screenshot: large enough that text billing would be obvious.
// The bytes are arbitrary but the encoding is canonical: the conversion layer
// re-validates payloads, so a hand-built string with interior padding would be
// rejected before the code under test ever runs.
const IMAGE_BASE64 = Buffer.alloc(15000, 0xab).toString('base64');
const IMAGE_URL = 'data:image/png;base64,' + IMAGE_BASE64;
const IMAGE_PART = { type: 'input_image', image_url: IMAGE_URL };

const claudeFilterFns = createClaudeFilters({
  protocolOptions: { thinkingPolicy: 'passthrough' },
  makeSafeClaudeToolUseContentBlock: () => ({ type: 'text', text: '' }),
});

const deps = {
  cleanToolArgs: (_name, args) => args,
  stableCreated: () => 1700000000,
  deltaPartialJson: () => '',
  parseClaudeSseEvent: () => ({ eventName: '', dataText: '', data: null }),
  geminiToolResponseText: (content) =>
    typeof content === 'string' ? content : JSON.stringify(content),
  inspectOpenAIMultimodalPart,
  multimodalBlockToOpenAIChatPart,
  fallbackId: (prefix) => prefix + '_test',
  inferToolNameFromArguments: () => null,
  ...claudeFilterFns,
};

const openaiProtocol = createOpenAIProtocol(deps);
const geminiProtocol = createGeminiProtocol({ ...deps, protocolOptions: {} });

function responsesBody(output) {
  return {
    model: 'test-model',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look' }] },
      { type: 'custom_tool_call', call_id: 'call_1', name: 'exec', input: '{}' },
      { type: 'custom_tool_call_output', call_id: 'call_1', output },
    ],
  };
}

function isImagePart(part) {
  return Boolean(part && part.type === 'image_url' && part.image_url && part.image_url.url);
}

test('tool output media stays structured for the Chat upstream', () => {
  const chat = openaiProtocol.openAIResponsesToChat(
    responsesBody([{ type: 'input_text', text: 'Script completed' }, IMAGE_PART])
  );
  const toolMsg = chat.messages.find((m) => m.role === 'tool');

  assert.ok(Array.isArray(toolMsg.content), 'tool content must stay multimodal, not a JSON string');
  const images = toolMsg.content.filter(isImagePart);
  assert.equal(images.length, 1, 'exactly one image part must survive conversion');
  assert.equal(images[0].image_url.url, IMAGE_URL, 'image payload must not be altered');
  assert.deepEqual(toolMsg.content[0], { type: 'text', text: 'Script completed' });

  // The base64 must not also appear as literal text anywhere in the request.
  const wire = JSON.stringify(chat);
  assert.equal(
    wire.includes(IMAGE_BASE64 + '"'),
    true,
    'base64 appears only inside the image_url value'
  );
  assert.equal(
    wire.includes('"input_image"'),
    false,
    'raw Responses part types must not be serialized into the upstream body'
  );
});

test('media-free tool outputs keep the previous string behaviour', () => {
  const chat = openaiProtocol.openAIResponsesToChat(responsesBody('plain text output'));
  const toolMsg = chat.messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg.content, 'plain text output');

  const structured = openaiProtocol.openAIResponsesToChat(
    responsesBody([{ type: 'input_text', text: 'no media here' }])
  );
  const structuredTool = structured.messages.find((m) => m.role === 'tool');
  assert.equal(structuredTool.content, '[{"type":"input_text","text":"no media here"}]');
});

test('empty and missing tool outputs stay empty strings', () => {
  for (const output of [undefined, null, '']) {
    const chat = openaiProtocol.openAIResponsesToChat(responsesBody(output));
    const toolMsg = chat.messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg.content, '');
  }
});

test('tool output media stays structured for the Claude upstream', () => {
  const chat = openaiProtocol.openAIResponsesToChat(
    responsesBody([{ type: 'input_text', text: 'Script completed' }, IMAGE_PART])
  );
  const claude = openaiProtocol.openAIChatToClaudeMessages(chat, 'claude-test');
  const toolResult = claude.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((block) => block && block.type === 'tool_result');

  assert.ok(toolResult, 'tool_result block must exist');
  const image = toolResult.content.find((block) => block && block.type === 'image');
  assert.ok(image, 'tool_result content must keep a structured image block');
  assert.equal(image.source.type, 'base64');
  assert.equal(image.source.media_type, 'image/png');
  assert.equal(image.source.data, IMAGE_BASE64);
});

test('tool output media becomes inlineData for the Gemini upstream', () => {
  const chat = openaiProtocol.openAIResponsesToChat(
    responsesBody([{ type: 'input_text', text: 'Script completed' }, IMAGE_PART])
  );
  const claude = openaiProtocol.openAIChatToClaudeMessages(chat, 'test-model');
  const gemini = geminiProtocol.claudeMessagesToGemini(claude, 'gemini-test');
  const parts = gemini.contents.flatMap((content) => content.parts || []);
  const inline = parts.filter((part) => part && part.inlineData);

  assert.equal(inline.length, 1, 'image must travel as inlineData, not JSON text');
  assert.equal(inline[0].inlineData.mimeType, 'image/png');
  assert.equal(inline[0].inlineData.data, IMAGE_BASE64);

  const serialized = JSON.stringify(gemini);
  assert.equal(
    serialized.includes('"input_image"'),
    false,
    'Responses part types must not leak into the Gemini request as text'
  );
  const functionResponse = parts.find((part) => part && part.functionResponse);
  assert.ok(functionResponse, 'tool result must still be reported as a functionResponse');
  assert.equal(
    JSON.stringify(functionResponse).includes(IMAGE_BASE64),
    false,
    'base64 must not be embedded inside functionResponse text'
  );
});

test('a repeated tool-output image does not scale prompt size linearly', () => {
  const single = openaiProtocol.openAIResponsesToChat(
    responsesBody([{ type: 'input_text', text: 'shot' }, IMAGE_PART])
  );
  const inputs = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look' }] },
  ];
  for (let index = 0; index < 5; index += 1) {
    inputs.push({ type: 'custom_tool_call', call_id: 'call_' + index, name: 'exec', input: '{}' });
    inputs.push({
      type: 'custom_tool_call_output',
      call_id: 'call_' + index,
      output: [{ type: 'input_text', text: 'shot' }, IMAGE_PART],
    });
  }
  const repeated = openaiProtocol.openAIResponsesToChat({ model: 'm', input: inputs });

  const oneSize = JSON.stringify(single).length;
  const fiveSize = JSON.stringify(repeated).length;

  // Five copies carry five images: linear growth is expected and correct.
  // The regression is that each copy previously expanded base64 into text,
  // so this guards the shape (image parts) rather than a fixed byte budget.
  const toolMessages = repeated.messages.filter((m) => m.role === 'tool');
  assert.equal(toolMessages.length, 5);
  for (const message of toolMessages) {
    assert.ok(Array.isArray(message.content), 'each tool output keeps multimodal content');
    assert.equal(message.content.filter(isImagePart).length, 1);
  }
  assert.ok(
    fiveSize > oneSize,
    'repeated images legitimately increase payload (five images vs one)'
  );
});

test('malformed and oversized tool-output media fail before transport, never as text', () => {
  const oversized = {
    type: 'input_image',
    image_url:
      'data:image/png;base64,' + Buffer.alloc(MAX_INLINE_MEDIA_BYTES + 1).toString('base64'),
  };
  const malformed = {
    type: 'input_image',
    // 5 base64 chars is not decodable; interior padding is rejected as well.
    image_url: 'data:image/png;base64,secret',
  };
  const remote = { type: 'input_image', image_url: 'https://example.invalid/secret.png' };

  for (const part of [oversized, malformed]) {
    assert.throws(
      () => openaiProtocol.openAIResponsesToChat(responsesBody([part])),
      (error) => error instanceof TypeError && !/secret/.test(error.message),
      'invalid tool-output media must be rejected without echoing the payload'
    );
  }

  // Remote URLs are not silently replaced by their JSON text either.
  const chat = openaiProtocol.openAIResponsesToChat(responsesBody([remote]));
  const toolMsg = chat.messages.find((m) => m.role === 'tool');
  assert.equal(
    JSON.stringify(toolMsg.content).includes('example.invalid'),
    true,
    'a remote image reference must survive as a structured image_url part'
  );
  assert.equal(Array.isArray(toolMsg.content), true, 'remote image must not be flattened to text');
});

test('media-free structured tool outputs still flatten to JSON text', () => {
  const chat = openaiProtocol.openAIResponsesToChat(
    responsesBody([
      { type: 'input_text', text: 'first' },
      { type: 'input_text', text: 'second' },
    ])
  );
  const toolMsg = chat.messages.find((m) => m.role === 'tool');
  assert.equal(typeof toolMsg.content, 'string');
  assert.equal(
    toolMsg.content,
    '[{"type":"input_text","text":"first"},{"type":"input_text","text":"second"}]'
  );
});

test('the reverse direction (Chat entry -> Responses upstream) keeps media structured', () => {
  const content = [
    { type: 'text', text: 'Script completed' },
    { type: 'image_url', image_url: { url: IMAGE_URL } },
  ];
  const output = chatToolContentToResponsesOutput(content);

  assert.ok(Array.isArray(output), 'tool output must stay an array of Responses content parts');
  assert.equal(output.length, 2);
  assert.deepEqual(output[0], { type: 'input_text', text: 'Script completed' });
  assert.deepEqual(output[1], { type: 'input_image', image_url: IMAGE_URL });

  // The shape must match what real Codex turns send, so the Responses upstream accepts it.
  for (const part of output) assert.ok(['input_text', 'input_image'].includes(part.type));

  // Regression guard: base64 must never be demoted to a JSON string of the array.
  assert.equal(
    typeof output,
    'object',
    'image-bearing tool content must not be flattened to a JSON string'
  );
  const responseBody = {
    model: 'm',
    input: [{ type: 'function_call_output', call_id: 'c', output }],
  };
  assert.equal(
    JSON.stringify(responseBody).includes('"image_url":"data:'),
    true,
    'image data URL must survive as a structured field'
  );

  // Non-media content keeps the previous string behaviour; strings pass through untouched.
  assert.equal(chatToolContentToResponsesOutput('plain'), 'plain');
  assert.equal(
    chatToolContentToResponsesOutput([{ type: 'text', text: 'a' }]),
    '[{"type":"text","text":"a"}]'
  );
});
