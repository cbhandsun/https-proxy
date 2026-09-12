const assert = require('assert');
const fs = require('fs');

const {
  getWorkBuddyAuthInfoPath,
  readWorkBuddyAuthInfo,
  isWorkBuddyOfficialLoginToken,
  isWorkBuddyOfficialTarget,
  isWorkBuddyOfficialProfile,
  readWorkBuddyModelsCache,
  normalizeWorkBuddyOfficialModelName,
  buildWorkBuddyOfficialModelsResponse,
  workBuddyOfficialModelSupport,
} = require('../lib/proxy/workbuddy-official');

const { officialLoginProvider, inferOfficialProfileAuthMode } = require('../lib/proxy/auth-mode');

const { mergeBuiltinModelRoutes } = require('../lib/proxy/builtin-model-routes');

// 1. Test token format recognition
assert.strictEqual(isWorkBuddyOfficialLoginToken('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...'), true);
assert.strictEqual(isWorkBuddyOfficialLoginToken('sk-proj-12345'), false);
assert.strictEqual(isWorkBuddyOfficialLoginToken(null), false);
assert.strictEqual(isWorkBuddyOfficialLoginToken(''), false);

// 2. Test target URL recognition
assert.strictEqual(isWorkBuddyOfficialTarget('https://copilot.tencent.com'), true);
assert.strictEqual(isWorkBuddyOfficialTarget('https://copilot.tencent.com/v1'), true);
assert.strictEqual(isWorkBuddyOfficialTarget('https://www.workbuddy.cn'), true);
assert.strictEqual(isWorkBuddyOfficialTarget('https://www.codebuddy.ai'), true);
assert.strictEqual(isWorkBuddyOfficialTarget('https://api.openai.com/v1'), false);
assert.strictEqual(isWorkBuddyOfficialTarget('https://coresg-normal.trae.ai'), false);

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

// 10. Test live credentials if local file exists
const authPath = getWorkBuddyAuthInfoPath();
if (fs.existsSync(authPath)) {
  const authInfo = readWorkBuddyAuthInfo(authPath);
  assert.ok(authInfo, 'Should parse live workbuddy-desktop.info');
  assert.ok(authInfo.accessToken, 'Access token should be present');
  assert.strictEqual(isWorkBuddyOfficialLoginToken(authInfo.accessToken), true);
  console.log('[TEST] Live WorkBuddy credentials verified for:', authInfo.nickname || authInfo.uin);
}

console.log('All WorkBuddy official login tests passed successfully!');
