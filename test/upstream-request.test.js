const assert = require('assert');

const { buildOutgoingHeaders } = require('../lib/proxy/upstream-request');

function testOpenAIApiKeyOverridesClientCredentials() {
  const headers = buildOutgoingHeaders(
    {
      authorization: 'Bearer client',
      'api-key': 'client-api',
      'x-api-key': 'client-x',
      'x-goog-api-key': 'client-google',
      accept: 'application/json',
    },
    {
      requestProtocol: 'openai',
      authMode: 'api-key',
      apiKey: 'sk-provider',
    }
  );

  assert.strictEqual(headers.authorization, 'Bearer sk-provider');
  assert.strictEqual(headers['api-key'], 'sk-provider');
  assert.strictEqual(headers['x-api-key'], undefined);
  assert.strictEqual(headers['x-goog-api-key'], undefined);
  assert.strictEqual(headers.accept, 'application/json');
}

function testClaudeApiKeyAndProtocolVersion() {
  const headers = buildOutgoingHeaders(
    { authorization: 'Bearer client', 'anthropic-version': 'old' },
    {
      requestProtocol: 'claude',
      protocolVersion: '2024-01-01',
      authMode: 'api-key',
      apiKey: 'sk-ant-provider',
    }
  );

  assert.strictEqual(headers.authorization, undefined);
  assert.strictEqual(headers['x-api-key'], 'sk-ant-provider');
  assert.strictEqual(headers['anthropic-version'], '2024-01-01');
}

function testGeminiApiKeyUsesGoogleHeader() {
  const headers = buildOutgoingHeaders(
    { authorization: 'Bearer client', 'x-goog-api-key': 'client-google' },
    {
      requestProtocol: 'gemini',
      authMode: 'api-key',
      apiKey: 'AIza-provider',
    }
  );

  assert.strictEqual(headers.authorization, undefined);
  assert.strictEqual(headers['x-goog-api-key'], 'AIza-provider');
}

function testGeminiOauthUsesAuthorizationBearer() {
  const headers = buildOutgoingHeaders(
    { 'x-goog-api-key': 'client-google' },
    {
      requestProtocol: 'gemini',
      authMode: 'official-login',
      apiKey: 'ya29.provider-token',
    }
  );

  assert.strictEqual(headers.authorization, 'Bearer ya29.provider-token');
  assert.strictEqual(headers['x-goog-api-key'], undefined);
}

function testOfficialLoginWithoutApiKeyStripsClientCredentials() {
  const headers = buildOutgoingHeaders(
    {
      authorization: 'Bearer client',
      'api-key': 'client-api',
      'x-api-key': 'client-x',
      'x-goog-api-key': 'client-google',
      accept: 'application/json',
    },
    {
      requestProtocol: 'openai',
      authMode: 'official-login',
      apiKey: '',
    }
  );

  assert.strictEqual(headers.authorization, undefined);
  assert.strictEqual(headers['api-key'], undefined);
  assert.strictEqual(headers['x-api-key'], undefined);
  assert.strictEqual(headers['x-goog-api-key'], undefined);
  assert.strictEqual(headers.accept, 'application/json');
}

function testWithoutManagedAuthPreservesClientCredentials() {
  const headers = buildOutgoingHeaders(
    {
      authorization: 'Bearer client',
      'api-key': 'client-api',
    },
    {
      requestProtocol: 'openai',
      authMode: 'api-key',
      apiKey: '',
    }
  );

  assert.strictEqual(headers.authorization, 'Bearer client');
  assert.strictEqual(headers['api-key'], 'client-api');
}

function testRoutedRequestUpdatesContentLength() {
  const headers = buildOutgoingHeaders(
    { 'content-length': '999' },
    {
      requestProtocol: 'openai',
      authMode: 'api-key',
      apiKey: '',
      routed: true,
      bodyBuffer: Buffer.from('hello'),
    }
  );

  assert.strictEqual(headers['content-length'], 5);
}

function testWorkBuddyDesktopSimulationHeaders() {
  const headers = buildOutgoingHeaders(
    {},
    {
      requestProtocol: 'openai',
      authProvider: 'workbuddy',
      uid: 'user-12345',
    }
  );

  assert.strictEqual(headers['x-user-id'], 'user-12345');
  assert.strictEqual(headers['x-ide-type'], 'WorkBuddy');
  assert.strictEqual(headers['x-ide-name'], 'WorkBuddy');
  assert.strictEqual(headers['x-product'], 'SaaS');
  assert.strictEqual(headers['x-agent-type'], 'normal');
  assert.strictEqual(headers['x-agent-intent'], 'craft');
  assert.ok(headers['x-conversation-id']);
  assert.ok(headers['x-request-id']);
  assert.ok(headers['user-agent'].startsWith('WorkBuddy/'));
}

testOpenAIApiKeyOverridesClientCredentials();
testClaudeApiKeyAndProtocolVersion();
testGeminiApiKeyUsesGoogleHeader();
testGeminiOauthUsesAuthorizationBearer();
testOfficialLoginWithoutApiKeyStripsClientCredentials();
testWithoutManagedAuthPreservesClientCredentials();
testRoutedRequestUpdatesContentLength();
testWorkBuddyDesktopSimulationHeaders();

console.log('[upstream-request.test] ok');
