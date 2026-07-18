const assert = require('assert');
const {
  appendClaudeMessagesPath,
  createClaudeSelfTestTargetResolver,
} = require('../lib/proxy/claude-self-test-target');

assert.strictEqual(
  appendClaudeMessagesPath('https://localhost:3443/v1/'),
  'https://localhost:3443/v1/messages'
);
assert.throws(() => createClaudeSelfTestTargetResolver(), /requires runtime getters/);

const resolveTarget = createClaudeSelfTestTargetResolver({
  claudeDesktopBaseUrl: () => 'https://fallback.test',
  claudeDesktopProxyPrefix: '/claude-desktop',
  getClaudeDesktopGatewayConfig: () => ({
    isLocalProxy: true,
    baseUrl: 'https://localhost:3443/v1',
    token: 'test-token',
  }),
  getClaudeDesktopRoutes: () => [{ from: 'claude-test', profileId: 'profile-1' }],
  getClaudeDesktopTraeProcessStyle: () => 'thinking',
  getConfig: () => ({}),
  getProfiles: () => [{ id: 'profile-1', protocol: 'claude', targetUrl: 'https://upstream.test' }],
  isTraeOfficialProfile: () => false,
  isTraeOfficialTarget: () => false,
});
const target = resolveTarget();
assert.strictEqual(target.endpoint, 'https://localhost:3443/v1/messages');
assert.strictEqual(target.headers.Authorization, 'Bearer test-token');
assert.strictEqual(target.model, 'claude-test');

console.log('[claude-self-test-target.test] ok');
