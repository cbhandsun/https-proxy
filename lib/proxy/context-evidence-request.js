'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');

const failed = (field, reason) => ({
  ok: false,
  error: 'invalid_evidence_arguments',
  field,
  reason,
});
const SOURCE_ID = /^hce_[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function parseContextEvidenceRequest(name, input) {
  const list = name === 'hpm_list_retained_evidence';
  if (!list && name !== 'hpm_read_retained_evidence') return failed('arguments', 'invalid_data');
  let args;
  try {
    args = normalizeCompactionData(input === undefined && list ? {} : input, 1024);
  } catch {
    return failed('arguments', 'invalid_data');
  }
  if (!args || typeof args !== 'object' || Array.isArray(args))
    return failed('arguments', 'invalid_data');
  const allowed = list
    ? ['afterSourceId', 'limit']
    : ['sourceId', 'digest', 'offsetBytes', 'limitBytes'];
  if (Object.keys(args).some((key) => !allowed.includes(key)))
    return failed('arguments', 'unknown_field');
  for (const field of list ? ['afterSourceId'] : ['sourceId', 'digest']) {
    if (!Object.hasOwn(args, field)) {
      if (!list) return failed(field, 'required');
      continue;
    }
    if (typeof args[field] !== 'string') return failed(field, 'wrong_type');
    if (!(field === 'digest' ? DIGEST : SOURCE_ID).test(args[field]))
      return failed(field, 'invalid_format');
  }
  for (const [field, minimum, maximum] of list
    ? [['limit', 1, 16]]
    : [
        ['offsetBytes', 0, Number.MAX_SAFE_INTEGER],
        ['limitBytes', 1, 65536],
      ]) {
    if (!Object.hasOwn(args, field)) continue;
    if (typeof args[field] !== 'number') return failed(field, 'wrong_type');
    if (!Number.isSafeInteger(args[field])) return failed(field, 'not_safe_integer');
    if (args[field] < minimum || args[field] > maximum) return failed(field, 'out_of_range');
  }
  // Valid data is returned without clamping, string/number coercion, guessed
  // cursors, or widened permissions. Readers retain their existing defaults.
  return { ok: true, arguments: args };
}

module.exports = { parseContextEvidenceRequest };
