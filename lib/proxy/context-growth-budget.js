'use strict';

// This forecasts incoming *context* growth, not provider output-token capacity.
// Byte limits are always the serialized upstream request limit, never string
// lengths or the compressed wire size. No content/IDs leave this module.
const DEFAULT_GROWTH_RESERVE_BYTES = 16 * 1024;
const MAX_GROWTH_RESERVE_BYTES = 64 * 1024;
const MAX_GROWTH_SAMPLES = 8;
const MAX_SCAN_MESSAGES = 128;

function nonnegativeInteger(value, fallback) {
  if (typeof value !== 'number' && typeof value !== 'string') return fallback;
  if (typeof value === 'string' && !/^\d+$/.test(value)) return fallback;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

function resultCost(message) {
  // Saturate the estimate before serializing an enormous result. Unknown
  // objects cannot run toJSON/coercion hooks in this forecast path.
  if (typeof message?.content !== 'string') return null;
  if (message.content.length >= MAX_GROWTH_RESERVE_BYTES) return MAX_GROWTH_RESERVE_BYTES;
  return Math.min(
    MAX_GROWTH_RESERVE_BYTES,
    Buffer.byteLength(JSON.stringify({ role: 'tool', content: message.content })) + 512
  );
}

function recentResultCosts(messages) {
  if (!Array.isArray(messages)) return [];
  const calls = new Map();
  const seenResults = new Set();
  const costs = [];
  for (const message of messages.slice(-MAX_SCAN_MESSAGES)) {
    if (message?.role === 'tool' && typeof message.tool_call_id === 'string') {
      const group = calls.get(message.tool_call_id);
      if (!group || seenResults.has(message.tool_call_id)) continue;
      seenResults.add(message.tool_call_id);
      const cost = resultCost(message);
      group.pending.delete(message.tool_call_id);
      if (cost === null) group.invalid = true;
      else group.cost = Math.min(MAX_GROWTH_RESERVE_BYTES, group.cost + cost);
      if (group.pending.size === 0 && !group.invalid) costs.push(group.cost);
    }
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      const ids = message.tool_calls.slice(0, 64).map((call) => call?.id);
      if (
        message.tool_calls.length > 64 ||
        ids.length === 0 ||
        ids.some((id) => typeof id !== 'string' || id.length > 256 || calls.has(id)) ||
        new Set(ids).size !== ids.length
      )
        continue;
      const group = { pending: new Set(ids), cost: 0, invalid: false };
      for (const id of ids) calls.set(id, group);
    }
  }
  return costs.slice(-MAX_GROWTH_SAMPLES);
}

function resolveContextGrowthBudget(body, hardBodyBytes, options = {}) {
  const hard = nonnegativeInteger(hardBodyBytes, 0);
  const settings = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const configured = nonnegativeInteger(settings.growthReserveBytes, DEFAULT_GROWTH_RESERVE_BYTES);
  const costs = recentResultCosts(body?.messages);
  // Recent peak + shell overhead is conservative; a bounded spike may increase
  // headroom but cannot reduce the usable request envelope by more than 25%.
  const predicted = costs.reduce((maximum, cost) => Math.max(maximum, cost), 0);
  const reserveBytes = Math.min(
    Math.floor(hard / 4),
    MAX_GROWTH_RESERVE_BYTES,
    Math.max(Math.min(configured, MAX_GROWTH_RESERVE_BYTES), predicted)
  );
  return {
    hardBodyBytes: hard,
    planningBodyBytes: hard - reserveBytes,
    triggerBodyBytes: hard - Math.ceil(reserveBytes / 2),
    growthReserveBytes: reserveBytes,
    growthSampleCount: costs.length,
  };
}

module.exports = {
  DEFAULT_GROWTH_RESERVE_BYTES,
  MAX_GROWTH_RESERVE_BYTES,
  MAX_GROWTH_SAMPLES,
  resolveContextGrowthBudget,
};
