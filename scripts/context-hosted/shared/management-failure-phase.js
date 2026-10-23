'use strict';
const { types } = require('node:util');

// Only a fixed transport category crosses the hosted observation boundary.
// Never invoke getters, Proxy traps or serialize the supplied error.
function managementFailurePhase(error) {
  return error &&
    typeof error === 'object' &&
    !types.isProxy(error) &&
    Object.getOwnPropertyDescriptor(error, 'code')?.value === 'HPM_DAEMON_HTTP_DEADLINE'
    ? 185
    : 186;
}
module.exports = { managementFailurePhase };
