'use strict';
// A failure receipt may describe fixed synthetic cases, never reader text/errors.
function parseCoverageControlFailure(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 128) return null;
  const match =
    /^capture_control_failed:phase=(import|valid|invalid_[0-7]|disposed);reason=(invoke|unexpected_error|accepted_invalid);length=([0-9]|1[0-2])\r?\n$/.exec(
      text
    );
  return match && match[0] === text
    ? Object.freeze({ phase: match[1], reason: match[2], length: Number(match[3]) })
    : null;
}
module.exports = { parseCoverageControlFailure };
