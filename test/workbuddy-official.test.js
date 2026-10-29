const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Unit expectations must not change when the installed WorkBuddy catalog changes,
// and must never probe the user's real login file. Every default path is owned.
const testAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-workbuddy-official-env-'));
const priorAppData = process.env.LOCALAPPDATA;
process.env.LOCALAPPDATA = testAppData;
process.on('exit', () => {
  if (priorAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = priorAppData;
  assert.strictEqual(path.dirname(path.resolve(testAppData)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(testAppData).startsWith('hpm-workbuddy-official-env-'));
  fs.rmSync(testAppData, { recursive: true, force: true });
});
const productFile = path.join(
  testAppData,
  'Programs',
  'WorkBuddy',
  'resources',
  'app.asar.unpacked',
  'cli',
  'product.json'
);
fs.mkdirSync(path.dirname(productFile), { recursive: true });
fs.writeFileSync(
  productFile,
  JSON.stringify({
    models: [
      {
        id: 'deepseek-v4.1-flash',
        name: 'Synthetic text model',
        supportsImages: false,
        supportsToolCall: true,
        maxInputTokens: 1000000,
        maxOutputTokens: 50000,
      },
    ],
  })
);

const {
  getWorkBuddyAuthInfoPath,
  readWorkBuddyAuthInfo,
  isWorkBuddyOfficialLoginToken,
  isUsableWorkBuddyAccessToken,
  isWorkBuddyEncryptedSecret,
  coerceWorkBuddySecret,
  coerceWorkBuddyPublicString,
  workBuddyTargetUrlFromAuth,
  resolveWorkBuddyOfficialTargetUrl,
  isWorkBuddyOfficialTarget,
  isWorkBuddyOfficialProfile,
  readWorkBuddyModelsCache,
  normalizeWorkBuddyOfficialModelName,
  buildWorkBuddyOfficialModelsResponse,
  workBuddyOfficialModelSupport,
  sanitizeWorkBuddyChatBody,
} = require('../lib/proxy/workbuddy-official');

const { officialLoginProvider, inferOfficialProfileAuthMode } = require('../lib/proxy/auth-mode');

const { mergeBuiltinModelRoutes } = require('../lib/proxy/builtin-model-routes');

// 1. Test token format recognition
assert.strictEqual(isWorkBuddyOfficialLoginToken('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...'), true);
assert.strictEqual(isWorkBuddyOfficialLoginToken('sk-proj-12345'), false);
assert.strictEqual(isWorkBuddyOfficialLoginToken(null), false);
assert.strictEqual(isWorkBuddyOfficialLoginToken(''), false);
assert.strictEqual(isUsableWorkBuddyAccessToken('opaque-workbuddy-token'), true);
assert.strictEqual(isUsableWorkBuddyAccessToken('eyJhbGciOiJSUzI1NiJ9'), true);
assert.strictEqual(isUsableWorkBuddyAccessToken('short'), true);
assert.strictEqual(isUsableWorkBuddyAccessToken('   '), false);
assert.strictEqual(isUsableWorkBuddyAccessToken(null), false);
assert.strictEqual(coerceWorkBuddySecret('token-value'), 'token-value');
assert.strictEqual(coerceWorkBuddySecret({ token: 'must-not-coerce-object' }), null);
assert.strictEqual(coerceWorkBuddyPublicString('public-id'), 'public-id');
assert.strictEqual(coerceWorkBuddyPublicString({ $wbEncrypted: 1, envelope: 'private' }), '');
assert.strictEqual(
  isWorkBuddyEncryptedSecret({ $wbEncrypted: 1, envelope: 'encrypted-envelope' }),
  true
);
assert.strictEqual(
  isWorkBuddyEncryptedSecret({
    $wbEncrypted: 1,
    envelope: 'encrypted-envelope',
    scheme: 'asym-v1',
  }),
  true
);
assert.strictEqual(
  isWorkBuddyEncryptedSecret({
    $wbEncrypted: 1,
    envelope: 'encrypted-envelope',
    extra: 'unexpected',
  }),
  false
);

// 2. Test target URL recognition
assert.strictEqual(isWorkBuddyOfficialTarget('https://copilot.tencent.com'), true);
assert.strictEqual(isWorkBuddyOfficialTarget('https://copilot.tencent.com/v1'), true);
assert.strictEqual(isWorkBuddyOfficialTarget('https://www.workbuddy.cn'), true);
assert.strictEqual(isWorkBuddyOfficialTarget('https://www.codebuddy.ai'), true);
assert.strictEqual(isWorkBuddyOfficialTarget('https://api.openai.com/v1'), false);
assert.strictEqual(isWorkBuddyOfficialTarget('https://coresg-normal.trae.ai'), false);
assert.strictEqual(
  workBuddyTargetUrlFromAuth({ domain: 'www.workbuddy.cn' }),
  'https://www.workbuddy.cn/v2'
);
assert.strictEqual(
  workBuddyTargetUrlFromAuth({ domain: 'https://copilot.tencent.com/path' }),
  'https://copilot.tencent.com/v2'
);
assert.strictEqual(
  workBuddyTargetUrlFromAuth({ domain: 'www.workbuddy.cn.evil.test' }),
  'https://copilot.tencent.com/v2'
);
assert.strictEqual(
  resolveWorkBuddyOfficialTargetUrl('https://copilot.tencent.com', {
    domain: 'www.workbuddy.cn',
  }),
  'https://www.workbuddy.cn/v2'
);
assert.strictEqual(
  resolveWorkBuddyOfficialTargetUrl('https://custom-workbuddy.example.test/v2', {
    domain: 'www.workbuddy.cn',
  }),
  'https://custom-workbuddy.example.test/v2'
);

// 3. Test profile recognition
assert.strictEqual(isWorkBuddyOfficialProfile('workbuddy-official'), true);
assert.strictEqual(isWorkBuddyOfficialProfile('codebuddy-official'), true);
assert.strictEqual(isWorkBuddyOfficialProfile({ id: 'workbuddy-official' }), true);
assert.strictEqual(isWorkBuddyOfficialProfile({ protocol: 'workbuddy' }), true);
assert.strictEqual(isWorkBuddyOfficialProfile({ targetUrl: 'https://copilot.tencent.com' }), true);
assert.strictEqual(isWorkBuddyOfficialProfile({ id: 'openai-official' }), false);

// 4. Test auth-mode provider classification
assert.strictEqual(officialLoginProvider({ id: 'workbuddy-official' }), 'workbuddy');
assert.strictEqual(officialLoginProvider({ id: 'codebuddy-official' }), 'workbuddy');
assert.strictEqual(
  officialLoginProvider({ protocol: 'workbuddy', authMode: 'official-login' }),
  'workbuddy'
);
assert.strictEqual(
  officialLoginProvider({
    targetUrl: 'https://copilot.tencent.com',
    authMode: 'official-login',
  }),
  'workbuddy'
);

// 5. Test inferOfficialProfileAuthMode
assert.strictEqual(
  inferOfficialProfileAuthMode({ apiKey: 'eyJhbGciOi...' }, 'workbuddy'),
  'official-login'
);
assert.strictEqual(
  inferOfficialProfileAuthMode({ apiKey: 'PROXY_MANAGED' }, 'workbuddy'),
  'official-login'
);

// 6. Test model name normalization
assert.strictEqual(
  normalizeWorkBuddyOfficialModelName('workbuddy/deepseek-v4-pro'),
  'deepseek-v4-pro'
);
assert.strictEqual(normalizeWorkBuddyOfficialModelName('codebuddy/minimax-m3'), 'minimax-m3');
assert.strictEqual(normalizeWorkBuddyOfficialModelName('workbuddy/minimax-m3-play'), 'minimax-m3');
assert.strictEqual(normalizeWorkBuddyOfficialModelName('workbuddy/glm-5.1'), 'glm-5.1');
assert.strictEqual(normalizeWorkBuddyOfficialModelName('deepseek-v4-pro'), 'deepseek-v4-pro');
assert.strictEqual(
  normalizeWorkBuddyOfficialModelName('workbuddy/deepseek-v4.1-flash'),
  'deepseek-v4.1-flash'
);
assert.strictEqual(normalizeWorkBuddyOfficialModelName('deepseek-v4.1'), 'deepseek-v4.1-flash');

// 7. Test models cache and discovery
const cache = readWorkBuddyModelsCache();
assert.ok(cache, 'Cache should not be null');
assert.ok(Array.isArray(cache.models), 'Models should be an array');
assert.ok(cache.models.length > 0, 'Models count should be > 0');

const response = buildWorkBuddyOfficialModelsResponse(cache);
assert.strictEqual(response.ok, true);
assert.strictEqual(response.authMode, 'official-login');
assert.ok(response.models.includes('deepseek-v4.1-flash'));
assert.ok(response.models.includes('glm-5.3'));
assert.ok(
  response.models.includes('deepseek-v4-pro') ||
    response.models.includes('minimax-m3') ||
    response.models.includes('glm-5.1')
);

// 8. Test model support validation
const dsSupport = workBuddyOfficialModelSupport('workbuddy/deepseek-v4-pro', cache);
assert.strictEqual(dsSupport.known, true);
assert.strictEqual(dsSupport.supported, true);

const ds41Support = workBuddyOfficialModelSupport('workbuddy/deepseek-v4.1-flash', cache);
assert.strictEqual(ds41Support.known, true);
assert.strictEqual(ds41Support.supported, true);
assert.strictEqual(ds41Support.model, 'deepseek-v4.1-flash');
assert.strictEqual(ds41Support.supportsImages, false);
assert.strictEqual(ds41Support.displayName, 'Synthetic text model');

const mmSupport = workBuddyOfficialModelSupport('workbuddy/minimax-m3', cache);
assert.strictEqual(mmSupport.known, true);
assert.strictEqual(mmSupport.supported, true);

const unknownSupport = workBuddyOfficialModelSupport('workbuddy/non-existent-model-xyz', cache);
assert.strictEqual(unknownSupport.known, false);
assert.strictEqual(unknownSupport.supported, false);

// 9. Test builtin model routes merging
const testConfig = {
  profiles: [{ id: 'workbuddy-official' }],
  modelRoutes: [],
};
const merged = mergeBuiltinModelRoutes(testConfig);
const routeKeys = merged.modelRoutes.map((r) => r.from);
assert.ok(routeKeys.includes('workbuddy/deepseek-v4.1-flash'));
assert.ok(routeKeys.includes('workbuddy/glm-5.3'));
assert.ok(routeKeys.includes('workbuddy/deepseek-v4-pro'));
assert.ok(routeKeys.includes('workbuddy/minimax-m3'));
assert.ok(routeKeys.includes('workbuddy/glm-5.1'));

// 10. Test sanitizeWorkBuddyChatBody (converts developer -> system, handles unsupported images)
{
  const input = {
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'developer', content: 'You are an expert coder.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this code' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,123' } },
        ],
      },
    ],
  };

  const output = sanitizeWorkBuddyChatBody(JSON.parse(JSON.stringify(input)), {
    targetModel: 'deepseek-v4.1-flash',
  });

  assert.strictEqual(output.messages[0].role, 'system', 'developer role should become system');
  assert.strictEqual(output.messages[0].content, 'You are an expert coder.');
  assert.strictEqual(output.messages[1].role, 'user');
  assert.ok(
    typeof output.messages[1].content === 'string',
    'all-text content array should be flattened to string'
  );
  assert.ok(
    output.messages[1].content.includes('[附件图片已转为文本占位'),
    'unsupported image should be converted to text placeholder'
  );

  // For multimodal model like glm-5v-turbo, images should be preserved
  const multiInput = {
    model: 'glm-5v-turbo',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at image' },
          { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
        ],
      },
    ],
  };
  const multiOutput = sanitizeWorkBuddyChatBody(JSON.parse(JSON.stringify(multiInput)), {
    targetModel: 'glm-5v-turbo',
  });
  assert.strictEqual(multiOutput.messages[0].content[1].type, 'image_url');
}

