'use strict';

const assert = require('node:assert/strict');

(async () => {
  const { codexDesktopConnectionDetails } =
    await import('../../tauri-ui/src/app/models/tool-status-presentation.js');

  const elements = {
    codexDesktopModel: { value: '' },
    codexDesktopReasoningEffort: { value: '' },
  };
  const getElement = (id) => elements[id] || null;

  assert.deepEqual(
    codexDesktopConnectionDetails(
      {
        model: 'gpt-5.4',
        modelReasoningEffort: 'high',
        legacyBaseUrl: true,
        openaiBaseUrl: '',
        isCustomModern: false,
      },
      getElement
    ),
    {
      legacy: '；当前为旧 base_url 写法',
      modelInfo: '；默认模型: gpt-5.4 (high)',
    }
  );
  assert.equal(elements.codexDesktopModel.value, 'gpt-5.4');
  assert.equal(elements.codexDesktopReasoningEffort.value, 'high');

  assert.deepEqual(
    codexDesktopConnectionDetails(
      { legacyBaseUrl: true, openaiBaseUrl: 'https://proxy.test', isCustomModern: true },
      () => null
    ),
    { legacy: '', modelInfo: '' }
  );

  console.log('[tool-status-presentation.test] ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
