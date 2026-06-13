const assert = require('assert');

const {
  buildTraeBridgePromptFromOpenAIChat,
  buildTraeBridgeOpenAIChatCompletion,
  normalizeTraeBridgeText,
} = require('../lib/proxy/trae-official');

{
  const imageData = 'data:image/png;base64,ZmFrZS1pbWFnZQ==';
  const result = buildTraeBridgePromptFromOpenAIChat({
    messages: [
      { role: 'system', content: 'Use concise Chinese.' },
      { role: 'developer', content: 'Return only the answer.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '分析这个截图' },
          { type: 'image_url', image_url: { url: imageData } },
        ],
      },
    ],
  });
  assert.ok(result.prompt.includes('System:\nUse concise Chinese.'));
  assert.ok(result.prompt.includes('Developer:\nReturn only the answer.'));
  assert.ok(result.prompt.includes('User:\n分析这个截图\n[image]'));
  assert.strictEqual(result.images.length, 1);
  assert.strictEqual(result.images[0].mimeType, 'image/png');
  assert.strictEqual(result.images[0].base64, 'ZmFrZS1pbWFnZQ==');
}

{
  assert.strictEqual(normalizeTraeBridgeText({ ok: true, text: '你好' }), '你好');
  const response = buildTraeBridgeOpenAIChatCompletion(
    { model: 'trae/GPT-5.4' },
    '桥接成功',
    'gpt-5.4'
  );
  assert.strictEqual(response.object, 'chat.completion');
  assert.strictEqual(response.model, 'gpt-5.4');
  assert.strictEqual(response.choices[0].message.role, 'assistant');
  assert.strictEqual(response.choices[0].message.content, '桥接成功');
}

{
  const chatBody = {
    model: 'trae/gpt-5.4',
    messages: [
      { role: 'user', content: '先看一下状态' },
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: '[Trae plan_item tool=run_command status=success]\n',
            signature: 'trae-process',
          },
          { type: 'text', text: 'OK' },
        ],
      },
      { role: 'user', content: '继续' },
    ],
  };
  const prompt = buildTraeBridgePromptFromOpenAIChat(chatBody).prompt;
  assert.ok(prompt.includes('User:\n先看一下状态'));
  assert.ok(prompt.includes('Assistant:\nOK'));
  assert.ok(prompt.includes('User:\n继续'));
  assert.ok(!prompt.includes('[Trae plan_item'));
  assert.ok(!prompt.includes('trae-process'));
}

console.log('[trae-bridge-protocol.test] ok');