// 11. WorkBuddy context diagnostics stay local and are not serialized upstream
{
  const marker = 'private-user-marker';
  const input = {
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'system', content: 'stable policy' },
      { role: 'user', content: 'stable request ' + marker },
      { role: 'assistant', content: 'stable answer' },
      { role: 'user', content: 'current request ' + marker },
    ],
  };

  const output = sanitizeWorkBuddyChatBody(JSON.parse(JSON.stringify(input)), {
    targetModel: 'deepseek-v4.1-flash',
  });

  assert.ok(output.__hpmDiagnostics, 'diagnostics should be available to local audit');
  assert.ok(output.__hpmDiagnostics.contextBudget, 'context budget diagnostics should be present');
  assert.ok(
    output.__hpmDiagnostics.contextBudget.contextCache,
    'context cache diagnostics should be present'
  );
  assert.strictEqual(
    Object.prototype.propertyIsEnumerable.call(output, '__hpmDiagnostics'),
    false,
    'diagnostics must not be serialized to upstream JSON'
  );
  assert.ok(
    !JSON.stringify(output.__hpmDiagnostics).includes(marker),
    'diagnostics must not include prompt content'
  );
  assert.ok(
    !JSON.stringify(output).includes('__hpmDiagnostics'),
    'upstream JSON must not contain diagnostics'
  );
}

