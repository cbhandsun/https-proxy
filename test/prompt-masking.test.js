'use strict';

const assert = require('assert');
const {
  resolvePromptMaskingOptions,
  createPromptMaskState,
  maskPromptText,
  maskJsonPayloadValue,
  unmaskText,
  createStreamingUnmasker,
  installResponseUnmasking,
  applyBidirectionalPromptMasking,
} = require('../lib/proxy/prompt-masking');

// 1. Options resolution
assert.deepStrictEqual(resolvePromptMaskingOptions(null, null), {
  enabled: false,
  maskEmails: false,
  maskPrivateIps: false,
  customKeywords: [],
});
assert.deepStrictEqual(resolvePromptMaskingOptions({ promptMasking: true }, null), {
  enabled: true,
  maskEmails: false,
  maskPrivateIps: false,
  customKeywords: [],
});
assert.deepStrictEqual(
  resolvePromptMaskingOptions(
    {
      promptMasking: { enabled: true, maskEmails: true, maskPrivateIps: true },
      promptMaskingKeywords: 'ProjectApollo, corp.internal.local, ab',
    },
    null
  ),
  {
    enabled: true,
    maskEmails: true,
    maskPrivateIps: true,
    customKeywords: ['corp.internal.local', 'ProjectApollo'],
  }
);

// 2. Secret & PII detection and round-trip unmasking
const state = createPromptMaskState({ salt: 'a1b2c3' });
const sampleOpenAiKey = 'sk-proj-1234567890abcdefghijklmnop';
const sampleAnthropicKey = 'sk-ant-api03-1234567890abcdefghijklmnop';
const sampleGithubToken = 'ghp_1234567890abcdefghijklmnopqrstuvwx';
const sampleDbUri = 'postgres://admin:SuperSecretPwd123@db.internal.example.com:5432/prod';
const sampleEnvLine = 'DEEPSEEK_API_KEY="dsk_live_9876543210secretvalue"';
const sampleEmail = 'developer@corp.internal.io';
const sampleIp = '192.168.10.45';

const rawPrompt = [
  `OpenAI: ${sampleOpenAiKey}`,
  `Claude: ${sampleAnthropicKey}`,
  `GitHub: ${sampleGithubToken}`,
  `DB: ${sampleDbUri}`,
  sampleEnvLine,
  `Contact: ${sampleEmail} at ${sampleIp} or 127.0.0.1`,
].join('\n');

const maskedPrompt = maskPromptText(rawPrompt, state, {
  maskEmails: true,
  maskPrivateIps: true,
});

assert.ok(!maskedPrompt.includes(sampleOpenAiKey), 'OpenAI key should be masked');
assert.ok(!maskedPrompt.includes(sampleAnthropicKey), 'Anthropic key should be masked');
assert.ok(!maskedPrompt.includes(sampleGithubToken), 'GitHub token should be masked');
assert.ok(!maskedPrompt.includes('SuperSecretPwd123'), 'DB URI password should be masked');
assert.ok(!maskedPrompt.includes('dsk_live_9876543210secretvalue'), 'Env secret should be masked');
assert.ok(maskedPrompt.includes('DEEPSEEK_API_KEY="'), 'Env variable name should be preserved');
assert.ok(!maskedPrompt.includes(sampleEmail), 'Email should be masked when maskEmails=true');
assert.ok(!maskedPrompt.includes(sampleIp), 'Private IP should be masked when maskPrivateIps=true');
assert.ok(maskedPrompt.includes('127.0.0.1'), 'Loopback IP 127.0.0.1 should not be masked');

const restoredPrompt = unmaskText(maskedPrompt, state.tokenToSecret);
assert.strictEqual(restoredPrompt, rawPrompt, 'Unmasked text must match original byte-for-byte');

// 3. Structural keys in JSON payloads are preserved while message contents are masked
const payloadState = createPromptMaskState({ salt: 'deadbe' });
const payload = {
  model: 'claude-sonnet-4-6',
  messages: [
    {
      role: 'user',
      content: `Please check why ${sampleOpenAiKey} fails.`,
    },
  ],
};
const maskedPayload = maskJsonPayloadValue(payload, payloadState, { enabled: true });
assert.strictEqual(maskedPayload.model, 'claude-sonnet-4-6');
assert.strictEqual(maskedPayload.messages[0].role, 'user');
assert.strictEqual(
  maskedPayload.messages[0].content,
  'Please check why __HPM_MASK_1_deadbe__ fails.'
);

// 4. Streaming SSE unmasker handles tokens split across arbitrary chunk boundaries
const unmasker = createStreamingUnmasker(payloadState.tokenToSecret, { jsonSafe: true });
const sseStream =
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"The key __HPM_MASK_1_deadbe__ is revoked."}}\n\n';
// Split right in the middle of __HPM_MASK_1_deadbe__
const part1 = sseStream.slice(0, sseStream.indexOf('__HPM_MASK_') + 6);
const part2 = sseStream.slice(sseStream.indexOf('__HPM_MASK_') + 6, sseStream.indexOf('deadbe') + 3);
const part3 = sseStream.slice(sseStream.indexOf('deadbe') + 3);

