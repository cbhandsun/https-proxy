'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const os = require('node:os');
const { planTianxiNativeSwitch } = require('../scripts/lib/tianxi-native-switch-config');
const { TIANXI_SDK_MODELS } = require('../lib/proxy/tianxi-sdk-models');
const options = {
  config:
    'model_provider = "custom"\nmodel = "original"\nmodel_auto_compact_token_limit = 200000\n\n[windows]\nsandbox = "elevated"\n\n[model_providers.custom]\nbase_url = "http://localhost:3085/v1"\n',
  catalog: {
    models: [
      {
        slug: 'source',
        tool_mode: 'code_mode_only',
        apply_patch_tool_type: 'freeform',
        description: 'metadata',
      },
    ],
  },
  directory: path.join(os.homedir(), '.codex', 'tianxi-native'),
  port: 3096,
  token: 'a'.repeat(64),
};
test('switch replaces only owned root defaults and adds a dedicated provider while preserving permissions and original routes', () => {
  const plan = planTianxiNativeSwitch(options);
  assert.match(plan.config, /^model_provider = "tianxi_native"/);
  assert.match(plan.config, /model = "tianxi\/qwen3.8-flash"/);
  assert.ok(plan.config.includes('[windows]\nsandbox = "elevated"'));
  assert.ok(
    plan.config.includes('[model_providers.custom]\nbase_url = "http://localhost:3085/v1"')
  );
  assert.match(plan.config, /model_auto_compact_token_limit = 24000/);
  assert.deepEqual(
    plan.catalog.models.map((m) => m.slug).sort(),
    TIANXI_SDK_MODELS.map((m) => m.alias).sort()
  );
  assert.equal(plan.catalog.models.length, 12);
  assert.ok(
    plan.catalog.models.every((m) => m.context_window === 32000 && m.tool_mode === 'code_mode_only')
  );
  assert.equal(plan.state.token, options.token);
  assert.throws(
    () => planTianxiNativeSwitch({ ...options, config: plan.config }),
    /already_configured/
  );
  assert.match(
    planTianxiNativeSwitch({ ...options, config: '[windows]\nsandbox="elevated"' }).config,
    /^model_provider/
  );
});
test('switch rejects missing metadata, malformed boundaries and ambiguous root keys', () => {
  for (const override of [
    { config: null },
    { config: 'x\0' },
    { config: 'x'.repeat(1048577) },
    { catalog: null },
    { catalog: { models: [] } },
    { directory: '.' },
    { directory: options.directory + '\n' },
    { directory: options.directory + '"' },
    { port: 0 },
    { port: 65536 },
    { port: 1.2 },
    { token: 'bad' },
    { config: 'model="a"\nmodel="b"' },
  ]) {
    assert.throws(() => planTianxiNativeSwitch({ ...options, ...override }));
  }
});
