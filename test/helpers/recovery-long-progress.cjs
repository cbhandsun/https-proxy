'use strict';

const { performance } = require('node:perf_hooks');
const STAGES = new Set([
  'module_load_started',
  'module_load_finished',
  'database_open_started',
  'database_open_finished',
  'store_open_started',
  'store_open_finished',
  'seed_started',
  'seed_finished',
  'record_load_started',
  'record_load_finished',
  'uncertain_save_started',
  'uncertain_save_finished',
  'store_reopen_started',
  'store_reopen_finished',
  'reauthorize_started',
  'reauthorize_finished',
  'history_ready',
  'root_begin_started',
  'root_begin_finished',
  'root_complete_started',
  'root_complete_finished',
  'continuation_begin_started',
  'continuation_begin_finished',
  'list_started',
  'list_finished',
  'read_started',
  'read_finished',
  'complete_started',
  'complete_finished',
  'shutdown_started',
  'shutdown_finished',
  'store_close_started',
  'store_close_finished',
  'cleanup_started',
  'cleanup_finished',
]);
const invalid = () => new Error('invalid_long_recovery_progress');

function createLongRecoveryProgress(write, now = () => performance.now()) {
  if (typeof write !== 'function' || typeof now !== 'function') throw invalid();
  const started = now();
  if (!Number.isFinite(started)) throw invalid();
  return (stage) => {
    if (!STAGES.has(stage)) throw invalid();
    const elapsedMs = Math.round(now() - started);
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) throw invalid();
    write(`HPM_LONG_STAGE ${stage} ${elapsedMs}\n`);
  };
}

function parseLongRecoveryProgress(input) {
  if (typeof input !== 'string' || input.length > 8192) return [];
  return input.split(/\r?\n/).flatMap((line) => {
    const match = /^HPM_LONG_STAGE ([a-z_]+) ([0-9]{1,16})$/.exec(line);
    if (!match || !STAGES.has(match[1])) return [];
    const elapsedMs = Number(match[2]);
    return Number.isSafeInteger(elapsedMs) ? [{ stage: match[1], elapsedMs }] : [];
  });
}

module.exports = { createLongRecoveryProgress, parseLongRecoveryProgress };
