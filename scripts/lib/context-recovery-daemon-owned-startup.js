'use strict';

const { dataSnapshot } = require('./context-recovery-daemon-http-boundary');
const DEFAULTS = Object.freeze(Array(4).fill('openai-responses'));
function parseOwnedStartupProtocols(input) {
  if (input === undefined) return DEFAULTS;
  const values = dataSnapshot(input, 'daemon_owned_adapter_failed');
  if (
    !Array.isArray(values) ||
    values.length !== 4 ||
    values.some((value) => !['openai-responses', 'claude'].includes(value))
  )
    throw new Error('daemon_owned_adapter_failed');
  return Object.freeze(values);
}
module.exports = { parseOwnedStartupProtocols };
