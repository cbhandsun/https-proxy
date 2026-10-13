'use strict';
const assert = require('node:assert/strict');
const {
  googleRuntimeErrorSummary,
  withGoogleRuntimeStage,
} = require('../lib/proxy/google-runtime-errors');
const { createGoogleOfficialRuntime } = require('../lib/proxy/google-official-runtime');

async function main() {
  for (const value of [
    null,
    undefined,
    'private-marker',
    {},
    { code: 'private-marker', stage: 'private-marker', message: 'private-marker' },
  ]) {
    assert.deepEqual(googleRuntimeErrorSummary(value), {
      errorType: 'GOOGLE_RUNTIME_ERROR',
      stage: 'credential_refresh',
    });
  }
  assert.equal(
    googleRuntimeErrorSummary(new Error('Connection timeout (8s)')).errorType,
    'ETIMEDOUT'
  );
  assert.equal(await withGoogleRuntimeStage('credential_read', async () => 42), 42);
  await assert.rejects(
    () =>
      withGoogleRuntimeStage('code_assist_probe', async () => {
        throw Object.assign(new Error('private-marker'), { code: 'ECONNRESET' });
      }),
    (error) =>
      error.code === 'ECONNRESET' &&
      error.stage === 'code_assist_probe' &&
      !error.message.includes('private-marker')
  );
  const runtime = (makeRequest, expired = false) =>
    createGoogleOfficialRuntime({
      makeRequest,
      readAntigravityOfficialCredentialState: () => ({
        content: {
          access_token: 'test-token',
          refresh_token: expired ? 'private-marker' : '',
          expiry_date: expired ? 1 : 0,
          __readOnly: true,
        },
      }),
      buildGoogleOfficialLoadCodeAssistRequest: () => ({
        fullUrl: 'https://example.test',
        method: 'POST',
        headers: {},
        requestBody: '{}',
      }),
      env: {},
    });
  const failing = runtime(async () => {
    throw Object.assign(new Error('private-marker'), { code: 'ETIMEDOUT' });
  });
  await assert.rejects(
    () => failing.probeAntigravityOfficialCredentials(),
    (error) => error.code === 'ETIMEDOUT' && error.stage === 'code_assist_probe'
  );
  const events = [];
  const watchdog = failing.createAntigravityCredentialWatchdog({
    getRuntimeState: () => ({
      PROFILES: [{ id: 'google-official', protocol: 'gemini', authMode: 'official-login' }],
    }),
    logProxyEvent: (kind, payload) => events.push({ kind, payload }),
  });
  const failed = await watchdog.runOnce();
  assert.equal(failed.stage, 'code_assist_probe');
  assert.equal(events[0].payload.errorType, 'ETIMEDOUT');
  assert.equal(JSON.stringify(events).includes('private-marker'), false);
  for (const body of [
    'null',
    '[]',
    '"private-marker"',
    'not-json',
    '{"error":"invalid_grant","error_description":"private-marker"}',
  ]) {
    const oauth = runtime(async () => ({ statusCode: 400, body }), true);
    await assert.rejects(
      () => oauth.probeAntigravityOfficialCredentials(),
      (error) =>
        error.stage === 'oauth_refresh' &&
        error.code.startsWith('OAUTH_') &&
        !error.message.includes('private-marker')
    );
  }
  const recovered = runtime(async () => ({ statusCode: 200, body: '{}' }));
  assert.equal((await recovered.probeAntigravityOfficialCredentials()).ok, true);
  console.log('[google-runtime-errors.test] ok');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
