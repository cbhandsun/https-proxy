'use strict';
const { types } = require('node:util');
const fail = () => new Error('n08_phase_observer_rejected');
function createN08PhaseObserver(observer = () => {}) {
  if (
    typeof observer !== 'function' ||
    types.isProxy(observer) ||
    types.isAsyncFunction(observer) ||
    types.isGeneratorFunction(observer)
  )
    throw fail();
  return (phase) => {
    if (
      !Number.isInteger(phase) ||
      !(phase === 71 || (phase >= 86 && phase <= 96) || (phase >= 140 && phase <= 190))
    )
      throw fail();
    try {
      observer(phase);
    } catch {
      throw fail();
    }
  };
}
module.exports = { createN08PhaseObserver };
