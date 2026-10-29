'use strict';

const { performance } = require('node:perf_hooks');
const { types } = require('node:util');
const fail = () => new Error('runtime_reopen_assertion_failed');
const PHASES = Object.freeze([
  'initial-create',
  'initial-ready',
  'seed-first-begin',
  'seed-first-complete',
  'seed-capture-begin',
  'seed-capture-complete',
  'seed-view-begin',
  'seed-list',
  'seed-read',
  'invalidate',
  'denied-read',
  'owner-shutdown',
  'direct-open',
  'direct-inspect',
  'direct-load',
  'direct-close',
  'reopen-create',
  'reopen-ready',
  'reopen-begin',
  'reopen-denied-read',
  'reopen-shutdown',
  'cleanup-owner',
  'cleanup-storage',
]);
function createRuntimeReopenProgress(input, now = () => performance.now()) {
  let onPhase;
  if (input !== undefined) {
    if (
      !input ||
      typeof input !== 'object' ||
      types.isProxy(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).length !== 1
    )
      throw fail();
    const slot = Object.getOwnPropertyDescriptor(input, 'onPhase');
    if (
      !slot?.enumerable ||
      !Object.hasOwn(slot, 'value') ||
      typeof slot.value !== 'function' ||
      types.isProxy(slot.value)
    )
      throw fail();
    onPhase = slot.value;
  }
  if (typeof now !== 'function' || types.isProxy(now)) throw fail();
  let origin,
    previous,
    sequence = 0,
    rejected = false;
  function emit(action, phase, event) {
    if (!onPhase || rejected) return;
    try {
      const time = now();
      if (!Number.isFinite(time) || (previous !== undefined && time < previous) || sequence >= 128)
        throw fail();
      origin ??= time;
      previous = time;
      const elapsedMs = time - origin;
      if (
        !Number.isFinite(elapsedMs) ||
        elapsedMs < 0 ||
        onPhase(
          Object.freeze({
            version: 1,
            action,
            phase,
            event,
            sequence: ++sequence,
            elapsedMs,
          })
        ) !== undefined
      )
        throw fail();
    } catch {
      rejected = true;
    }
  }
  return Object.freeze({
    async run(action, phase, operation) {
      if (
        !['revoke', 'clear'].includes(action) ||
        !PHASES.includes(phase) ||
        typeof operation !== 'function' ||
        types.isProxy(operation)
      )
        throw fail();
      emit(action, phase, 'start');
      // A failed observer must never prevent the real cleanup operation.
      // It remains sticky and cannot turn a subsequent operation into success.
      let result;
      try {
        result = await operation();
      } catch {
        emit(action, phase, 'failure');
        throw fail();
      }
      emit(action, phase, 'end');
      if (rejected) throw fail();
      return result;
    },
  });
}
module.exports = { createRuntimeReopenProgress, PHASES };
