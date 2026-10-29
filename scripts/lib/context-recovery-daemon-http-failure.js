'use strict';
const { types } = require('node:util');

function nativeHttpFailureCode(error) {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return undefined;
  const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  if (code === 'ECONNREFUSED') return 'HPM_DAEMON_HTTP_CONNECTION_REFUSED';
  if (code === 'ECONNRESET') return 'HPM_DAEMON_HTTP_CONNECTION_RESET';
  return undefined;
}
module.exports = { nativeHttpFailureCode };