// 12. Test the default auth path using mandatory synthetic credentials, never a live account.
const authPath = getWorkBuddyAuthInfoPath();
assert.ok(authPath.startsWith(testAppData + path.sep));
fs.mkdirSync(path.dirname(authPath), { recursive: true });
fs.writeFileSync(authPath, JSON.stringify({ auth: { accessToken: 'fixture-only-opaque-token' } }));
{
  const authInfo = readWorkBuddyAuthInfo(authPath);
  assert.ok(authInfo, 'Should parse synthetic workbuddy-desktop.info');
  assert.ok(
    authInfo.accessToken || authInfo.accessTokenEncrypted,
    'Access token should be present as plaintext or encrypted'
  );
  if (authInfo.accessToken) {
    assert.strictEqual(isUsableWorkBuddyAccessToken(authInfo.accessToken), true);
  }
  assert.strictEqual(authInfo.accessToken, 'fixture-only-opaque-token');
}

// 13. Encrypted WorkBuddy credentials are detected but never coerced into token strings
{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-workbuddy-official-'));
  try {
    const authFile = path.join(tempDir, 'workbuddy-desktop.info');
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        auth: {
          accessToken: { $wbEncrypted: 1, envelope: 'encrypted-access-token' },
          refreshToken: { $wbEncrypted: 1, envelope: 'encrypted-refresh-token' },
          tokenType: 'Bearer',
          domain: 'www.workbuddy.cn',
        },
        account: { uid: 'uid-encrypted', uin: 'uin-encrypted' },
      })
    );
    const authInfo = readWorkBuddyAuthInfo(authFile);
    assert.strictEqual(authInfo.accessToken, null);
    assert.strictEqual(authInfo.refreshToken, null);
    assert.strictEqual(authInfo.accessTokenEncrypted, true);
    assert.strictEqual(authInfo.refreshTokenEncrypted, true);
    assert.strictEqual(authInfo.domain, 'www.workbuddy.cn');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

console.log('All WorkBuddy official login tests passed successfully!');
