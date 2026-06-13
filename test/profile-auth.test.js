const assert = require('assert');

const {
  buildProfileAuthProbeRequest,
  evaluateOpenAIProfileAuthResponse,
  evaluateGeminiProfileAuthResponse,
  evaluateClaudeProfileAuthResponse,
} = require('../lib/proxy/profile-auth');
const { shouldUseChatGPTBackendForOfficialLogin } = require('../lib/proxy/auth-mode');

const openAiOfficialProbe = buildProfileAuthProbeRequest(
  'openai',
  'https://chatgpt.com/backend-api/codex',
  'eyJhbGciOiJtest',
  'gpt-5.3-codex',
  'official-login'
);
assert.strictEqual(openAiOfficialProbe.method, 'GET');
assert.strictEqual(openAiOfficialProbe.fullUrl, 'https://chatgpt.com/backend-api/models');
assert.strictEqual(openAiOfficialProbe.headers.authorization, 'Bearer eyJhbGciOiJtest');
assert.strictEqual(openAiOfficialProbe.requestBody, null);
assert.strictEqual(shouldUseChatGPTBackendForOfficialLogin('https://api.openai.com/v1'), true);
assert.strictEqual(shouldUseChatGPTBackendForOfficialLogin('http://127.0.0.1:9999/v1'), false);

const geminiOfficialProbe = buildProfileAuthProbeRequest(
  'gemini',
  'https://generativelanguage.googleapis.com',
  'ya29.google-token',
  'models/gemini-2.5-pro',
  'official-login'
);
assert.strictEqual(geminiOfficialProbe.method, 'POST');
assert.strictEqual(
  geminiOfficialProbe.fullUrl,
  'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
);
assert.strictEqual(geminiOfficialProbe.headers.authorization, 'Bearer ya29.google-token');
assert.strictEqual(geminiOfficialProbe.headers['content-type'], 'application/json');
assert.strictEqual(
  geminiOfficialProbe.fullUrl.includes('generativelanguage.googleapis.com'),
  false
);

const geminiApiKeyProbe = buildProfileAuthProbeRequest(
  'gemini',
  'https://generativelanguage.googleapis.com',
  'AIza-api-key',
  'gemini-2.5-flash',
  'api-key'
);
const geminiApiKeyUrl = new URL(geminiApiKeyProbe.fullUrl);
assert.strictEqual(geminiApiKeyProbe.method, 'POST');
assert.strictEqual(geminiApiKeyUrl.searchParams.get('key'), 'AIza-api-key');
assert.strictEqual(geminiApiKeyProbe.headers.authorization, undefined);

const openAiSuccess = evaluateOpenAIProfileAuthResponse(
  { statusCode: 200, headers: {}, body: JSON.stringify({ models: [{ slug: 'gpt-5.3-codex' }] }) },
  { testModel: 'gpt-5.3-codex', authMode: 'official-login' }
);
assert.deepStrictEqual(openAiSuccess, {
  ok: true,
  authMode: 'official-login',
  message: '官方登录凭证有效，模型 gpt-5.3-codex 已在后台列表中。',
});

const cloudflare = evaluateOpenAIProfileAuthResponse(
  { statusCode: 403, headers: { 'content-type': 'text/html' }, body: '<html>blocked</html>' },
  { testModel: 'gpt-5.3-codex', authMode: 'official-login' }
);
assert.strictEqual(cloudflare.ok, true);
assert.strictEqual(cloudflare.authMode, 'official-login');
assert.ok(cloudflare.warning.includes('403'));

const geminiCodeAssistOk = evaluateGeminiProfileAuthResponse(
  { statusCode: 200, headers: {}, body: '{}' },
  {
    authMode: 'official-login',
    probeFullUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  }
);
assert.deepStrictEqual(geminiCodeAssistOk, {
  ok: true,
  authMode: 'official-login',
  source: 'code-assist',
  message: 'Google 官方登录凭证有效，Code Assist/Antigravity 后端可达。',
});

const geminiCodeAssistFailed = evaluateGeminiProfileAuthResponse(
  {
    statusCode: 401,
    headers: {},
    body: JSON.stringify([{ error: { message: 'invalid oauth' } }]),
  },
  {
    authMode: 'official-login',
    probeFullUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  }
);
assert.deepStrictEqual(geminiCodeAssistFailed, {
  ok: false,
  authMode: 'official-login',
  source: 'code-assist',
  error: 'Google 官方登录后端探测失败 HTTP 401: invalid oauth',
});

const claudeResult = evaluateClaudeProfileAuthResponse(
  {
    statusCode: 404,
    headers: {},
    body: JSON.stringify({ error: { message: 'model not found' } }),
  },
  { testModel: 'claude-3-5-sonnet-20241022' }
);
assert.deepStrictEqual(claudeResult, {
  ok: false,
  error: 'HTTP 404: model not found',
});

console.log('[profile-auth.test] ok');
