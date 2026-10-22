'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseContextPolicy,
  parseContextPolicySettings,
  assertContextPolicyTransition,
  composeContextProtocolOptions,
  preservesContextWindow,
  usesNativeContextPlanning,
  inspectContextProtocolSelection,
} = require('../lib/proxy/context-recovery-policy');
const { validateAppSettings } = require('../lib/proxy/validator');
const { createContextRecoveryDiagnostics } = require('../lib/proxy/context-recovery-diagnostics');

test('composition binds both version 2 modes while preserving legacy nullable preferences', () => {
  const defaults = Object.freeze({
    maxContextTokens: 100,
    contextPlanningPolicy: 'preserve-window',
  });
  for (const version of [undefined, 1, 2]) {
    for (const enabled of [undefined, null, false, true]) {
      const config = Object.freeze({
        appSettings: Object.freeze({
          contextPolicyVersion: version,
          contextRecoveryEnabled: enabled,
        }),
        protocolOptions: Object.freeze({ maxContextTokens: 200, contextPlanningPolicy: 'legacy' }),
      });
      const snapshot = JSON.stringify(config);
      const result = composeContextProtocolOptions(defaults, config);
      assert.equal(result.maxContextTokens, 200);
      assert.equal(Object.hasOwn(result, 'contextPlanningPolicy'), false);
      assert.equal(preservesContextWindow(result), version === 2);
      assert.equal(usesNativeContextPlanning(result), version === 2 && enabled !== true);
      assert.equal(usesNativeContextPlanning({ ...result }), version === 2 && enabled !== true);
      assert.equal(preservesContextWindow({ ...result }), version === 2);
      // Serialization never confers a trusted planning capability.
      assert.equal(preservesContextWindow(JSON.parse(JSON.stringify(result))), false);
      assert.equal(JSON.stringify(config), snapshot);
      if (version !== 2) assert.deepEqual(result, { maxContextTokens: 200 });
    }
  }
  assert.deepEqual(composeContextProtocolOptions(undefined, {}), {});
  assert.deepEqual(
    composeContextProtocolOptions(null, { appSettings: null, protocolOptions: null }),
    {}
  );
  const injected = composeContextProtocolOptions({}, { appSettings: { contextPolicyVersion: 2 } });
  assert.equal(preservesContextWindow(composeContextProtocolOptions(injected, {})), false);
  const prototypeKey = composeContextProtocolOptions(
    {},
    {
      protocolOptions: JSON.parse('{"__proto__":{"polluted":true}}'),
    }
  );
  assert.equal(Object.getPrototypeOf(prototypeKey), Object.prototype);
  assert.equal(Object.hasOwn(prototypeKey, '__proto__'), true);
  assert.equal(prototypeKey.polluted, undefined);
});

test('only composed, internally consistent options report a runtime selection without granting authority', () => {
  for (const [settings, policy, version] of [
    [{}, 'legacy', 1],
    [{ contextPolicyVersion: 2 }, 'native-first', 2],
    [{ contextPolicyVersion: 2, contextRecoveryEnabled: true }, 'enhanced', 2],
  ]) {
    const options = composeContextProtocolOptions({}, { appSettings: settings });
    assert.deepEqual(inspectContextProtocolSelection(options), { version, policy });
    assert.equal(Object.isFrozen(inspectContextProtocolSelection(options)), true);
    const descriptors = Object.getOwnPropertyDescriptors(options);
    assert.deepEqual(inspectContextProtocolSelection(Object.defineProperties({}, descriptors)), {
      version,
      policy,
    });
    assert.equal(inspectContextProtocolSelection({ ...options }), null);
    assert.equal(inspectContextProtocolSelection(JSON.parse(JSON.stringify(options))), null);
    const marker = Object.getOwnPropertySymbols(options).find(
      (key) => !descriptors[key].enumerable
    );
    Object.defineProperty(options, marker, {
      value: {
        toString() {
          throw Error('PRIVATE');
        },
      },
    });
    assert.equal(inspectContextProtocolSelection(options), null);
  }
  for (const input of [
    null,
    undefined,
    [],
    {},
    { contextPlanningPolicy: 'native-first' },
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw Error('PRIVATE');
        },
      }
    ),
  ])
    assert.equal(inspectContextProtocolSelection(input), null);
  for (const enabled of [false, true]) {
    const options = composeContextProtocolOptions(
      {},
      { appSettings: { contextPolicyVersion: 2, contextRecoveryEnabled: enabled } }
    );
    const capability = Object.getOwnPropertySymbols(options).find(
      (key) => Object.getOwnPropertyDescriptor(options, key).enumerable
    );
    delete options[capability];
    assert.equal(inspectContextProtocolSelection(options), null);
  }
});

test('option composition rejects malformed input without evaluating configuration accessors', () => {
  let executed = 0;
  const accessor = {
    get option() {
      executed++;
      return 'PRIVATE_VALUE';
    },
  };
  for (const config of [
    null,
    [],
    { appSettings: { contextPolicyVersion: 3 } },
    { protocolOptions: [] },
    { protocolOptions: accessor },
    {
      get protocolOptions() {
        executed++;
        return {};
      },
    },
    {
      get appSettings() {
        executed++;
        return {};
      },
    },
    new Proxy(
      {},
      {
        ownKeys() {
          throw Error('PRIVATE_VALUE');
        },
        getOwnPropertyDescriptor() {
          throw Error('PRIVATE_VALUE');
        },
      }
    ),
  ]) {
    assert.throws(() => composeContextProtocolOptions({}, config), {
      code: 'invalid_context_policy',
      message: 'invalid_context_policy',
    });
  }
  assert.throws(() => composeContextProtocolOptions(accessor, {}), {
    code: 'invalid_context_policy',
  });
  assert.equal(executed, 0);
});

