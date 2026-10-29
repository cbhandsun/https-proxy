'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { fingerprintContextData } = require('./context-recovery-fingerprint');
const { MAX_WIRE_BYTES } = require('./context-api-evidence-protocol');
const { normalizeRecoveryRequestBody } = require('./context-recovery-request-data');

const identity = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const laneId = (value) =>
  value === undefined || (typeof value === 'string' && /^[A-Za-z0-9_.-]{1,256}$/.test(value));
const policy = (body) =>
  fingerprintContextData({
    model: body.model ?? null,
    instructions: body.instructions ?? null,
    system: body.system ?? null,
    tools: body.tools ?? null,
    toolChoice: body.tool_choice ?? null,
  });

// Owned by one authenticated, pinned-target connection. An acknowledged empty
// warmup has no input or output to recover; its next full input can start a root.
// This affects local admission only, never the request sent to the provider.
function createRecoveryWebSocketWarmups({ now = Date.now } = {}) {
  if (typeof now !== 'function') throw new TypeError('Invalid recovery warmup clock');
  const receipts = new Map();
  let closed = false,
    lastTime = 0;
  function clock() {
    const time = now();
    if (!Number.isSafeInteger(time) || time < lastTime || time > Number.MAX_SAFE_INTEGER - 60000)
      throw new TypeError('Invalid recovery warmup time');
    lastTime = time;
    for (const [lane, receipt] of receipts) if (receipt.expiresAt <= time) receipts.delete(lane);
    return time;
  }
  return {
    remember(input, output, lane) {
      if (closed) return;
      try {
        const time = clock();
        const body = normalizeCompactionData(input, MAX_WIRE_BYTES);
        const response = normalizeCompactionData(output, MAX_WIRE_BYTES);
        if (
          !laneId(lane) ||
          body?.generate !== false ||
          !Array.isArray(body.input) ||
          body.input.length ||
          body.previous_response_id != null ||
          !identity(response?.id) ||
          response.status !== 'completed' ||
          !Array.isArray(response.output) ||
          response.output.length
        )
          return;
        if (!receipts.has(lane) && receipts.size >= 33) return;
        receipts.set(lane, { id: response.id, policy: policy(body), expiresAt: time + 60000 });
      } catch {
        receipts.clear();
      }
    },
    admission(input, lane) {
      if (closed) return input;
      try {
        clock();
        const receipt = receipts.get(lane);
        const body = normalizeRecoveryRequestBody('responses', input, 3);
        if (
          !receipt ||
          !laneId(lane) ||
          body.generate === false ||
          body.previous_response_id !== receipt.id ||
          policy(body) !== receipt.policy ||
          !(typeof body.input === 'string'
            ? body.input.length
            : Array.isArray(body.input) && body.input.length)
        )
          return input;
        receipts.delete(lane);
        delete body.previous_response_id;
        return body;
      } catch {
        receipts.clear();
        return input;
      }
    },
    close() {
      closed = true;
      receipts.clear();
    },
  };
}

module.exports = { createRecoveryWebSocketWarmups };
