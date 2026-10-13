'use strict';

const assert = require('node:assert/strict');
const {
  createOpenAIResponsesToChatHandler,
} = require('../lib/proxy/handlers/responses-to-chat-handler');

async function main() {
  const targets = [];
  const successes = [];
  let status = 200;
  let complete;
  const handler = createOpenAIResponsesToChatHandler(
    {
      CORS_HEADERS: {},
      logRequestEnd() {},
      logProxyEvent() {},
      parseProxyBody: () => ({ model: 'workbuddy/deepseek-v4.1-flash', input: 'ping' }),
      responsesToChatWithHistory: () => ({
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'ping' }],
      }),
      rejectUnsupportedResponsesConversion: () => false,
      rememberResponsesFromChatResponse() {},
      openAIChatToResponses: () => ({ id: 'resp-test', output: [] }),
      parseJsonOrSseJson: JSON.parse,
      sendJsonError: () => complete(),
      writeJsonResponse: () => complete(),
      contextCapacityController: {
        targetBytes(key, configured) {
          targets.push(key);
          return configured;
        },
        recordSuccess(key) {
          successes.push(key);
        },
        recordRejection() {
          throw new Error('no payload rejection in this fixture');
        },
      },
      workBuddyWbipcClient: {
        request: async () => ({
          ok: true,
          status,
          headers: {},
          body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
        }),
      },
    },
    {
      boundedResponseContext: () => ({}),
      proxyErrorContext: () => ({}),
      handleConvertedJsonResponse: () => complete(),
    }
  );
  const run = async (profileId, responseStatus) => {
    status = responseStatus;
    let timeout;
    try {
      await new Promise((resolve, reject) => {
        complete = resolve;
        timeout = setTimeout(() => reject(new Error('fixture response timed out')), 3000);
        handler(
          { method: 'POST', headers: {} },
          { headersSent: false },
          {
            authProvider: 'workbuddy',
            buffer: Buffer.from('{}'),
            profile: { id: profileId, protocol: 'workbuddy' },
            rewriteTo: 'deepseek-v4.1-flash',
            workbuddyAuth: { accessTokenEncrypted: true },
          },
          { path: '/v2', hostname: 'www.workbuddy.cn', protocol: 'https:' },
          '',
          '/v1/responses',
          Date.now()
        );
      });
    } finally {
      clearTimeout(timeout);
    }
  };
  await run('profile-a', 403);
  await run('profile-a', 500);
  assert.equal(successes.length, 0, 'HTTP errors must not teach successful capacity');
  await run('profile-a', 200);
  await run('profile-b', 200);
  assert.equal(successes.length, 2);
  assert.notEqual(successes[0], successes[1], 'profile capacity is isolated');
  assert.deepEqual(JSON.parse(successes[0]), ['profile-a', '/v2', 'deepseek-v4.1-flash', 'stream']);
  assert.equal(targets[0], targets[1]);
  console.log('[workbuddy-context-capacity-route.test] ok');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
