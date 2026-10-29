'use strict';

const CURRENT_CONTEXT_POLICY_VERSION = 2;
const preserveWindow = Symbol('contextPolicyPreserveWindow');
const enhancedPlanning = Symbol('contextPolicyEnhancedPlanning');
const plannerSelection = Symbol('contextPolicyPlannerSelection');
const selections = Object.freeze({
  legacy: Object.freeze({ version: 1, policy: 'legacy' }),
  'native-first': Object.freeze({ version: 2, policy: 'native-first' }),
  enhanced: Object.freeze({ version: 2, policy: 'enhanced' }),
});

function invalid() {
  return Object.assign(new TypeError('invalid_context_policy'), { code: 'invalid_context_policy' });
}
function plain(value) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  return value;
}
function valueOf(object, name) {
  const slot = Object.getOwnPropertyDescriptor(object, name);
  if (!slot) return undefined;
  if (!slot.enumerable || !Object.hasOwn(slot, 'value')) throw invalid();
  return slot.value;
}

// Missing metadata means the old policy, never implied consent to a new one.
// This parser selects intent only; it grants no runtime or historical authority.
function parseContextPolicyVersion(input) {
  try {
    const supplied = valueOf(plain(input), 'contextPolicyVersion');
    const version = supplied === undefined ? 1 : supplied;
    if (version !== 1 && version !== CURRENT_CONTEXT_POLICY_VERSION) throw invalid();
    return version;
  } catch {
    throw invalid();
  }
}

function parseContextPolicySettings(input = {}) {
  try {
    const settings = plain(input);
    const version = parseContextPolicyVersion(settings);
    const enabled = valueOf(settings, 'contextRecoveryEnabled');
    const persistent = valueOf(settings, 'contextRecoveryPersistenceEnabled');
    if ([enabled, persistent].some((flag) => flag !== undefined && typeof flag !== 'boolean'))
      throw invalid();
    return Object.freeze({
      version,
      migrationRequired: version === 1,
      requestedPolicy: version === 1 ? 'legacy' : enabled === true ? 'enhanced' : 'native-first',
      requestedRecovery: enabled === true,
      persistencePreference: persistent === true,
    });
  } catch {
    throw invalid();
  }
}

function parseContextPolicy(config) {
  try {
    const settings = valueOf(plain(config), 'appSettings');
    return parseContextPolicySettings(settings);
  } catch {
    throw invalid();
  }
}

// Full-document saves from an older client must not erase newer policy intent.
// Downgrade/migration needs a separate verified operation, not field omission.
function assertContextPolicyTransition(previous, next) {
  try {
    const before = parseContextPolicyVersion(valueOf(plain(previous), 'appSettings') ?? {});
    const after = parseContextPolicyVersion(valueOf(plain(next), 'appSettings') ?? {});
    if (after < before) throw invalid();
  } catch {
    throw invalid();
  }
}

// Only composition creates this capability. JSON options cannot impersonate it;
// enumerable symbols survive the option spreads used by protocol adapters.
function composeContextProtocolOptions(defaults, config) {
  try {
    const document = plain(config);
    const version = parseContextPolicyVersion(valueOf(document, 'appSettings') ?? {});
    const result = {};
    for (const source of [defaults, valueOf(document, 'protocolOptions')]) {
      if (source == null) continue;
      for (const key of Object.keys(plain(source))) {
        if (key === 'contextPlanningPolicy') continue;
        Object.defineProperty(result, key, {
          value: valueOf(source, key),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    if (version === CURRENT_CONTEXT_POLICY_VERSION) {
      result[preserveWindow] = true;
      result[enhancedPlanning] =
        valueOf(plain(valueOf(document, 'appSettings')), 'contextRecoveryEnabled') === true;
    }
    // Observation only: adapters cannot acquire authority from this marker.
    // Keep it nonenumerable; the runtime controller copies all descriptors.
    Object.defineProperty(result, plannerSelection, {
      value: version === 1 ? 'legacy' : result[enhancedPlanning] ? 'enhanced' : 'native-first',
      configurable: true,
    });
    return result;
  } catch {
    throw invalid();
  }
}

function preservesContextWindow(options) {
  return Object.getOwnPropertyDescriptor(options, preserveWindow)?.value === true;
}

function usesNativeContextPlanning(options) {
  return (
    preservesContextWindow(options) &&
    Object.getOwnPropertyDescriptor(options, enhancedPlanning)?.value !== true
  );
}

function inspectContextProtocolSelection(options) {
  try {
    const selected = Object.getOwnPropertyDescriptor(options, plannerSelection)?.value;
    if (typeof selected !== 'string' || !Object.hasOwn(selections, selected)) return null;
    const preserved = preservesContextWindow(options);
    const enhanced = Object.getOwnPropertyDescriptor(options, enhancedPlanning)?.value === true;
    if (
      (selected === 'legacy' && (preserved || enhanced)) ||
      (selected !== 'legacy' && (!preserved || enhanced !== (selected === 'enhanced')))
    )
      return null;
    return selections[selected];
  } catch {
    return null;
  }
}

module.exports = {
  CURRENT_CONTEXT_POLICY_VERSION,
  parseContextPolicyVersion,
  parseContextPolicySettings,
  parseContextPolicy,
  assertContextPolicyTransition,
  composeContextProtocolOptions,
  preservesContextWindow,
  usesNativeContextPlanning,
  inspectContextProtocolSelection,
};
