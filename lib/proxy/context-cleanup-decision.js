'use strict';

const NUMBER_FIELDS = [
  'originalBodyBytes',
  'finalBodyBytes',
  'originalEstimatedTokens',
  'finalEstimatedTokens',
  'targetBodyBytes',
  'operationalInputTokens',
  'minimumCleanupBytes',
];
const FIELDS = [...NUMBER_FIELDS, 'forced', 'candidateFits'];

// Decisions use admitted, serialized request measurements, not previews or
// compression ratios. No request content, identities or arbitrary log strings.
function decideContextCleanup(input) {
  const invalid = () => {
    throw new TypeError('Invalid context cleanup decision');
  };
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    invalid();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== FIELDS.length || keys.some((key) => !FIELDS.includes(key))) invalid();
  const values = Object.create(null);
  for (const key of FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    const value = descriptor.value;
    if (
      NUMBER_FIELDS.includes(key)
        ? !Number.isSafeInteger(value) || value < 0
        : typeof value !== 'boolean'
    )
      invalid();
    values[key] = value;
  }
  if (!values.targetBodyBytes || !values.operationalInputTokens) invalid();
  const savedBytes = Math.max(0, values.originalBodyBytes - values.finalBodyBytes);
  const savedTokens = Math.max(0, values.originalEstimatedTokens - values.finalEstimatedTokens);
  const required =
    values.forced ||
    values.originalBodyBytes > values.targetBodyBytes ||
    values.originalEstimatedTokens > values.operationalInputTokens;
  const minimumCleanupSatisfied = savedBytes >= values.minimumCleanupBytes;
  const candidateFits =
    values.candidateFits &&
    values.finalBodyBytes <= values.targetBodyBytes &&
    values.finalEstimatedTokens <= values.operationalInputTokens;
  const apply =
    candidateFits &&
    (required ||
      (savedBytes > 0 &&
        minimumCleanupSatisfied &&
        values.finalEstimatedTokens <= values.originalEstimatedTokens));
  return {
    apply,
    required,
    savedBytes,
    savedTokens,
    minimumCleanupSatisfied,
    reason: !candidateFits
      ? 'candidate_unavailable'
      : required
        ? values.forced
          ? 'forced_recovery'
          : 'required_capacity'
        : apply
          ? 'minimum_gain'
          : 'insufficient_gain',
  };
}

module.exports = { decideContextCleanup };
