'use strict';

const assert = require('node:assert/strict');
const { planWorkBuddyWbipcRequest } = require('../lib/proxy/workbuddy-context-planner');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const { createContextCapacityController } = require('../lib/proxy/context-capacity-controller');
const { applyResponsesHistoryPolicy } = require('../lib/proxy/responses-history-policy');

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const immutable = { role: 'system', content: '保持凭证和授权边界。' };
const current = { role: 'user', content: '用户原文不得删改。' };
const history = [immutable, current];
for (let i = 0; i < 20; i += 1)
  history.push(
    {
      role: 'assistant',
      tool_calls: [
        { id: `call-${i}`, type: 'function', function: { name: 'read', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: `call-${i}`, content: '汉🙂"\\\n'.repeat(2500) }
  );
const body = { messages: history };
const before = JSON.stringify(body);
const plan = planWorkBuddyWbipcRequest(body, { targetBodyBytes: 160000 });
assert.equal(plan.fits, true);
assert.equal(plan.diagnostics.growthReserveSatisfied, true);
assert.ok(plan.diagnostics.growthSampleCount > 0);
assert.ok(plan.diagnostics.remainingBodyBytes >= plan.diagnostics.growthReserveBytes);
assert.ok(plan.body.messages.includes(immutable));
assert.ok(plan.body.messages.includes(current));
assert.equal(JSON.stringify(body), before);
assert.ok(!JSON.stringify(plan.diagnostics).includes('用户原文'));

// This is the smaller request that an over-conservative reserve must never
// locally lock out after accepted intermediate dispatches and a later rejection.
const capacity = createContextCapacityController({ now: () => 1000 });
capacity.recordSuccess('profile', 234606, 393216);
capacity.recordRejection('profile', 241295);
const hard = capacity.targetBytes('profile', 393216);
const smaller = { messages: [{ role: 'system', content: 'x'.repeat(211000) }, current] };
assert.equal(planWorkBuddyWbipcRequest(smaller, { force: true, targetBodyBytes: hard }).fits, true);
const mandatory = { messages: [{ role: 'system', content: 'x'.repeat(222000) }, current] };
const mandatoryPlan = planWorkBuddyWbipcRequest(mandatory, { force: true, targetBodyBytes: hard });
assert.equal(mandatoryPlan.fits, true);
assert.equal(mandatoryPlan.diagnostics.growthReserveReclaimed, true);
assert.equal(mandatoryPlan.diagnostics.growthReserveSatisfied, false);
assert.equal(bytes(mandatoryPlan.body), bytes(mandatory));
assert.equal(mandatoryPlan.body.messages[0], mandatory.messages[0]);

const overflow = planWorkBuddyWbipcRequest(mandatory, { force: true, targetBodyBytes: 200000 });
assert.equal(overflow.fits, false);
assert.equal(overflow.diagnostics.reason, 'immutable_context_too_large');
const disabled = planWorkBuddyWbipcRequest(
  applyResponsesHistoryPolicy({ ...body }, { truncation: 'disabled' }),
  { targetBodyBytes: 160000 }
);
assert.equal(disabled.changed, false);
assert.equal(disabled.fits, false);

// Planning twice against the same original data must not admit the same
// historical evidence twice or evict valid receipts to manufacture headroom.
let admissions = 0;
const store = createContextArtifactStore();
const countedStore = {
  put(...args) {
    admissions += 1;
    return store.put(...args);
  },
};
const quotaBody = {
  messages: [
    { role: 'system', content: 'p'.repeat(68000) },
    current,
    {
      role: 'assistant',
      tool_calls: [
        { id: 'quota-call', type: 'function', function: { name: 'read', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'quota-call', content: 'q'.repeat(45000) },
  ],
};
const quotaPlan = planWorkBuddyWbipcRequest(quotaBody, {
  force: true,
  targetBodyBytes: 80000,
  artifactStore: countedStore,
  artifactOwner: 'test-owner',
  artifactScope: 'test-scope',
});
assert.equal(quotaPlan.fits, true);
assert.equal(quotaPlan.diagnostics.growthReserveReclaimed, true);
assert.equal(admissions, 2, 'one call receipt and one result receipt, not duplicate admissions');
assert.equal(quotaPlan.diagnostics.artifactsStored, 2);
