const assert = require('assert');
const path = require('path');

const {
  isPathInsideRoot,
  isSameOriginManagementRequest,
  managementTokenCandidateGroups,
  parseDevStaticPort,
  parseLocalProxyPort,
  parseOptionalPort,
  serverHealthMarker,
} = require('../scripts/dev-static-server');

const root = path.resolve('C:/tmp/tauri-ui');

assert.strictEqual(isPathInsideRoot(path.join(root, 'electron-ui.html'), root), true);
assert.strictEqual(isPathInsideRoot(path.join(root, 'assets', 'app.js'), root), true);
assert.strictEqual(isPathInsideRoot(path.resolve('C:/tmp/tauri-ui2/app.js'), root), false);
assert.strictEqual(isPathInsideRoot(path.resolve('C:/tmp/secret.txt'), root), false);

assert.strictEqual(parseDevStaticPort('1555'), 1555);
assert.strictEqual(parseDevStaticPort('not-a-port'), 1430);
assert.strictEqual(parseDevStaticPort('70000'), 1430);
assert.strictEqual(parseDevStaticPort('0'), 1430);

assert.strictEqual(parseLocalProxyPort('4555'), 4555);
assert.strictEqual(parseLocalProxyPort(''), 3443);
assert.strictEqual(parseLocalProxyPort('-1'), 3443);
assert.strictEqual(parseLocalProxyPort(Infinity), 3443);
assert.strictEqual(parseOptionalPort('4543'), 4543);
assert.strictEqual(parseOptionalPort('bad'), 0);
assert.strictEqual(parseOptionalPort('70000'), 0);

const tokenGroups = managementTokenCandidateGroups('4543');
assert.ok(tokenGroups[0].some((filePath) => filePath.endsWith('.mgmt-token-4543')));
assert.ok(tokenGroups[1].some((filePath) => filePath.endsWith('.mgmt-token')));
const fallbackGroups = managementTokenCandidateGroups('bad');
assert.strictEqual(fallbackGroups.length, 1);
assert.ok(fallbackGroups[0].every((filePath) => filePath.endsWith('.mgmt-token')));

assert.strictEqual(serverHealthMarker, 'dev-static-management-proxy-v7');
const baseReq = { headers: { host: '127.0.0.1:1430' } };
assert.strictEqual(isSameOriginManagementRequest(baseReq), true);
assert.strictEqual(
  isSameOriginManagementRequest({
    headers: { host: '127.0.0.1:1430', origin: 'http://127.0.0.1:1430' },
  }),
  true
);
assert.strictEqual(
  isSameOriginManagementRequest({
    headers: { host: '127.0.0.1:1430', origin: 'http://localhost:9999' },
  }),
  false
);
assert.strictEqual(
  isSameOriginManagementRequest({
    headers: { host: '127.0.0.1:1430', referer: 'http://localhost:9999/page' },
  }),
  false
);
assert.strictEqual(
  isSameOriginManagementRequest({
    headers: { host: '127.0.0.1:1430', 'sec-fetch-site': 'cross-site' },
  }),
  false
);
assert.strictEqual(
  isSameOriginManagementRequest({
    headers: { host: '127.0.0.1:1430', 'sec-fetch-site': 'same-origin' },
  }),
  true
);

console.log('[dev-static-server.test] ok');
