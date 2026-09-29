'use strict';

/** Cancel the active upstream attempt when the downstream disappears. */
function createDownstreamCancellation({ clientReq, clientRes, onCancel } = {}) {
  if (!clientReq || !clientRes || typeof onCancel !== 'function') {
    throw new TypeError('downstream cancellation requires request, response, and callback');
  }
  let cancelled = false;
  let activeRequest = null;

  function cancel() {
    if (cancelled || clientRes.writableFinished === true || clientRes.writableEnded === true) {
      return false;
    }
    cancelled = true;
    onCancel();
    if (activeRequest && typeof activeRequest.destroy === 'function') activeRequest.destroy();
    return true;
  }

  clientReq.once('aborted', cancel);
  clientRes.once('close', cancel);
  if (clientReq.aborted === true || clientRes.destroyed === true) cancel();

  return {
    isCancelled: () => cancelled,
    setActive(request) {
      activeRequest = request;
      if (cancelled && activeRequest && typeof activeRequest.destroy === 'function') {
        activeRequest.destroy();
      }
    },
  };
}

module.exports = { createDownstreamCancellation };
