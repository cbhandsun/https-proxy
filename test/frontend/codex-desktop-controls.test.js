'use strict';

const assert = require('node:assert/strict');

(async () => {
  const { codexDesktopModePayload, renderCodexDesktopModelOptions } =
    await import('../../tauri-ui/src/app/domains/codex-desktop-controls.js');

  const select = { value: 'custom-model', options: [] };
  renderCodexDesktopModelOptions({
    select,
    routes: [
      null,
      { from: ' custom-model ', labelOverride: ' Custom ' },
      { from: 'custom-model', displayName: 'Duplicate' },
      { from: '', displayName: 'Invalid' },
    ],
    clearElement: (element) => {
      element.options = [];
    },
    appendOption: (element, value, label) => element.options.push({ value, label }),
  });
  assert.equal(select.value, 'custom-model');
  assert.deepEqual(select.options[0], {
    value: 'custom-model',
    label: 'Custom (custom-model)',
  });
  assert.equal(select.options.filter((option) => option.value === 'custom-model').length, 1);
  assert.ok(select.options.some((option) => option.value === 'codex/gpt-5.6-sol'));

  const emptySelection = { value: '', options: [] };
  renderCodexDesktopModelOptions({
    select: emptySelection,
    routes: undefined,
    clearElement: (element) => {
      element.options = [];
    },
    appendOption: (element, value, label) => element.options.push({ value, label }),
  });
  assert.equal(emptySelection.value, 'codex/gpt-5.6-sol');
  assert.doesNotThrow(() =>
    renderCodexDesktopModelOptions({
      select: null,
      routes: [],
      clearElement: () => {},
      appendOption: () => {},
    })
  );

  const fields = {
    codexDesktopModel: { value: ' gpt-5.5 ' },
    codexDesktopReasoningEffort: { value: ' high ' },
  };
  assert.deepEqual(
    codexDesktopModePayload('proxy', 'api', (id) => fields[id]),
    {
      connection: 'proxy',
      auth: 'api',
      model: 'gpt-5.5',
      reasoningEffort: 'high',
    }
  );
  assert.deepEqual(codexDesktopModePayload('direct', 'chatgpt', null), {
    connection: 'direct',
    auth: 'chatgpt',
    model: undefined,
    reasoningEffort: undefined,
  });

  console.log('[codex-desktop-controls.test] ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
