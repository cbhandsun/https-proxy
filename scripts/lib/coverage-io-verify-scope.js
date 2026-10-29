'use strict';

const { types } = require('node:util');
const fail = () => new Error('coverage_io_verify_scope_invalid');

// Selection only. The recorder separately authenticates the hosted workflow,
// job and source before either a capture or an omitted client phase is allowed.
function coverageIoVerifyScope(environment) {
  if (
    !environment ||
    typeof environment !== 'object' ||
    types.isProxy(environment) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(environment))
  )
    throw fail();
  function read(key) {
    const slot = Object.getOwnPropertyDescriptor(environment, key);
    if (!slot) return undefined;
    if (!slot.enumerable || !Object.hasOwn(slot, 'value') || typeof slot.value !== 'string')
      throw fail();
    return slot.value;
  }
  const mode = read('HPM_COVERAGE_IO_VERIFY_PROXY_ONLY');
  if (mode === undefined) return null;
  if (mode !== '1' || read('HPM_COVERAGE_IO_STAGE') !== 'proxy') throw fail();
  const lifecycle = read('npm_lifecycle_event');
  if (lifecycle === 'test:coverage') return 'proxy';
  if (lifecycle === 'test:client:coverage') return 'omit-client';
  throw fail();
}

module.exports = { coverageIoVerifyScope };
