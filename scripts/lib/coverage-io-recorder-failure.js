'use strict';

const PHASES = new Set([
  'host',
  'paths',
  'trace-start',
  'original-tests',
  'capture-wait',
  'trace-stop',
  'trace-file',
  'trace-size',
  'decode-enumeration',
  'decode-limit',
  'decode-provider',
  'decode-thread-record',
  'decode-record',
  'decode-summary',
  'original-assertions',
]);
const CAUSES = new Set(['start', 'deadline', 'pipes', 'output-limit', 'exit']);

// Recorder stderr is never returned. Only complete, unique fixed control lines
// select these literals; paths, decoded events and exception text stay private.
// This explanation cannot authorize a receipt or change an original refusal.
function coverageIoRecorderFailureDetail(input) {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 16384 || !input.endsWith('\n'))
    return '';
  let phase, cause;
  let phases = 0,
    causes = 0;
  for (const line of input.split('\n').slice(0, -1)) {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    const phasePrefix = 'persistent_io_diagnostic_failed:phase=';
    const causePrefix = 'persistent_io_wpr_failed:cause=';
    if (text.startsWith(phasePrefix)) {
      phases++;
      const value = text.slice(phasePrefix.length);
      if (PHASES.has(value)) phase = value;
    }
    if (text.startsWith(causePrefix)) {
      causes++;
      const value = text.slice(causePrefix.length);
      if (CAUSES.has(value)) cause = value;
    }
  }
  if (phases !== 1 || phase === undefined || causes > 1 || (causes && cause === undefined))
    return '';
  return '; recorder_phase=' + phase + (cause === undefined ? '' : '; wpr_cause=' + cause);
}

module.exports = { coverageIoRecorderFailureDetail };
