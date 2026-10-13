'use strict';

// Internal estimators must be pure for a message object within one budget pass.
// Optimizers return new objects for changed content; caches never cross requests.
function createMessageTokenEstimator(estimate) {
  if (typeof estimate !== 'function')
    throw new TypeError('Message token estimator must be a function');
  const tokens = new WeakMap();
  return (message) => {
    const cacheable = message !== null && typeof message === 'object';
    if (cacheable && tokens.has(message)) return tokens.get(message);
    const value = estimate(message);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      throw new TypeError('Message token estimate must be a finite nonnegative number');
    if (cacheable) tokens.set(message, value);
    return value;
  };
}
module.exports = { createMessageTokenEstimator };
