'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  nativeEvidenceV2Plan,
  approvedNativeEvidenceRoute,
  verifyNativeEvidenceV2Preflight,
} = require('../scripts/lib/native-evidence-v2-preflight');
const authorization = () => ({
  schema: 'hpm.context.native-evidence-v2-authorization',
  version: 1,
  scope: 'one_isolated_native_model_control_compact_pair',
  userExplicitlyAuthorized: true,
  additionalRequestsPerArm: 30,
  automaticRetries: 0,
  failedAndCompactionRequestsCounted: true,
  reusePreviouslyAuthorizedOfficialLogin: true,
  installedCodexConfigurationMayChange: false,
  productionRestartAuthorized: false,
  providerCredentialCreationAuthorized: false,
  publicationAuthorized: false,
  priorCumulativeRequests: { control: 32, compact: 40 },
  newCumulativeLimits: { control: 62, compact: 70 },
  priorAudit: 'context-native-evidence-candidate-20261012-pair1-audit-result.json',
  priorAuditSha256: '6a5fbae255e29427f83fbe8a6de0a43f16d8953c21998fd38b665a96fe4ca385',
  candidateWorkloadSha256: 'a'.repeat(64),
});
const plan = (arm = 'control', a = authorization()) =>
  nativeEvidenceV2Plan({ arm, authorization: a, workloadSha256: 'a'.repeat(64) });
const route = () => ({
  profiles: [
    {
      id: 'openai-official',
      authMode: 'official-login',
      apiKey: '',
      protocol: 'openai',
      targetUrl: 'https://chatgpt.com',
    },
  ],
  modelRoutes: [{ from: 'gpt-5.6-sol', to: 'gpt-5.6-sol', profileId: 'openai-official' }],
});

test('explicit authorization pins one pair, failure-inclusive counts and zero retries', () => {
  assert.equal(plan().priorRequests, 32);
  assert.equal(plan('compact').cumulativeLimit, 70);
  for (const [key, value] of [
    ['userExplicitlyAuthorized', false],
    ['additionalRequestsPerArm', 31],
    ['automaticRetries', 1],
    ['installedCodexConfigurationMayChange', true],
    ['productionRestartAuthorized', true],
    ['providerCredentialCreationAuthorized', true],
    ['publicationAuthorized', true],
    ['candidateWorkloadSha256', 'b'.repeat(64)],
  ]) {
    const a = authorization();
    a[key] = value;
    assert.throws(() => plan('control', a));
  }
  for (const arm of ['', 'retry', null]) assert.throws(() => plan(arm));
  assert.throws(() =>
    nativeEvidenceV2Plan({
      arm: 'control',
      authorization: authorization(),
      workloadSha256: 'a'.repeat(64),
      retry: true,
    })
  );
});

test('only unique existing official-login route is copied; key/headers/content excluded', () => {
  const input = route();
  input.profiles[0].headers = { Authorization: 'secret' };
  assert.equal(JSON.stringify(approvedNativeEvidenceRoute(input)).includes('secret'), false);
  for (const mutate of [
    (r) => r.profiles.push(r.profiles[0]),
    (r) => r.modelRoutes.push(r.modelRoutes[0]),
    (r) => {
      r.profiles[0].apiKey = 'secret';
    },
    (r) => {
      r.profiles[0].authMode = 'api-key';
    },
    (r) => {
      r.modelRoutes[0].profileId = 'other';
    },
    (r) => {
      r.modelRoutes[0].to = 2;
    },
  ]) {
    const r = route();
    mutate(r);
    assert.throws(() => approvedNativeEvidenceRoute(r));
  }
  let invoked = 0;
  const hostile = Object.defineProperty({}, 'profiles', {
    enumerable: true,
    get() {
      invoked++;
      return null;
    },
  });
  assert.throws(() => approvedNativeEvidenceRoute(hostile));
  assert.equal(invoked, 0);
});

test('preflight preserves terminal and interrupted attempts before reading prior evidence', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-v2-preflight-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, '.hpm-runtime');
  fs.mkdirSync(runtime);
  fs.writeFileSync(
    path.join(runtime, 'context-native-evidence-v2-20261012-pair1-authorization.json'),
    JSON.stringify(authorization())
  );
  const result = path.join(runtime, plan().resultName);
  fs.writeFileSync(result.replace('-result.json', '-attempt.json'), '{}');
  assert.throws(() => verifyNativeEvidenceV2Preflight(root, 'control', 'a'.repeat(64)), {
    code: 'native_v2_prior_run_must_be_preserved',
  });
  fs.unlinkSync(result.replace('-result.json', '-attempt.json'));
  fs.writeFileSync(result, '{}');
  assert.throws(() => verifyNativeEvidenceV2Preflight(root, 'control', 'a'.repeat(64)), {
    code: 'native_v2_prior_run_must_be_preserved',
  });
  fs.unlinkSync(result);
  fs.writeFileSync(path.join(runtime, authorization().priorAudit), '{}');
  assert.throws(() => verifyNativeEvidenceV2Preflight(root, 'control', 'a'.repeat(64)), {
    code: 'native_v2_prior_audit_changed',
  });
});
