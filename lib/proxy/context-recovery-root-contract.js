'use strict';

function rootStateFailure() {
  return Object.assign(new TypeError('invalid_context_recovery_root_state'), {
    code: 'invalid_context_recovery_root_state',
  });
}

module.exports = { rootStateFailure };
