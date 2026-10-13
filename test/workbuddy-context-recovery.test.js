'use strict';

const assert = require('node:assert/strict');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const {
  contextArtifactToolDefinition,
  CONTEXT_ARTIFACT_TOOL_NAME,
} = require('../lib/proxy/context-artifact-tool');
const {
  planWorkBuddyContextRecovery,
  createContextRecoveryGuard,
  MAX_CONTEXT_RECOVERY_ROUNDS,
} = require('../lib/proxy/workbuddy-context-recovery');

const store = createContextArtifactStore();
const owner = 'test-owner';
const scope = 'hcs_' + '2'.repeat(32);
const receipt = store.put(
  owner,
  scope,
  'a'.repeat(100000) + 'MIDDLE_SENTINEL' + '汉🙂'.repeat(15000)
);
const args = {
  locator: receipt.locator,
  scope,
  digest: receipt.digest,
  offsetBytes: 100000,
  limitBytes: 16384,
};
const response = (argumentsValue = args, id = 'recovery', extra = []) =>
  JSON.stringify({
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id,
              type: 'function',
              function: {
                name: CONTEXT_ARTIFACT_TOOL_NAME,
                arguments: JSON.stringify(argumentsValue),
              },
            },
            ...extra,
          ],
        },
      },
    ],
  });
const policy = { role: 'system', content: 'P'.repeat(104274) };
const user = {
  role: 'user',
  content: 'Read the required historical middle, do not drop my requirements.',
};
const messages = [policy, user];
for (let index = 0; index < 30; index += 1)
  messages.push(
    {
      role: 'assistant',
      tool_calls: [
        { id: `call-${index}`, type: 'function', function: { name: 'read', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: `call-${index}`, content: 'old'.repeat(2500) }
  );
const body = {
  model: 'hy4-preview-f',
  stream: false,
  messages,
  tools: [contextArtifactToolDefinition()],
};
const before = JSON.stringify(body);
const options = {
  responseBody: response(),
  chatBody: body,
  store,
  owner,
  targetBodyBytes: 149111,
  plannerOptions: { artifactStore: store, artifactOwner: owner, artifactScope: scope },
};
const result = planWorkBuddyContextRecovery(options);
assert.equal(result.ok, true);
assert.equal(result.plan.fits, true);
assert.equal(result.resolvedCount, 1);
assert.equal(result.attemptedCount, 1);
assert.ok(Buffer.byteLength(JSON.stringify(result.plan.body)) <= 149111);
const restored = result.plan.body.messages.find((message) => message.tool_call_id === 'recovery');
const page = JSON.parse(restored.content);
assert.equal(page.ok, true);
assert.ok(page.page.text.includes('MIDDLE_SENTINEL'));
assert.equal(page.page.offsetBytes, 100000);
assert.ok(page.page.nextOffsetBytes > 100000);
assert.ok(result.plan.body.messages.includes(policy));
assert.ok(result.plan.body.messages.includes(user));
for (const message of result.protectedMessages)
  assert.ok(result.plan.body.messages.includes(message));
assert.equal(JSON.stringify(body), before);
assert.equal(store.read(owner, scope, receipt.locator, receipt.digest).ok, true);

const unavailable = planWorkBuddyContextRecovery({
  ...options,
  responseBody: response({ ...args, digest: '0'.repeat(64) }),
});
assert.equal(unavailable.plan.fits, true);
assert.equal(unavailable.resolvedCount, 0);
assert.equal(unavailable.unavailableCount, 1);
let reads = 0;
const impossible = planWorkBuddyContextRecovery({
  ...options,
  targetBodyBytes: 50000,
  store: {
    readPage() {
      reads += 1;
      throw new Error('must not read before budget fit');
    },
  },
});
assert.equal(impossible.plan.fits, false);
assert.equal(reads, 0);
const mixed = planWorkBuddyContextRecovery({
  ...options,
  responseBody: response(args, 'read', [
    { id: 'external', type: 'function', function: { name: 'read', arguments: '{}' } },
  ]),
});
assert.equal(mixed.ok, false);
assert.equal(mixed.reason, 'invalid_internal_tool_turn');

const multiResponse = response(args, 'read1', [
  {
    id: 'read2',
    type: 'function',
    function: {
      name: CONTEXT_ARTIFACT_TOOL_NAME,
      arguments: JSON.stringify({ ...args, offsetBytes: 0 }),
    },
  },
]);
const multi = planWorkBuddyContextRecovery({ ...options, responseBody: multiResponse });
assert.equal(multi.plan.fits, true);
assert.equal(multi.resolvedCount, 2);
for (const message of multi.protectedMessages)
  if (message.role === 'tool') assert.equal(JSON.parse(message.content).ok, true);

const guard = createContextRecoveryGuard();
assert.equal(guard.accept(response(), false, 10000).ok, true);
assert.equal(
  guard.accept(response(args, 'new-id'), false, 10000).reason,
  'context_artifact_read_loop'
);
const defaultsGuard = createContextRecoveryGuard();
const defaultArgs = { locator: receipt.locator, scope, digest: receipt.digest };
assert.equal(defaultsGuard.accept(response(defaultArgs), false, 10000).ok, true);
assert.equal(
  defaultsGuard.accept(
    response({ ...defaultArgs, offsetBytes: 0, limitBytes: 16384 }),
    false,
    10000
  ).reason,
  'context_artifact_read_loop'
);
const boundedGuard = createContextRecoveryGuard();
assert.deepEqual(boundedGuard.accept('bad-json', false, 10000), { matched: false });
for (let index = 0; index < MAX_CONTEXT_RECOVERY_ROUNDS; index += 1)
  assert.equal(
    boundedGuard.accept(response({ ...args, offsetBytes: index }), false, 10000).ok,
    true
  );
assert.equal(
  boundedGuard.accept(response({ ...args, offsetBytes: 100 }), false, 10000).reason,
  'context_artifact_read_limit'
);
console.log('[workbuddy-context-recovery.test] ok');
