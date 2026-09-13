'use strict';

const assert = require('node:assert/strict');

(async () => {
  const {
    applyClaudeDesktopBadges,
    codexDesktopConnectionDetails,
    formatClaudeDesktopStatus,
    populatePromptPresetsDropdown,
    renderClientActivity,
  } = await import('../../tauri-ui/src/app/models/tool-status-presentation.js');

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

  // Test formatClaudeDesktopStatus
  const unsupportedText = formatClaudeDesktopStatus({
    supported: false,
    error: 'Platform not supported',
  });
  assert.match(unsupportedText, /当前平台不可写入 Claude Desktop 配置/);

  const supportedText = formatClaudeDesktopStatus({
    supported: true,
    configured: true,
    mode: 'proxy',
    actualBaseUrl: 'https://localhost:3443',
    expectedBaseUrl: 'https://localhost:3443',
    mcpServersManagedCount: 2,
    mcpServersCount: 3,
  });
  assert.match(supportedText, /已写入 3P profile/);
  assert.match(supportedText, /网关托管 MCP: 2 个/);

  // Test applyClaudeDesktopBadges
  const badgeMock = { textContent: '', className: '' };
  const dotMock = { className: '' };
  applyClaudeDesktopBadges(
    { supported: true, configured: true, mode: 'proxy' },
    badgeMock,
    dotMock
  );
  assert.equal(badgeMock.textContent, '已代理');
  assert.equal(badgeMock.className, 'badge active');
  assert.equal(dotMock.className, 'status-dot green');

  applyClaudeDesktopBadges({ supported: false }, badgeMock, dotMock);
  assert.equal(badgeMock.textContent, '不支持');
  assert.equal(dotMock.className, 'status-dot red');

  // Test populatePromptPresetsDropdown
  const selectMock = {
    innerHTML: '',
    options: [],
    appendChild(opt) {
      this.options.push(opt);
    },
  };
  global.document = {
    createElement(tag) {
      return { tagName: tag, style: {}, appendChild() {}, append() {} };
    },
  };

  populatePromptPresetsDropdown(selectMock, [{ id: 'debug', name: 'Debug 模式' }], 'debug');
  assert.equal(selectMock.options.length, 2);
  assert.equal(selectMock.options[1].value, 'debug');
  assert.equal(selectMock.options[1].selected, true);

  // Test renderClientActivity with empty and records
  const containerMock = {
    innerHTML: '',
    children: [],
    appendChild(child) {
      this.children.push(child);
    },
  };
  renderClientActivity(containerMock, []);
  assert.ok(containerMock.children.length > 0);

  containerMock.children = [];
  renderClientActivity(containerMock, [
    {
      id: 'req-1',
      time: Date.now(),
      model: 'deepseek-v4-pro',
      statusCode: 200,
      elapsed: 350,
      ok: true,
    },
    {
      id: 'req-2',
      time: Date.now(),
      model: 'gpt-5.5',
      statusCode: 400,
      elapsed: 120,
      ok: false,
      error: 'Invalid tool schema',
    },
  ]);
  assert.ok(containerMock.children.length > 0);

  console.log('[tool-status-presentation.test] ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
