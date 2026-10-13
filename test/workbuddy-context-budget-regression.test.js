'use strict';

const assert = require('node:assert/strict');
const { planWorkBuddyWbipcRequest } = require('../lib/proxy/workbuddy-context-planner');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const { checkpointPayload } = require('../lib/proxy/context-checkpoint');

const options = {
  force: true,
  targetBodyBytes: 118535,
  operationalInputTokens: 96 * 1024,
  artifactStore: createContextArtifactStore(),
  artifactOwner: 'profile-a',
  artifactScope: 'hcs_' + 'a'.repeat(32),
};
const policy = { role: 'system', content: 'p'.repeat(104950) };
const task = { role: 'user', content: 'Never upload private files. Continue and verify.' };
const tools = Array.from({ length: 13 }, (_, index) => ({
  type: 'function',
  function: {
    name: `exec_${index}`,
    description: 'd'.repeat(500),
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
  },
}));
const exchanges = Array.from({ length: 710 }, (_, index) => [
  {
    role: 'assistant',
    content: `progress-${index}`,
    tool_calls: [
      {
        id: `call_${index}`,
        type: 'function',
        function: {
          name: 'exec_0',
          arguments: JSON.stringify({ command: 'c'.repeat(2200) }),
        },
      },
    ],
  },
  { role: 'tool', tool_call_id: `call_${index}`, content: 'r'.repeat(3000) },
]).flat();
const body = { model: 'deepseek-v4.1-flash', tools, messages: [policy, task, ...exchanges] };
const original = JSON.stringify(body);
const planned = planWorkBuddyWbipcRequest(body, options);
assert.equal(planned.fits, true, 'completed arguments must adapt to the learned 118535B window');
assert.ok(planned.diagnostics.finalBodyBytes <= options.targetBodyBytes);
assert.equal(planned.diagnostics.finalBodyBytes, Buffer.byteLength(JSON.stringify(planned.body)));
assert.equal(
  planned.body.tools.find((tool) => tool.function?.name === 'hpm_read_context_artifact').function
    .description,
  require('../lib/proxy/context-artifact-tool').contextArtifactToolDefinition().function
    .description,
  'Admission must measure the final composed recovery catalog, not a smaller intermediate copy'
);
assert.ok(planned.diagnostics.evictedToolRounds > 702);
assert.strictEqual(planned.body.messages[0], policy);
assert.ok(planned.body.messages.includes(task));
assert.equal(planned.diagnostics.checkpointValid, true);
assert.ok(
  planned.diagnostics.artifactsStored <= 32,
  'adaptive passes reuse receipts instead of repeatedly storing the same calls and results'
);
assert.equal(JSON.stringify(body), original);
const calls = planned.body.messages.flatMap((message) => message.tool_calls || []);
assert.deepEqual(
  planned.body.messages
    .filter((message) => message.role === 'tool')
    .map((message) => message.tool_call_id),
  calls.map((call) => call.id)
);
for (const call of calls) assert.doesNotThrow(() => JSON.parse(call.function.arguments));
const checkpoint = planned.body.messages.find((message) => checkpointPayload(message));
const receipt = checkpointPayload(checkpoint).entries.find(
  (entry) => entry.callReceipt
)?.callReceipt;
assert.ok(receipt);
assert.equal(
  options.artifactStore.read(
    options.artifactOwner,
    options.artifactScope,
    receipt.locator,
    receipt.digest
  ).ok,
  true,
  'adaptive passes retain recoverable call arguments'
);
assert.equal(
  options.artifactStore.read('profile-b', options.artifactScope, receipt.locator, receipt.digest)
    .ok,
  false
);

const oldRequirement = {
  role: 'user',
  content: 'u'.repeat(7000) + 'NEVER_UPLOAD_PRIVATE_FILES' + 'u'.repeat(7000),
};
const requirementBody = {
  messages: [
    oldRequirement,
    { role: 'assistant', content: 'a'.repeat(15000) },
    { role: 'user', content: 'middle' },
    { role: 'user', content: 'latest' },
  ],
};
const requirements = planWorkBuddyWbipcRequest(requirementBody, {
  force: true,
  targetBodyBytes: 4096,
  keepRecentUserTurns: 1,
});
assert.equal(requirements.fits, false, 'required user context alone exceeds the budget');
assert.ok(requirements.body.messages.includes(oldRequirement));

const image = {
  role: 'user',
  content: [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'a'.repeat(12000) } },
  ],
};
const imageBody = {
  messages: [image, { role: 'user', content: 'middle' }, { role: 'user', content: 'latest' }],
};
const images = planWorkBuddyWbipcRequest(imageBody, { force: true, targetBodyBytes: 4096 });
assert.equal(images.fits, false);
assert.ok(images.body.messages.includes(image));

const unavailable = planWorkBuddyWbipcRequest(
  {
    messages: [
      { role: 'assistant', content: 'previous progress '.repeat(1000) },
      { role: 'user', content: 'middle' },
      { role: 'user', content: 'latest' },
    ],
  },
  { force: true, targetBodyBytes: 4096, maxChars: 32 }
);
assert.equal(unavailable.fits, false, 'checkpoint failure cannot fall through to generic pruning');
assert.equal(unavailable.diagnostics.reason, 'checkpoint_unavailable');
assert.ok(unavailable.body.messages[0].content.startsWith('previous progress'));

const pending = {
  role: 'assistant',
  tool_calls: [
    {
      id: 'pending',
      type: 'function',
      function: { name: 'write', arguments: JSON.stringify({ content: 'x'.repeat(150000) }) },
    },
  ],
};
const unresolved = planWorkBuddyWbipcRequest(
  { messages: [task, ...exchanges.slice(-20), pending] },
  options
);
assert.equal(unresolved.fits, false);
assert.ok(unresolved.body.messages.includes(pending));
assert.ok(!JSON.stringify(planned.diagnostics).includes('Never upload'));

console.log('[workbuddy-context-budget-regression.test] ok');
