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

// Exercise management-body transport without touching the user's config/auth.
const { EventEmitter } = require('node:events');
const { validateCodexToolDiscoveryOptions } = require('../lib/proxy/codex-tool-discovery-config');
const toolConfigs = require('../lib/proxy/tool-configs');
const configModule = require('../lib/proxy/config');
const originalApply = toolConfigs.applyCodexProxy;
const originalLoad = configModule.loadConfig;
let writes = 0;
toolConfigs.applyCodexProxy = (options) => {
  const enabled = validateCodexToolDiscoveryOptions(options);
  writes++;
  return { toolDiscoveryEnabled: enabled === true };
};
configModule.loadConfig = () => ({ modelRoutes: [] });
delete require.cache[require.resolve('../lib/proxy/tool-config-handlers')];
try {
  const handlers = require('../lib/proxy/tool-config-handlers').createToolConfigHandlers();
  for (const name of ['handleLocalCodexApplyRequest', 'handleLocalCodexDesktopApplyRequest']) {
    for (const body of [{ toolDiscovery: true }, { toolDiscovery: false }, {}]) {
      const request = new EventEmitter();
      let status, payload;
      handlers[name](request, {
        writeHead(value) {
          status = value;
        },
        end(value) {
          payload = JSON.parse(value);
        },
      });
      request.emit('data', Buffer.from(JSON.stringify(body)));
      request.emit('end');
      assert.strictEqual(status, 200);
      assert.strictEqual(payload.toolDiscoveryEnabled, body.toolDiscovery === true);
    }
    for (const body of [null, false, 1, 'SECRET', [], { toolDiscovery: 'SECRET' }]) {
      const before = writes;
      const request = new EventEmitter();
      let status, payload;
      handlers[name](request, {
        writeHead(value) {
          status = value;
        },
        end(value) {
          payload = JSON.parse(value);
        },
      });
      request.emit('data', Buffer.from(JSON.stringify(body)));
      request.emit('end');
      assert.strictEqual(status, 400);
      assert.strictEqual(writes, before);
      assert.ok(!JSON.stringify(payload).includes('SECRET'));
    }
  }
} finally {
  toolConfigs.applyCodexProxy = originalApply;
  configModule.loadConfig = originalLoad;
  delete require.cache[require.resolve('../lib/proxy/tool-config-handlers')];
}
console.log('[tool-config-handlers.test] body opt-in/validation passed');
