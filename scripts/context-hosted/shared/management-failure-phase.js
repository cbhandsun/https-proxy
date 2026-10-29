'use strict';
const { types } = require('node:util');

// Only a fixed transport category crosses the hosted observation boundary.
// Never invoke getters, Proxy traps or serialize the supplied error.
function managementFailurePhase(error) {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return 186;
  const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  switch (code) {
    case 'HPM_DAEMON_HTTP_DEADLINE':
      return 185;
    case 'HPM_DAEMON_HTTP_CONNECTION_REFUSED':
      return 191;
    case 'HPM_DAEMON_HTTP_CONNECTION_RESET':
      return 192;
    case 'HPM_DAEMON_HTTP_ABORTED':
      return 193;
    case 'HPM_DAEMON_HTTP_INVALID_REPLY':
      return 194;
    case 'HPM_DAEMON_HTTP_REPLY_LIMIT':
      return 195;
    default:
      return 186;
  }
}
module.exports = { managementFailurePhase };