test('policy metadata preserves absent legacy intent and both preferences without mutating config', () => {
  for (const version of [undefined, 1, 2]) {
    for (const enabled of [false, true]) {
      for (const persistent of [false, true]) {
        const settings = {
          contextRecoveryEnabled: enabled,
          contextRecoveryPersistenceEnabled: persistent,
        };
        if (version !== undefined) settings.contextPolicyVersion = version;
        const before = JSON.stringify(settings);
        const policy = parseContextPolicy({ appSettings: settings });
        assert.equal(policy.version, version ?? 1);
        assert.equal(policy.migrationRequired, version !== 2);
        assert.equal(
          policy.requestedPolicy,
          version !== 2 ? 'legacy' : enabled ? 'enhanced' : 'native-first'
        );
        assert.equal(policy.requestedRecovery, enabled);
        assert.equal(policy.persistencePreference, persistent);
        assert.equal(Object.isFrozen(policy), true);
        assert.equal(JSON.stringify(settings), before);
        assert.equal(validateAppSettings(settings).valid, true);
      }
    }
  }
  assert.equal(parseContextPolicy({}).version, 1);
  assert.equal(parseContextPolicySettings().version, 1);
  assert.equal(parseContextPolicySettings(Object.create(null)).version, 1);
});

test('unknown policy versions and malformed flags fail safely without executing accessors', () => {
  let executed = 0;
  for (const version of [
    null,
    false,
    true,
    0,
    3,
    -1,
    2.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
    '2',
    {},
    [],
  ]) {
    const settings = { contextPolicyVersion: version };
    assert.throws(() => parseContextPolicySettings(settings), {
      code: 'invalid_context_policy',
      message: 'invalid_context_policy',
    });
    assert.equal(validateAppSettings(settings).valid, false);
  }
  for (const config of [
    null,
    [],
    'PRIVATE_VALUE',
    { appSettings: null },
    { appSettings: [] },
    { appSettings: { contextRecoveryEnabled: 'false' } },
    { appSettings: { contextRecoveryPersistenceEnabled: 1 } },
    {
      get appSettings() {
        executed++;
        return {};
      },
    },
    {
      appSettings: {
        get contextPolicyVersion() {
          executed++;
          return 2;
        },
      },
    },
    { appSettings: Object.defineProperty({}, 'contextPolicyVersion', { value: 2 }) },
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw Error('PRIVATE_VALUE');
        },
      }
    ),
  ]) {
    assert.throws(() => parseContextPolicy(config), {
      code: 'invalid_context_policy',
      message: 'invalid_context_policy',
    });
  }
  const settings = {
    get contextPolicyVersion() {
      executed++;
      return 2;
    },
  };
  assert.equal(validateAppSettings(settings).valid, false);
  assert.equal(executed, 0);
});

test('diagnostics report selected policy separately from unqualified planner application', () => {
  const diagnostics = createContextRecoveryDiagnostics();
  assert.deepEqual(diagnostics.inspect({}).policy, {
    version: 1,
    migrationRequired: true,
    requestedPolicy: 'legacy',
    plannerApplication: 'unverified',
    runtimeApplication: 'unverified',
    appliedVersion: null,
    appliedPolicy: null,
  });
  const status = diagnostics.inspect({ appSettings: { contextPolicyVersion: 2 } });
  assert.equal(status.policy.requestedPolicy, 'native-first');
  assert.equal(status.policy.plannerApplication, 'unverified');
  const invalid = diagnostics.inspect({ appSettings: { contextPolicyVersion: 'PRIVATE_VALUE' } });
  assert.equal(invalid.configValid, false);
  assert.equal(invalid.state, 'invalid_config');
  assert.equal(invalid.policy, null);
  assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE_VALUE/);
});

test('policy saves preserve version boundaries without changing either document', () => {
  for (const before of [undefined, 1, 2, 3]) {
    for (const after of [undefined, 1, 2, 3]) {
      const previous =
        before === undefined ? {} : { appSettings: { contextPolicyVersion: before } };
      const next = after === undefined ? {} : { appSettings: { contextPolicyVersion: after } };
      const snapshot = JSON.stringify([previous, next]);
      if (before === 3 || after === 3 || (before === 2 && after !== 2))
        assert.throws(() => assertContextPolicyTransition(previous, next), {
          code: 'invalid_context_policy',
        });
      else assertContextPolicyTransition(previous, next);
      assert.equal(JSON.stringify([previous, next]), snapshot);
    }
  }
  assertContextPolicyTransition({ appSettings: null }, {});
  for (const input of [
    null,
    [],
    {
      get appSettings() {
        throw Error('PRIVATE_VALUE');
      },
    },
  ])
    assert.throws(() => assertContextPolicyTransition(input, {}), {
      code: 'invalid_context_policy',
      message: 'invalid_context_policy',
    });
});
