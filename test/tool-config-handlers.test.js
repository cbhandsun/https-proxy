'use strict';

const assert = require('assert');
const { codexModelRoutesForConfig } = require('../lib/proxy/tool-config-handlers');

const config = {
  modelRoutes: [
    { from: 'claude-opus-5', profileId: 'openai-official', to: 'gpt-6-astra' },
    { from: 'gpt-6-astra', profileId: 'openai-official', to: 'gpt-6-astra' },
    { from: 'codex/gpt-6-sol', profileId: 'openai-official', to: 'gpt-6-sol' },
    {
      from: 'claude-explicit-responses',
      profileId: 'custom-openai',
      to: 'custom-model',
      clientProtocols: ['openai-responses'],
    },
    {
      from: 'gpt-explicit-claude',
      profileId: 'custom-claude',
      to: 'custom-model',
      clientProtocols: ['claude'],
    },
  ],
};

assert.deepStrictEqual(
  codexModelRoutesForConfig(config).map((route) => route.from),
  ['claude-explicit-responses', 'codex/gpt-6-sol', 'gpt-6-astra']
);

assert.deepStrictEqual(config.modelRoutes[0], {
  from: 'claude-opus-5',
  profileId: 'openai-official',
  to: 'gpt-6-astra',
});

console.log('[tool-config-handlers.test] ok');
