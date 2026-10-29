'use strict';

const { RECOVERY_TTL_MS, RECOVERY_MAX_ROOTS } = require('./context-recovery-limits');
const {
  parseContextPolicy,
  inspectContextProtocolSelection,
} = require('./context-recovery-policy');

const KINDS = ['chat', 'responses', 'claude'];
const EVENTS = [
  'bound',
  'bindingUnavailable',
  'completed',
  'failed',
  'reportingFailed',
  'publicationCleanupFailed',
  'httpPreparationFailed',
  'httpRunFailed',
  'httpEncodingFailed',
  'httpPrepareFailed',
  'httpSendingFailed',
  'httpPublishingFailed',
  'httpFinishFailed',
];

function lifecycleProjection(inspect) {
  if (!inspect) return null;
  try {
    const value = inspect();
    const read = (name) => {
      const slot = Object.getOwnPropertyDescriptor(value, name);
      if (!slot || !Object.hasOwn(slot, 'value')) throw new TypeError();
      return slot.value;
    };
    const storage = read('storage');
    const appliedEnabled = read('appliedEnabled');
    const state = read('state');
    if (
      !['memory', 'persistent'].includes(storage) ||
      typeof appliedEnabled !== 'boolean' ||
      ![
        'failed',
        'closed',
        'closing',
        'initializing',
        'unavailable',
        'enabled',
        'disabled',
        'switching',
        'clearing',
      ].includes(state)
    )
      throw new TypeError();
    return { storage, appliedEnabled, state };
  } catch {
    return { storage: 'unavailable', appliedEnabled: false, state: 'failed' };
  }
}

// Read configuration data without evaluating accessors or returning its content.
function enabledSetting(config) {
  try {
    if (!config || typeof config !== 'object' || Array.isArray(config))
      return { valid: false, enabled: false };
    const settings = Object.getOwnPropertyDescriptor(config, 'appSettings');
    if (!settings) return { valid: true, enabled: false };
    if (!Object.hasOwn(settings, 'value')) return { valid: false, enabled: false };
    const value = settings.value;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return { valid: false, enabled: false };
    const flag = Object.getOwnPropertyDescriptor(value, 'contextRecoveryEnabled');
    const persistence = Object.getOwnPropertyDescriptor(value, 'contextRecoveryPersistenceEnabled');
    const validPersistence =
      !persistence ||
      (Object.hasOwn(persistence, 'value') && typeof persistence.value === 'boolean');
    if (!flag) return { valid: validPersistence, enabled: false };
    return {
      valid: validPersistence && Object.hasOwn(flag, 'value') && typeof flag.value === 'boolean',
      enabled: Object.hasOwn(flag, 'value') && flag.value === true,
    };
  } catch {
    return { valid: false, enabled: false };
  }
}

// Process-local aggregate diagnostics. Never retain route, owner, IDs, arguments,
// error objects, credentials, source references or user text. These counters do
// not establish per-client/provider acceptance or active request state.
function createContextRecoveryDiagnostics() {
  let appliedEnabled = null;
  let inspectLifecycle = null;
  let plannerOptions = null;
  const counters = Object.fromEntries(
    KINDS.map((kind) => [kind, Object.fromEntries(EVENTS.map((event) => [event, 0]))])
  );
  return {
    attachPlannerOptions(value) {
      try {
        if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
          return false;
        plannerOptions = value;
        return true;
      } catch {
        return false;
      }
    },
    attachLifecycle(value) {
      try {
        const slot = Object.getOwnPropertyDescriptor(value, 'inspect');
        if (typeof slot?.value !== 'function') return false;
        inspectLifecycle = slot.value.bind(value);
        return true;
      } catch {
        return false;
      }
    },
    configure(value) {
      if (typeof value !== 'boolean') return false;
      appliedEnabled = value;
      return true;
    },
    record(kind, event) {
      if (
        !KINDS.includes(kind) ||
        !EVENTS.includes(event) ||
        (appliedEnabled === null &&
          !['reportingFailed', 'publicationCleanupFailed'].includes(event)) ||
        (appliedEnabled !== true && ['bound', 'bindingUnavailable'].includes(event))
      )
        return false;
      counters[kind][event] = Math.min(Number.MAX_SAFE_INTEGER, counters[kind][event] + 1);
      return true;
    },
    inspect(config) {
      const setting = enabledSetting(config);
      let policy = null;
      try {
        const selected = parseContextPolicy(config);
        const applied = plannerOptions ? inspectContextProtocolSelection(plannerOptions) : null;
        policy = {
          version: selected.version,
          migrationRequired: selected.migrationRequired,
          requestedPolicy: selected.requestedPolicy,
          plannerApplication: 'unverified',
          runtimeApplication: !plannerOptions
            ? 'unverified'
            : !applied
              ? 'unavailable'
              : applied.version === selected.version && applied.policy === selected.requestedPolicy
                ? 'matched'
                : 'mismatch',
          appliedVersion: applied?.version ?? null,
          appliedPolicy: applied?.policy ?? null,
        };
      } catch {
        setting.valid = false;
      }
      const lifecycle = lifecycleProjection(inspectLifecycle);
      const enabled = lifecycle ? lifecycle.appliedEnabled : appliedEnabled;
      return {
        schemaVersion: 1,
        configValid: setting.valid,
        policy,
        requestedEnabled: setting.enabled,
        appliedEnabled: enabled,
        state: !setting.valid
          ? 'invalid_config'
          : lifecycle?.state === 'failed' || lifecycle?.state === 'unavailable'
            ? 'unavailable'
            : ['switching', 'clearing', 'initializing'].includes(lifecycle?.state) ||
                enabled === null ||
                enabled !== setting.enabled
              ? 'pending_application'
              : setting.enabled
                ? 'enabled_restricted'
                : 'disabled',
        storage: lifecycle?.storage || 'memory',
        restartRetention: false,
        retention: {
          policyVersion: 2,
          absoluteTtlMs: RECOVERY_TTL_MS,
          maxActiveRoots: RECOVERY_MAX_ROOTS,
        },
        http: 'qualified_paths_only',
        webSocket: 'restricted_unverified',
        plugin: 'not_verified',
        clientAcceptance: 'not_verified',
        counterWindow: 'process_lifetime',
        counters: Object.fromEntries(KINDS.map((kind) => [kind, { ...counters[kind] }])),
      };
    },
  };
}

const contextRecoveryDiagnostics = createContextRecoveryDiagnostics();
module.exports = { createContextRecoveryDiagnostics, contextRecoveryDiagnostics };
