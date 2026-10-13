'use strict';

const { performance } = require('node:perf_hooks');
const { planWorkBuddyWbipcRequest } = require('./workbuddy-context-planner');

const MAX_REPLAY_WORKLOADS = 32;
const MAX_REPLAY_BODY_BYTES = 8 * 1024 * 1024;

function callPairs(messages) {
  const calls = new Map();
  const results = new Set();
  let invalid = false;
  for (const message of messages) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (typeof call?.id !== 'string' || calls.has(call.id)) invalid = true;
        else calls.set(call.id, JSON.stringify(call));
      }
    }
    if (message?.role === 'tool') {
      if (
        typeof message.tool_call_id !== 'string' ||
        !calls.has(message.tool_call_id) ||
        results.has(message.tool_call_id)
      )
        invalid = true;
      else results.add(message.tool_call_id);
    }
  }
  return { calls, results, invalid };
}

function sameMessage(left, right) {
  return left?.role === right?.role && JSON.stringify(left) === JSON.stringify(right);
}

function invalidResult(index, code) {
  return { index, accepted: false, code, taskCorrectness: 'not-verified' };
}

// Offline structural replay is intentionally distinct from a model-quality
// evaluation. A transport success cannot manufacture a business-correctness
// score. Reports include only allowlisted codes, numeric metrics and booleans.
function replayContextCompaction(workloads) {
  if (
    !Array.isArray(workloads) ||
    workloads.length === 0 ||
    workloads.length > MAX_REPLAY_WORKLOADS
  ) {
    throw new TypeError('Context replay requires between 1 and 32 workloads');
  }
  return workloads.map((workload, index) => {
    if (
      !workload ||
      !Array.isArray(workload.body?.messages) ||
      !Number.isSafeInteger(workload.targetBodyBytes) ||
      workload.targetBodyBytes < 1
    ) {
      return invalidResult(index, 'invalid_workload');
    }
    let original;
    try {
      original = JSON.stringify(workload.body);
    } catch {
      return invalidResult(index, 'invalid_workload');
    }
    if (Buffer.byteLength(original) > MAX_REPLAY_BODY_BYTES)
      return invalidResult(index, 'replay_size_limit');
    const requirements = workload.body.messages.filter((message) =>
      ['system', 'developer', 'user'].includes(message?.role)
    );
    const before = callPairs(workload.body.messages);
    const start = performance.now();
    let plan;
    try {
      plan = planWorkBuddyWbipcRequest(workload.body, {
        force: true,
        targetBodyBytes: workload.targetBodyBytes,
      });
    } catch {
      return invalidResult(index, 'planning_failed');
    }
    const elapsedMs = Math.round((performance.now() - start) * 1000) / 1000;
    const messages = plan.body.messages;
    const retained = requirements.filter((requirement) =>
      messages.some((message) => sameMessage(message, requirement))
    ).length;
    const after = callPairs(messages);
    const pairsPreserved =
      !before.invalid &&
      !after.invalid &&
      [...after.calls.keys()].every((id) => !before.results.has(id) || after.results.has(id));
    const argumentsPreserved = [...after.calls].every(
      ([id, serialized]) => before.calls.get(id) === serialized
    );
    const inputUnchanged = JSON.stringify(workload.body) === original;
    const originalBytes = Buffer.byteLength(original);
    const finalBytes = Buffer.byteLength(JSON.stringify(plan.body));
    return {
      index,
      accepted: plan.fits,
      code: plan.fits ? 'fits' : 'context_too_large',
      originalBytes,
      finalBytes,
      growthReserveBytes: plan.diagnostics.growthReserveBytes,
      remainingBodyBytes: plan.diagnostics.remainingBodyBytes,
      constraintCount: requirements.length,
      retainedConstraintCount: retained,
      constraintRetentionRate: requirements.length ? retained / requirements.length : 1,
      pairsPreserved,
      argumentsPreserved,
      inputUnchanged,
      elapsedMs,
      taskCorrectness: 'not-verified',
      structuralChecksPassed:
        retained === requirements.length &&
        pairsPreserved &&
        argumentsPreserved &&
        inputUnchanged &&
        (!plan.fits || finalBytes <= workload.targetBodyBytes),
    };
  });
}

module.exports = { MAX_REPLAY_WORKLOADS, MAX_REPLAY_BODY_BYTES, replayContextCompaction };
