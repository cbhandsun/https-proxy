'use strict';

// Downstream cancellation is owned by the output controller, so it need not run
// an upstream failure callback. Release parser buffers on either lifecycle path.
function attachConversionStreamCleanup(clientRes, converter) {
  let released = false;
  function detach() {
    clientRes.removeListener?.('close', dispose);
    clientRes.removeListener?.('error', dispose);
    clientRes.removeListener?.('finish', finish);
  }
  function dispose() {
    if (released) return;
    released = true;
    detach();
    if (!converter.state.finished) converter.dispose?.();
  }
  function finish() {
    dispose();
  }
  clientRes.once?.('close', dispose);
  clientRes.once?.('error', dispose);
  clientRes.once?.('finish', finish);
  return detach;
}
module.exports = { attachConversionStreamCleanup };
