const assert = require('assert');
const {
  applyChatStreamingPolicy,
  applyResponseStreamingPolicy,
  isChatStreamingForced,
  isResponseStreamingEnabled,
  isResponseStreamingForced,
  jsonRequestStreamingPreference,
  responseStreamingRolloutPercent,
  stablePercentageBucket,
} = require('../lib/proxy/performance-policy');

const prepared = { buffer: Buffer.from(JSON.stringify({ model: 'gpt', input: 'hello' })) };
const unchanged = applyResponseStreamingPolicy(prepared, {
  enabled: true,
  isResponsesRequest: false,
});
assert.strictEqual(unchanged, prepared);

const streamed = applyResponseStreamingPolicy(prepared, {
  enabled: true,
  isResponsesRequest: true,
});
assert.notStrictEqual(streamed, prepared);
assert.strictEqual(JSON.parse(streamed.buffer.toString()).stream, true);
assert.strictEqual(streamed.bodyChanged, true);
assert.strictEqual(
  applyResponseStreamingPolicy(prepared, {
    enabled: true,
    isResponsesRequest: true,
    requestEncoding: 'gzip',
  }),
  prepared
);
assert.strictEqual(
  isResponseStreamingForced({ appSettings: { forceResponseStreaming: true } }),
  true
);
assert.strictEqual(isResponseStreamingForced({ appSettings: {} }), false);
assert.strictEqual(responseStreamingRolloutPercent({ appSettings: {} }), 0);
assert.strictEqual(
  responseStreamingRolloutPercent({ appSettings: { responseStreamingRolloutPercent: 125 } }),
  100
);
assert.strictEqual(
  responseStreamingRolloutPercent({ appSettings: { responseStreamingRolloutPercent: -5 } }),
  0
);
assert.strictEqual(
  isResponseStreamingEnabled(
    { appSettings: { responseStreamingRolloutPercent: 100 } },
    'request-1'
  ),
  true
);
assert.strictEqual(
  isResponseStreamingEnabled({ appSettings: { responseStreamingRolloutPercent: 0 } }, 'request-1'),
  false
);
assert.strictEqual(
  isResponseStreamingEnabled({ appSettings: { responseStreamingRolloutPercent: 50 } }, ''),
  false,
  'rollout must fail closed without a stable selection key'
);
assert.strictEqual(stablePercentageBucket('same-request'), stablePercentageBucket('same-request'));
assert.strictEqual(
  isResponseStreamingEnabled(
    { appSettings: { forceResponseStreaming: true, responseStreamingRolloutPercent: 0 } },
    ''
  ),
  true,
  'the explicit compatibility override must remain supported'
);

const streamedChat = applyChatStreamingPolicy(prepared, {
  enabled: true,
  isChatRequest: true,
});
assert.notStrictEqual(streamedChat, prepared);
assert.strictEqual(JSON.parse(streamedChat.buffer.toString()).stream, true);
assert.strictEqual(streamedChat.forcedChatStreaming, true);
assert.strictEqual(
  applyChatStreamingPolicy(prepared, {
    enabled: true,
    isChatRequest: false,
  }),
  prepared
);
assert.strictEqual(isChatStreamingForced({ appSettings: { forceChatStreaming: true } }), true);
assert.strictEqual(isChatStreamingForced({ appSettings: {} }), false);
assert.strictEqual(jsonRequestStreamingPreference(prepared), false);
assert.strictEqual(
  jsonRequestStreamingPreference({ buffer: Buffer.from('{"stream":true}') }),
  true
);
assert.strictEqual(jsonRequestStreamingPreference({ buffer: Buffer.from('{bad') }), null);
assert.strictEqual(jsonRequestStreamingPreference(prepared, 'gzip'), null);
assert.strictEqual(jsonRequestStreamingPreference({ buffer: Buffer.from('[]') }), null);

console.log('[performance-policy.test] ok');
