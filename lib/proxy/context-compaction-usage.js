'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');

function invalidUsage() {
  const error = new TypeError('Compaction usage is unavailable or invalid');
  error.code = 'compaction_usage_unavailable';
  return error;
}
const count = (value) => Number.isSafeInteger(value) && value >= 0;

// Provider-reported counts only. Missing detail fields remain absent; estimates,
// prices and an assumed cache hit never become usage or billing evidence.
function normalizeCompactionUsage(value) {
  let data;
  try {
    data = normalizeCompactionData(value, 4096);
  } catch {
    throw invalidUsage();
  }
  if (!data || Array.isArray(data) || typeof data !== 'object') throw invalidUsage();
  const chat = Object.hasOwn(data, 'prompt_tokens') || Object.hasOwn(data, 'completion_tokens');
  if (chat && (Object.hasOwn(data, 'input_tokens') || Object.hasOwn(data, 'output_tokens')))
    throw invalidUsage();
  const input = data[chat ? 'prompt_tokens' : 'input_tokens'];
  const output = data[chat ? 'completion_tokens' : 'output_tokens'];
  if (
    !count(input) ||
    !count(output) ||
    !count(data.total_tokens) ||
    !count(input + output) ||
    data.total_tokens !== input + output
  )
    throw invalidUsage();
  const usage = { input_tokens: input, output_tokens: output, total_tokens: data.total_tokens };
  for (const [from, to, maximum, fields] of [
    [
      chat ? 'prompt_tokens_details' : 'input_tokens_details',
      'input_tokens_details',
      input,
      ['cached_tokens', 'cache_write_tokens'],
    ],
    [
      chat ? 'completion_tokens_details' : 'output_tokens_details',
      'output_tokens_details',
      output,
      ['reasoning_tokens'],
    ],
  ]) {
    if (data[from] == null) continue;
    if (typeof data[from] !== 'object' || Array.isArray(data[from])) throw invalidUsage();
    const details = {};
    for (const key of fields) {
      if (!Object.hasOwn(data[from], key)) continue;
      if (!count(data[from][key]) || data[from][key] > maximum) throw invalidUsage();
      details[key] = data[from][key];
    }
    if (Object.keys(details).length) usage[to] = details;
  }
  return usage;
}

function createCompactionUsageAccumulator() {
  let calls = 0;
  let unavailable = false;
  let total = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  function add(value) {
    calls++;
    if (value == null) {
      unavailable = true;
      return;
    }
    let usage;
    try {
      usage = normalizeCompactionUsage(value);
    } catch (error) {
      unavailable = true;
      throw error;
    }
    for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
      if (!count(total[key] + usage[key])) {
        unavailable = true;
        throw invalidUsage();
      }
    }
    const next = {};
    for (const key of ['input_tokens', 'output_tokens', 'total_tokens'])
      next[key] = total[key] + usage[key];
    for (const [section, fields] of [
      ['input_tokens_details', ['cached_tokens', 'cache_write_tokens']],
      ['output_tokens_details', ['reasoning_tokens']],
    ]) {
      const details = {};
      for (const key of fields) {
        if (
          usage[section]?.[key] === undefined ||
          (calls > 1 && total[section]?.[key] === undefined)
        )
          continue;
        const sum = (total[section]?.[key] ?? 0) + usage[section][key];
        if (!count(sum)) {
          unavailable = true;
          throw invalidUsage();
        }
        details[key] = sum;
      }
      if (Object.keys(details).length) next[section] = details;
    }
    total = next;
  }
  return Object.freeze({
    add,
    result() {
      return {
        calls,
        usage: unavailable ? null : normalizeCompactionUsage(total),
        source: unavailable ? 'unavailable' : calls ? 'upstream_reported' : 'no_upstream_call',
      };
    },
  });
}

module.exports = { normalizeCompactionUsage, createCompactionUsageAccumulator };
