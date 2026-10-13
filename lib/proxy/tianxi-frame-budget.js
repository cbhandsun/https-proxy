'use strict';

const LIMITS = Object.freeze({ messageBytes: 1048576, totalBytes: 16777216, messages: 65536 });
function exceeded() {
  throw new Error('tianxi_tac_server_output_limit');
}

// Bound wire input before parsing, including malformed events. Each task owns
// its own budget; no event or user content is included in the failure metadata.
function createTianxiFrameBudget(limits = LIMITS) {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits))
    throw new TypeError('Invalid Tianxi frame budget');
  for (const key of Object.keys(LIMITS)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > LIMITS[key])
      throw new TypeError('Invalid Tianxi frame budget');
  }
  const policy = { ...limits };
  let bytes = 0,
    messages = 0;
  const frames = [];
  function consume(text) {
    if (typeof text !== 'string') exceeded();
    const size = Buffer.byteLength(text);
    if (
      size > policy.messageBytes ||
      bytes + size > policy.totalBytes ||
      messages >= policy.messages
    )
      exceeded();
    bytes += size;
    messages++;
  }
  return {
    frames,
    parse(text) {
      consume(text);
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        return null;
      }
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null;
      frames.push(frame);
      return frame;
    },
    appendLocal(frame) {
      let text;
      try {
        text = JSON.stringify(frame);
      } catch {
        exceeded();
      }
      consume(text);
      frames.push(frame);
    },
  };
}

module.exports = { createTianxiFrameBudget };
