'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createLazyConversionSupport } = require('../lib/proxy/lazy-conversion-support');
const responseNames = [
  'collectBoundedResponse',
  'createChatToResponsesBridge',
  'responsesToChatWithHistory',
  'resolveResponsesHistory',
  'rememberResponsesFromChatResponse',
  'rememberResponsesFromBridge',
  'rememberResponsesHistory',
  'saveResponsesHistoryToDisk',
];
const validatorNames = [
  'rejectInvalidFunctionTools',
  'rejectUnsupportedResponsesTools',
  'rejectUnsupportedResponsesInput',
  'rejectUnsupportedResponsesStructuredOutput',
  'rejectUnsupportedResponsesReasoning',
  'rejectUnsupportedResponsesConversion',
  'rejectUnsupportedResponsesNonOpenAIConversion',
  'rejectInvalidGeminiReasoning',
  'rejectUnsupportedOpenAIChatNonOpenAIConversion',
];
const methods = (names) =>
  Object.fromEntries(
    names.map((name) => [
      name,
      function (...args) {
        return { receiver: this, args };
      },
    ])
  );
const responseOwner = () => ({ ...methods(responseNames), responsesHistory: new Map() });
function safe(error) {
  assert.equal(error.message, 'Protocol conversion support unavailable');
  assert.equal(error.code, 'conversion_support_unavailable');
  assert.equal(error.statusCode, 503);
  assert.equal(error.cause, undefined);
  return true;
}

test('conversion support composition stays cold, preserves owner identity and exact return contracts', async () => {
  const load = Module._load;
  const counts = { response: 0, validator: 0 };
  const states = [];
  const responseOptions = { marker: 'synthetic-state' };
  const validatorOptions = { marker: 'synthetic-validator' };
  const validators = methods(validatorNames);
  const exact = Promise.resolve({ owned: true });
  const thrown = { fixture: 'exact exception identity' };
  try {
    Module._load = function (request) {
      if (request === './handlers/responses-state')
        return {
          createResponsesState(options) {
            assert.equal(options, responseOptions);
            counts.response++;
            const state = responseOwner();
            state.responsesToChatWithHistory = () => exact;
            state.createChatToResponsesBridge = () => {
              throw thrown;
            };
            states.push(state);
            return state;
          },
        };
      if (request === './handlers/request-validators')
        return {
          createRequestValidators(options) {
            assert.equal(options, validatorOptions);
            counts.validator++;
            return validators;
          },
        };
      return Reflect.apply(load, this, arguments);
    };
    const support = createLazyConversionSupport(responseOptions, validatorOptions);
    const first = { ...support.responses, ...support.validators };
    assert.deepEqual(counts, { response: 0, validator: 0 });
    assert.equal(support.responsesHistory, states[0].responsesHistory);
    assert.equal(support.responsesHistory, support.responsesHistory);
    support.responsesHistory.set('owned', ['synthetic']);
    const args = [null, undefined, '🙂', { extreme: 'x'.repeat(65536) }];
    const reply = first.collectBoundedResponse(...args);
    assert.equal(reply.receiver, states[0]);
    assert.deepEqual(reply.args, args);
    assert.equal(first.responsesToChatWithHistory(), exact);
    assert.deepEqual(await exact, { owned: true });
    assert.throws(
      () => first.createChatToResponsesBridge(),
      (error) => error === thrown
    );
    for (const name of validatorNames) assert.equal(first[name]().receiver, validators);
    const second = createLazyConversionSupport(responseOptions, validatorOptions);
    assert.notEqual(second.responsesHistory, support.responsesHistory);
    assert.equal(second.responsesHistory.has('owned'), false);
    assert.deepEqual(counts, { response: 2, validator: 1 });
  } finally {
    Module._load = load;
  }
});

test('support catalogs match the real validator and state factories', () => {
  const { createResponsesState } = require('../lib/proxy/handlers/responses-state');
  const { createRequestValidators } = require('../lib/proxy/handlers/request-validators');
  const support = createLazyConversionSupport({}, {});
  const state = createResponsesState({});
  assert.deepEqual(
    Object.keys(support.validators).sort(),
    Object.keys(createRequestValidators({})).sort()
  );
  assert.deepEqual(Object.keys(support.responses).sort(), responseNames.slice().sort());
  for (const name of responseNames) assert.equal(typeof state[name], 'function');
});

test('support first-load and malformed factory failures are sanitized and terminal without executing accessors', () => {
  const load = Module._load;
  let getters = 0;
  const moduleGetter = Object.defineProperty({}, 'createResponsesState', {
    get() {
      getters++;
      throw Error('PRIVATE_FACTORY_TOKEN');
    },
  });
  const stateGetter = Object.defineProperty(responseOwner(), 'collectBoundedResponse', {
    get() {
      getters++;
      return undefined;
    },
  });
  const historyGetter = Object.defineProperty(responseOwner(), 'responsesHistory', {
    get() {
      getters++;
      return undefined;
    },
  });
  for (const module of [
    undefined,
    null,
    [],
    {},
    { createResponsesState: null },
    moduleGetter,
    {
      createResponsesState: () => {
        throw Error('PRIVATE_FACTORY_TOKEN');
      },
    },
    ...[undefined, null, false, [], {}, stateGetter, historyGetter].map((state) => ({
      createResponsesState: () => state,
    })),
  ]) {
    let attempts = 0;
    try {
      Module._load = function (request) {
        if (request === './handlers/responses-state') {
          attempts++;
          return module;
        }
        return Reflect.apply(load, this, arguments);
      };
      const support = createLazyConversionSupport({}, {});
      assert.equal(attempts, 0);
      assert.throws(() => support.responses.collectBoundedResponse(), safe);
      assert.throws(() => support.responsesHistory, safe);
      assert.throws(() => support.responses.saveResponsesHistoryToDisk(), safe);
      assert.equal(attempts, 1);
    } finally {
      Module._load = load;
    }
  }
  for (const kind of ['responses-state', 'request-validators']) {
    let attempts = 0;
    try {
      Module._load = function (request) {
        if (request === './handlers/' + kind) {
          attempts++;
          throw Error('PRIVATE_LOAD_TOKEN');
        }
        return Reflect.apply(load, this, arguments);
      };
      const support = createLazyConversionSupport({}, {});
      const call =
        kind === 'responses-state'
          ? () => support.responsesHistory
          : () => support.validators.rejectInvalidFunctionTools();
      assert.throws(call, safe);
      assert.throws(call, safe);
      assert.equal(attempts, 1);
    } finally {
      Module._load = load;
    }
  }
  assert.equal(getters, 0);
});

test('recursive initialization remains failed even if the loader catches the recursive rejection', () => {
  const load = Module._load;
  let attempts = 0;
  const support = createLazyConversionSupport({}, {});
  try {
    Module._load = function (request) {
      if (request === './handlers/responses-state') {
        attempts++;
        assert.throws(() => support.responsesHistory, safe);
        return { createResponsesState: responseOwner };
      }
      return Reflect.apply(load, this, arguments);
    };
    assert.throws(() => support.responsesHistory, safe);
    assert.throws(() => support.responses.collectBoundedResponse(), safe);
    assert.equal(attempts, 1);
  } finally {
    Module._load = load;
  }
});
