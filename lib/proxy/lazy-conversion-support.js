'use strict';

const { createLazyHandlerGroup } = require('./lazy-handler-group');

const RESPONSE_METHODS = Object.freeze([
  'collectBoundedResponse',
  'createChatToResponsesBridge',
  'responsesToChatWithHistory',
  'resolveResponsesHistory',
  'rememberResponsesFromChatResponse',
  'rememberResponsesFromBridge',
  'rememberResponsesHistory',
  'saveResponsesHistoryToDisk',
]);
const VALIDATOR_METHODS = Object.freeze([
  'rejectInvalidFunctionTools',
  'rejectUnsupportedResponsesTools',
  'rejectUnsupportedResponsesInput',
  'rejectUnsupportedResponsesStructuredOutput',
  'rejectUnsupportedResponsesReasoning',
  'rejectUnsupportedResponsesConversion',
  'rejectUnsupportedResponsesNonOpenAIConversion',
  'rejectInvalidGeminiReasoning',
  'rejectUnsupportedOpenAIChatNonOpenAIConversion',
]);
const unavailable = () =>
  Object.assign(new Error('Protocol conversion support unavailable'), {
    code: 'conversion_support_unavailable',
    statusCode: 503,
  });

function lazyOwner(load, factory, options, names, withHistory = false) {
  let owner;
  let initializing = false;
  let failed = false;
  function resolve() {
    if (failed || initializing) {
      failed = true;
      throw unavailable();
    }
    if (owner) return owner;
    initializing = true;
    try {
      const module = load();
      if (!module || typeof module !== 'object' || Array.isArray(module)) throw unavailable();
      const create = module && Object.getOwnPropertyDescriptor(module, factory)?.value;
      if (typeof create !== 'function') throw unavailable();
      const created = create(options);
      if (!created || typeof created !== 'object' || Array.isArray(created)) throw unavailable();
      for (const name of names)
        if (typeof Object.getOwnPropertyDescriptor(created, name)?.value !== 'function')
          throw unavailable();
      if (
        failed ||
        (withHistory &&
          !(Object.getOwnPropertyDescriptor(created, 'responsesHistory')?.value instanceof Map))
      )
        throw unavailable();
      owner = created;
      return owner;
    } catch {
      failed = true;
      throw unavailable();
    } finally {
      initializing = false;
    }
  }
  return { handlers: createLazyHandlerGroup(names, resolve), resolve };
}

// Only conversion or explicit history inspection needs these owners. Native
// passthrough composition has no conversion state to initialize or restore.
function createLazyConversionSupport(responseOptions, validatorOptions) {
  const responses = lazyOwner(
    () => require('./handlers/responses-state'),
    'createResponsesState',
    responseOptions,
    RESPONSE_METHODS,
    true
  );
  const validators = lazyOwner(
    () => require('./handlers/request-validators'),
    'createRequestValidators',
    validatorOptions,
    VALIDATOR_METHODS
  );
  return {
    responses: responses.handlers,
    validators: validators.handlers,
    get responsesHistory() {
      return responses.resolve().responsesHistory;
    },
  };
}

module.exports = { createLazyConversionSupport };
