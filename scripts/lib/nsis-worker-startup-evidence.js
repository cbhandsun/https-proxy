'use strict';
const { types } = require('node:util');
const { fail } = require('./nsis-encrypted-contract');
const PHASES = [
  'worker_started',
  'paths_started',
  'directory_acl_started',
  'directory_acl_finished',
  'paths_ready',
  'ownership_started',
  'ownership_acquired',
  'key_protect_started',
  'key_protect_finished',
  'key_write_started',
  'key_file_open_started',
  'key_file_opened',
  'key_acl_started',
  'key_acl_finished',
  'key_file_write_started',
  'key_file_write_finished',
  'key_file_flush_started',
  'key_file_flush_finished',
  'key_file_closed',
  'key_file_readback_started',
  'key_file_readback_finished',
  'key_write_finished',
  'key_unprotect_started',
  'key_unprotect_finished',
  'anchor_open_started',
  'anchor_opened',
  'database_prepare_started',
  'database_prepared',
  'database_opened',
  'engine_prepare_started',
  'engine_anchor_validate_started',
  'engine_anchor_validate_finished',
  'engine_prepared',
  'anchor_persist_started',
  'anchor_persist_finished',
  'engine_ready',
  'ready',
  'failed',
];

function createWorkerStartupEvidence() {
  const seen = new Set();
  let invalid = false;
  const observe = (input) => {
    if (!input || typeof input !== 'object' || types.isProxy(input)) {
      invalid = true;
      return;
    }
    const slot = Object.getOwnPropertyDescriptor(input, 'phase');
    if (
      !slot ||
      !Object.hasOwn(slot, 'value') ||
      !PHASES.includes(slot.value) ||
      seen.has(slot.value)
    ) {
      invalid = true;
      return;
    }
    seen.add(slot.value);
  };
  return {
    observe,
    receipt(refused) {
      const nativeKeyCompleted =
        seen.has('key_protect_finished') || seen.has('key_unprotect_finished');
      if (
        invalid ||
        typeof refused !== 'boolean' ||
        !seen.has('worker_started') ||
        !nativeKeyCompleted ||
        !seen.has('database_opened') ||
        seen.has('engine_ready') !== !refused ||
        seen.has('ready') !== !refused ||
        seen.has('failed') !== refused ||
        (refused && seen.has('anchor_persist_started'))
      )
        throw fail();
      return Object.freeze({
        workerStarted: true,
        nativeKeyCompleted: true,
        databaseOpened: true,
        engineReady: !refused,
        ready: !refused,
        refused,
        anchorOpened: seen.has('anchor_opened'),
        anchorPersisted: seen.has('anchor_persist_finished'),
      });
    },
  };
}

module.exports = { createWorkerStartupEvidence };
