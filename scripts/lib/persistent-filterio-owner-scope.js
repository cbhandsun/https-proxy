'use strict';

const { parseStageLine } = require('../../test/helpers/recovery-owner-stage-probe');
const scopes = new WeakMap();
const fail = () => new Error('persistent_filterio_bridge_invalid');
const MAX_OWNERS = 64;
const MAX_STAGES = 100000;

// These identities are observations from the original test-only worker stage
// channel. They are not ProcessStart evidence or physical file identities.
function createPersistentFilterIoOwnerScope() {
  const owners = new Map();
  let failed = false,
    count = 0;
  const scope = Object.freeze({
    observeTestDiagnosticLine(line) {
      try {
        if (
          failed ||
          typeof line !== 'string' ||
          Buffer.byteLength(line) > 1024 ||
          !line.startsWith('# ')
        )
          throw fail();
        const value = JSON.parse(line.slice(2));
        if (
          JSON.stringify(value) !== line.slice(2) ||
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          value.phase !== 'owner-stage' ||
          !['chat', 'responses', 'claude'].includes(value.kind) ||
          value.mode !== 'long-persistent' ||
          !Number.isSafeInteger(value.ownerEpoch) ||
          value.ownerEpoch <= 0
        )
          throw fail();
        const { kind, mode, phase, ownerEpoch, ...stage } = value;
        void kind;
        void mode;
        void phase;
        void ownerEpoch;
        scope.observeStageLine(JSON.stringify(stage));
      } catch {
        failed = true;
        throw fail();
      }
    },
    observeStageLine(line) {
      try {
        if (failed || ++count > MAX_STAGES) throw fail();
        const row = parseStageLine(line);
        if (
          typeof row.fixtureTag !== 'string' ||
          row.fixtureTag.length !== 64 ||
          !/^[a-f0-9]{64}$/.test(row.fixtureTag) ||
          !Number.isSafeInteger(row.ownerProcessId)
        )
          throw fail();
        const key = row.ownerProcessId + ':' + row.fixtureTag;
        const prior = owners.get(key);
        if (!prior && owners.size >= MAX_OWNERS) throw fail();
        owners.set(key, Object.freeze({ pid: row.ownerProcessId, fixtureTag: row.fixtureTag }));
      } catch {
        failed = true;
        throw fail();
      }
    },
    snapshot() {
      if (failed) throw fail();
      return {
        ownersObserved: owners.size,
        stageRecords: count,
        processCreationVerified: false,
        physicalFileIdentityVerified: false,
      };
    },
  });
  scopes.set(scope, { owners, valid: () => !failed });
  return scope;
}

function resolvePersistentFilterIoOwner(scope, tag, pid) {
  const state = scopes.get(scope);
  if (!state || !state.valid()) throw fail();
  return state.owners.get(pid + ':' + tag) || null;
}

function persistentFilterIoOwnerIdentities(scope) {
  const state = scopes.get(scope);
  if (!state || !state.valid()) throw fail();
  return Object.freeze([...state.owners.values()].map((row) => Object.freeze({ ...row })));
}

module.exports = {
  createPersistentFilterIoOwnerScope,
  resolvePersistentFilterIoOwner,
  persistentFilterIoOwnerIdentities,
};