const out1 = unmasker.push(Buffer.from(part1, 'utf8'));
const out2 = unmasker.push(Buffer.from(part2, 'utf8'));
const out3 = unmasker.push(Buffer.from(part3, 'utf8')) + unmasker.flush();
const combinedOut = out1 + out2 + out3;
assert.ok(
  combinedOut.includes(`The key ${sampleOpenAiKey} is revoked.`),
  'Split placeholder across SSE chunks must be restored'
);

// 5. End-to-end applyBidirectionalPromptMasking + installResponseUnmasking
const chunks = [];
let removedHeaders = [];
const mockRes = {
  writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers;
  },
  removeHeader(name) {
    removedHeaders.push(name.toLowerCase());
  },
  write(chunk) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    return true;
  },
  end(chunk) {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
  },
};

const prepared = {
  profile: { id: 'deepseek', promptMasking: true },
  buffer: Buffer.from(
    JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: `My token is ${sampleGithubToken}` }],
    }),
    'utf8'
  ),
};

const result = applyBidirectionalPromptMasking(mockRes, prepared, {});
assert.strictEqual(result.masked, true);
assert.strictEqual(result.maskedCount, 1);
const outboundJson = JSON.parse(prepared.buffer.toString('utf8'));
const placeholder = `__HPM_MASK_1_${result.state.salt}__`;
assert.strictEqual(outboundJson.messages[0].content, `My token is ${placeholder}`);

mockRes.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Length': '123' });
assert.strictEqual(mockRes.headers['Content-Length'], undefined);
mockRes.write(Buffer.from(`data: {"text":"Echoing ${placeholder.slice(0, 10)}`, 'utf8'));
mockRes.end(Buffer.from(`${placeholder.slice(10)} back"}\n\n`, 'utf8'));
assert.strictEqual(chunks.join(''), `data: {"text":"Echoing ${sampleGithubToken} back"}\n\n`);

// 6. Custom keywords masking + round-trip unmasking
const kwState = createPromptMaskState({ salt: 'c0ffee' });
const kwMasked = maskPromptText(
  'Deploying ProjectApollo to gateway.corp.internal.local with key sk-proj-1234567890abcdefghijklmnop',
  kwState,
  { customKeywords: 'ProjectApollo, gateway.corp.internal.local' }
);
assert.ok(!kwMasked.includes('ProjectApollo'), 'Custom keyword ProjectApollo should be masked');
assert.ok(!kwMasked.includes('gateway.corp.internal.local'), 'Custom domain keyword should be masked');
assert.strictEqual(
  unmaskText(kwMasked, kwState.tokenToSecret),
  'Deploying ProjectApollo to gateway.corp.internal.local with key sk-proj-1234567890abcdefghijklmnop'
);

// 7. Multi-API-Key pool round-robin & 429 cooldown + clearUpstreamCooldowns
const {
  splitApiKeyPool,
  selectApiKeyFromPool,
  markApiKeyPoolRateLimited,
  setUpstreamCooldown,
  listUpstreamCooldowns,
  clearUpstreamCooldowns,
} = require('../lib/proxy/errors');

clearUpstreamCooldowns();
const poolRaw = 'sk-key-alpha, sk-key-beta, sk-key-gamma';
assert.strictEqual(splitApiKeyPool(poolRaw).length, 3);
const firstPick = selectApiKeyFromPool(poolRaw, 'deepseek-pool');
const secondPick = selectApiKeyFromPool(poolRaw, 'deepseek-pool');
const thirdPick = selectApiKeyFromPool(poolRaw, 'deepseek-pool');
assert.notStrictEqual(firstPick, secondPick);
assert.notStrictEqual(secondPick, thirdPick);

// Rate-limit sk-key-alpha and sk-key-beta -> only sk-key-gamma should be selected
markApiKeyPoolRateLimited(poolRaw, 'sk-key-alpha', 'deepseek-pool', 30);
markApiKeyPoolRateLimited(poolRaw, 'sk-key-beta', 'deepseek-pool', 30);
for (let i = 0; i < 4; i += 1) {
  const pick = selectApiKeyFromPool(poolRaw, 'deepseek-pool');
  assert.strictEqual(pick, 'sk-key-gamma');
}

setUpstreamCooldown('kimi-coding', 'kimi-for-coding', 45);
assert.ok(listUpstreamCooldowns().length >= 3);
const cleared = clearUpstreamCooldowns();
assert.ok(cleared.clearedCount >= 3);
assert.strictEqual(listUpstreamCooldowns().length, 0);

console.log('[prompt-masking.test] ok');
