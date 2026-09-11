'use strict';

const assert = require('assert');
const {
  createLazyFeatureHandlers,
  createLazyPromptsHandlers,
} = require('../lib/proxy/lazy-feature-handlers');

let loads = 0;
const prompts = createLazyPromptsHandlers({
  loadModule() {
    loads += 1;
    return {
      handleLocalPromptsSyncRequest: () => 'sync',
      handleLocalPromptsPresetsRequest: () => 'presets',
    };
  },
});
assert.strictEqual(loads, 0);
assert.strictEqual(prompts.handleLocalPromptsSyncRequest(), 'sync');
assert.strictEqual(prompts.handleLocalPromptsPresetsRequest(), 'presets');
assert.strictEqual(loads, 1);

const invalid = createLazyFeatureHandlers(
  ['handler'],
  './missing',
  'createHandlers',
  {},
  {
    loadModule: () => ({}),
  }
);
assert.throws(() => invalid.handler(), /must export createHandlers/);

console.log('[lazy-feature-handlers.test] ok');
