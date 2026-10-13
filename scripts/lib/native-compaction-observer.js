'use strict';

const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const checkpointType = (value) => value === 'compaction' || value === 'compaction_summary';

// Native Codex V2 consumes output_item.done, followed by response.completed.
// The terminal response's output array is not a substitute for those item events.
// Keep opaque data in memory; public diagnostics contain only counts and codes.
function createNativeCompactionObserver({ maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024)
    throw new TypeError('Invalid native compaction observation limit');
  let checkpoint = null;
  let doneCount = 0;
  let completedCount = 0;
  let failureCode = null;
  let ended = false;

  function reject(code) {
    failureCode ??= code;
    checkpoint = null;
  }
  function validateCheckpoint(item) {
    if (
      !record(item) ||
      !checkpointType(item.type) ||
      typeof item.encrypted_content !== 'string' ||
      !item.encrypted_content.trim() ||
      /^(?:hpm-local-compaction-|ccswitch-)/.test(item.encrypted_content)
    )
      throw new TypeError('Invalid native checkpoint');
  }
  function observe(value) {
    if (ended) return reject('event_after_end');
    let event;
    try {
      event = normalizeCompactionData(value, maxBytes);
    } catch {
      reject('invalid_event');
      return;
    }
    if (!record(event) || typeof event.type !== 'string') return reject('invalid_event');
    if (['response.failed', 'response.incomplete', 'error'].includes(event.type))
      return reject('failed_terminal');
    if (event.type === 'response.output_item.done' && checkpointType(event.item?.type)) {
      doneCount++;
      if (completedCount || doneCount !== 1) return reject('ambiguous_checkpoint');
      try {
        validateCheckpoint(event.item);
      } catch {
        reject('invalid_checkpoint');
        return;
      }
      if (!failureCode) checkpoint = event.item;
    }
    if (event.type === 'response.completed') {
      completedCount++;
      if (
        completedCount !== 1 ||
        !record(event.response) ||
        (event.response.status != null && event.response.status !== 'completed') ||
        event.response.error != null
      )
        return reject('invalid_terminal');
      // Some backends omit aggregate output while still emitting all item events.
      if (event.response.output != null) {
        if (!Array.isArray(event.response.output)) return reject('invalid_terminal');
        const aggregate = event.response.output.filter((item) => checkpointType(item?.type));
        if (aggregate.length > 1) return reject('ambiguous_checkpoint');
        if (aggregate.length === 1) {
          try {
            validateCheckpoint(aggregate[0]);
          } catch {
            reject('invalid_checkpoint');
            return;
          }
          if (!checkpoint || aggregate[0].encrypted_content !== checkpoint.encrypted_content)
            return reject('checkpoint_mismatch');
        }
      }
    }
  }
  function finish() {
    ended = true;
    if (!failureCode && (doneCount !== 1 || completedCount !== 1 || !checkpoint))
      reject('incomplete_stream');
    return { valid: !failureCode, doneCount, completedCount, failureCode };
  }
  function getCheckpoint() {
    if (!ended || failureCode || !checkpoint) return null;
    return normalizeCompactionData(checkpoint, maxBytes);
  }
  return { observe, finish, getCheckpoint };
}

module.exports = { createNativeCompactionObserver };
