'use strict';
const { types } = require('node:util');
const { installCoverageIoCapture } = require('../../scripts/lib/coverage-io-capture');
// Keep the original fixture failure even if stopping its own recording fails.
// Success leaves the window open for the unchanged whole-file after hook.
function installPublicationIoCapture(test, install = installCoverageIoCapture) {
  if (typeof install !== 'function' || types.isProxy(install) || types.isAsyncFunction(install))
    throw new Error('publication_io_capture_invalid');
  let stop;
  install(test, {
    windowId: 'publication-graceful-http',
    onReady(value) {
      if (typeof value !== 'function' || types.isProxy(value) || types.isAsyncFunction(value))
        throw new Error('publication_io_capture_invalid');
      stop = value;
    },
  });
  return async (operation) => {
    if (typeof operation !== 'function' || types.isProxy(operation))
      throw new Error('publication_io_capture_invalid');
    try {
      return await operation();
    } catch (error) {
      if (stop) {
        let captureFailed = false,
          captureError;
        try {
          stop();
        } catch (observationError) {
          captureFailed = true;
          captureError = observationError;
        }
        if (captureFailed)
          throw new AggregateError([error, captureError], 'publication_and_capture_failed', {
            cause: error,
          });
      }
      throw error;
    }
  };
}
module.exports = { installPublicationIoCapture };
