'use strict';
const { types } = require('node:util');
const fail = () => new Error('coverage_io_window_invalid');

// Selection is not authorization. The recorder still admits the exact hosted
// workflow/job/source before a selected file can start its unique WPR instance.
function requiredCoverageIoWindows(environment = process.env) {
  if (
    !environment ||
    typeof environment !== 'object' ||
    Array.isArray(environment) ||
    types.isProxy(environment)
  )
    throw fail();
  const stage = Object.getOwnPropertyDescriptor(environment, 'HPM_COVERAGE_IO_STAGE');
  if (
    !stage?.enumerable ||
    !Object.hasOwn(stage, 'value') ||
    !['proxy', 'client'].includes(stage.value)
  )
    throw fail();
  const proxy = Object.getOwnPropertyDescriptor(environment, 'HPM_COVERAGE_IO_PROXY_WINDOW');
  if (
    proxy &&
    (!proxy.enumerable ||
      !Object.hasOwn(proxy, 'value') ||
      proxy.value !== 'native-publication-interruption' ||
      stage.value !== 'proxy')
  )
    throw fail();
  return Object.freeze(
    stage.value === 'client'
      ? ['client-context-target', 'publication-graceful-http']
      : [proxy ? 'native-publication-interruption' : 'client-context-target']
  );
}
module.exports = { requiredCoverageIoWindows };
