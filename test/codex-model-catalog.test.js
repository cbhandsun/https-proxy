'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-codex-catalog-'));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
fs.mkdirSync(path.join(tempHome, '.codex'), { recursive: true });
fs.writeFileSync(
  path.join(tempHome, '.codex', 'models_cache.json'),
  JSON.stringify({
    models: [
      {
        slug: 'template-model',
        display_name: 'Template',
        visibility: 'list',
        supported_in_api: true,
        model_messages: { persistent_instructions: 'You are Codex.' },
      },
      {
        slug: 'unrouted-visible-model',
        display_name: 'Unrouted Visible',
        visibility: 'list',
        supported_in_api: true,
      },
      {
        slug: 'internal-hidden-model',
        display_name: 'Internal Hidden',
        visibility: 'hide',
        supported_in_api: true,
      },
      {
        slug: 'unsupported-model',
        display_name: 'Unsupported',
        visibility: 'list',
        supported_in_api: false,
      },
    ],
  }),
  'utf8'
);

const { buildCodexModelCatalog } = require('../lib/proxy/tool-configs');

try {
  const catalog = buildCodexModelCatalog([
    { from: 'routed-model', profileId: 'openai-official', to: 'template-model' },
  ]);
  assert.deepStrictEqual(
    catalog.models.map((model) => model.slug),
    ['routed-model', 'internal-hidden-model', 'unsupported-model']
  );
  assert.strictEqual(catalog.models[0].visibility, 'list');
  assert.strictEqual(catalog.models[0].supported_in_api, true);
  assert.ok(!catalog.models.some((model) => model.slug === 'unrouted-visible-model'));
} finally {
  fs.rmSync(tempHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
}

console.log('[codex-model-catalog.test] ok');
