'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const {
  CURRENT_CONTEXT_POLICY_VERSION,
  parseContextPolicySettings,
} = require('./context-recovery-policy');

function invalidMigration() {
  return new TypeError('invalid_context_policy_migration');
}

function parsePolicyMigrationRequest(input) {
  try {
    const value = normalizeCompactionData(input, 256);
    if (
      !value ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'confirm,revision,targetVersion' ||
      value.confirm !== true ||
      value.targetVersion !== CURRENT_CONTEXT_POLICY_VERSION ||
      typeof value.revision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.revision)
    )
      throw invalidMigration();
    return Object.freeze({ revision: value.revision });
  } catch {
    throw invalidMigration();
  }
}

// Only the policy marker changes. No defaults, secret decryption, storage
// renewal, historical read or client-file migration belongs to this operation.
function preparePolicyMigration(input) {
  try {
    const config = normalizeCompactionData(input, 4 * 1024 * 1024);
    if (!config || Array.isArray(config)) throw invalidMigration();
    const settings = config.appSettings ?? Object.create(null);
    const before = parseContextPolicySettings(settings);
    const nextSettings = { ...settings, contextPolicyVersion: CURRENT_CONTEXT_POLICY_VERSION };
    const after = parseContextPolicySettings(nextSettings);
    config.appSettings = nextSettings;
    return {
      config,
      preview: Object.freeze({
        fromVersion: before.version,
        targetVersion: CURRENT_CONTEXT_POLICY_VERSION,
        migrationRequired: before.migrationRequired,
        requestedPolicy: after.requestedPolicy,
        requestedRecovery: after.requestedRecovery,
        persistencePreference: after.persistencePreference,
        // Static warnings, never an inventory or a claim that old chat is safe.
        impacts: Object.freeze(
          after.requestedRecovery
            ? ['existing_recovery_preferences_retained']
            : ['automatic_trimming_disabled', 'evidence_dependent_history_requires_recovery']
        ),
      }),
    };
  } catch {
    throw invalidMigration();
  }
}

module.exports = { parsePolicyMigrationRequest, preparePolicyMigration };
