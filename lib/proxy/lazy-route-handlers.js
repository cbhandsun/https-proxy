'use strict';
const ROUTE_HANDLER_NAMES = Object.freeze([
  'handleClaudeMessagesToOpenAIChat',
  'handleClaudeMessagesToOpenAIResponses',
  'handleOpenAIChatToClaudeMessages',
  'handleOpenAIChatToOpenAIResponses',
  'handleOpenAIResponsesToOpenAIChat',
  'handleOpenAIResponsesToClaudeMessages',
  'handleOpenAIResponsesToGeminiMessages',
  'handleGeminiResponsesInputTokens',
  'handleOpenAIChatToGeminiMessages',
  'handleOpenAIImageJobControl',
  'handleOpenAIImageJobCreate',
  'handleOpenAIImagesToGemini',
  'handleOpenAIImagesToOpenAIOfficialResponses',
  'handleGeminiMessages',
]);
function createLazyRouteHandlers(
  deps,
  { loadModule = () => require('./handlers/route-handlers') } = {}
) {
  if (typeof loadModule !== 'function') throw new TypeError('Invalid route module loader');
  let handlers,
    initializing = false;
  function resolve() {
    if (handlers) return handlers;
    if (initializing) throw new Error('Route handler initialization is recursive');
    initializing = true;
    try {
      const module = loadModule();
      if (!module || typeof module.createRouteHandlers !== 'function')
        throw new TypeError('Route module must export createRouteHandlers');
      const created = module.createRouteHandlers(deps);
      if (
        !created ||
        typeof created !== 'object' ||
        Array.isArray(created) ||
        ROUTE_HANDLER_NAMES.some((name) => typeof created[name] !== 'function')
      )
        throw new TypeError('Route factory must return all handlers');
      handlers = created;
      return handlers;
    } finally {
      initializing = false;
    }
  }
  const result = Object.fromEntries(
    ROUTE_HANDLER_NAMES.map((name) => [
      name,
      function (...args) {
        const current = resolve();
        return Reflect.apply(current[name], current, args);
      },
    ])
  );
  Object.defineProperty(result, '_imageJobStore', {
    enumerable: true,
    get: () => resolve()._imageJobStore,
  });
  return result;
}
module.exports = { createLazyRouteHandlers, ROUTE_HANDLER_NAMES };
