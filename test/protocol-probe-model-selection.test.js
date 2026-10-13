'use strict';
const assert = require('node:assert/strict');
const { selectGeminiProbeModels } = require('../scripts/lib/protocol-probe-model-selection');
const { discoverTestFiles, selectUnitTestFiles } = require('../lib/test-discovery');
const path = require('node:path');

const specs = Object.freeze([
  Object.freeze({ label: 'gemini-key', model: 'gemini-2.5-flash', index: 0 }),
  Object.freeze({ label: 'gemini-official', model: 'gemini-3.8-flash-tiered', index: 4 }),
  Object.freeze({ label: 'responses-deepseek', model: 'deepseek-v4-flash', index: 2 }),
]);
const historical = selectGeminiProbeModels(specs);
assert.equal(historical[0].model, 'gemini-2.5-flash');
assert.equal(historical[0].modelSelection, 'historical-harness-choice');
const selected = selectGeminiProbeModels(specs, {
  apiKeyModel: 'gemini-3.8-flash',
  officialModel: 'gemini-3.8-flash-tiered',
});
assert.equal(selected[0].model, 'gemini-3.8-flash');
assert.equal(selected[1].model, 'gemini-3.8-flash-tiered');
assert.equal(selected[0].modelSelection, 'explicit-probe-option');
assert.equal(selected[1].modelSelection, 'explicit-probe-option');
assert.deepEqual(selected[2], specs[2]);
assert.notEqual(selected[2], specs[2]);
assert.equal(specs[0].model, 'gemini-2.5-flash');
assert.deepEqual(selectGeminiProbeModels([]), []);
assert.equal(selectGeminiProbeModels(specs, { apiKeyModel: undefined })[0].model, specs[0].model);
for (const invalid of [
  null,
  false,
  1,
  {},
  [],
  '',
  ' ',
  'gemini-3.8-flash\n',
  'gemini-3.8-flash?key=SECRET',
  'https://SECRET',
  '../SECRET',
  'models/gemini-3.8-flash',
  'gemini-' + 'a'.repeat(154),
  'gemini-3.8-flash-tiered',
  'gemini-3.8-flash-low',
]) {
  assert.throws(
    () => selectGeminiProbeModels(specs, { apiKeyModel: invalid }),
    (error) =>
      error instanceof TypeError && error.message === 'Invalid Gemini probe model selection'
  );
}
for (const options of [null, [], 'SECRET', { typo: 'SECRET' }, { officialModel: '' }])
  assert.throws(() => selectGeminiProbeModels(specs, options));
for (const input of [null, {}, 'SECRET', [null], [[]]])
  assert.throws(() => selectGeminiProbeModels(input));
assert.throws(() => selectGeminiProbeModels([], { apiKeyModel: 'SECRET' }));
assert.throws(() => selectGeminiProbeModels([{ label: 'gemini-key', model: '' }]));
assert.equal(selectGeminiProbeModels([{ label: '__proto__', model: 'safe' }])[0].model, 'safe');
assert.equal(
  selectGeminiProbeModels(specs, { apiKeyModel: 'gemini-' + 'a'.repeat(153) })[0].model.length,
  160
);
const discovered = selectUnitTestFiles(discoverTestFiles(path.resolve(__dirname, '..')));
assert.ok(discovered.includes('test/protocol-probe-model-selection.test.js'));
