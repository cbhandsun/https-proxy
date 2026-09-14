// Tests for the frontend audit module rendering helpers.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripEsmSyntax } = require('./helpers/strip-esm-syntax');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

function loadAuditHelpers() {
  function makeElement(tag = 'div') {
    return {
      tagName: tag.toUpperCase(),
      children: [],
      dataset: {},
      style: {},
      className: '',
      _textContent: '',
      classList: {
        values: new Set(),
        add(value) {
          this.values.add(value);
        },
        remove(value) {
          this.values.delete(value);
        },
        contains(value) {
          return this.values.has(value);
        },
      },
      setAttribute(name, value) {
        this.attributes = this.attributes || {};
        this.attributes[name] = String(value);
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      set textContent(value) {
        this._textContent = String(value == null ? '' : value);
        if (this._textContent === '') this.children = [];
      },
      get textContent() {
        return [
          this._textContent || '',
          ...this.children.map((child) => child.textContent || ''),
        ].join('');
      },
      set innerHTML(value) {
        this._innerHTML = String(value == null ? '' : value);
      },
      get innerHTML() {
        return this._innerHTML || '';
      },
    };
  }
  const sandbox = {
    window: {},
    document: {
      createElement: makeElement,
      createElementNS(ns, tag) {
        const element = makeElement(tag);
        element.namespaceURI = ns;
        return element;
      },
      createTextNode(value) {
        const node = makeElement('#text');
        node.textContent = value;
        return node;
      },
    },
    console,
    bindDomainDependencies: (...args) => args[1],
    escapeHtml,
    escapeAttr,
  };
  vm.createContext(sandbox);
  const modelSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'tauri-ui', 'src', 'app', 'models', 'inspection-view.js'),
    'utf8'
  );
  vm.runInContext(stripEsmSyntax(modelSrc), sandbox);
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'tauri-ui', 'src', 'app', 'domains', 'audit.js'),
    'utf8'
  );
  vm.runInContext(stripEsmSyntax(src), sandbox);
  sandbox.configureAudit(sandbox);
  return { helpers: sandbox.window.__auditTest, src };
}

const { helpers, src } = loadAuditHelpers();
assert.equal(
  typeof helpers.safeAuditCodeLanguage,
  'function',
  'safeAuditCodeLanguage exported for tests'
);
assert.equal(
  typeof helpers.createAuditHistoryItemElement,
  'function',
  'createAuditHistoryItemElement exported for tests'
);
assert.equal(
  typeof helpers.createAuditInspectorElement,
  'function',
  'createAuditInspectorElement exported for tests'
);
assert.equal(
  typeof helpers.createAuditMessageElement,
  'function',
  'createAuditMessageElement exported for tests'
);
assert.equal(
  typeof helpers.createAuditNoticeElement,
  'function',
  'createAuditNoticeElement exported for tests'
);
assert.equal(
  typeof helpers.createAuditSystemPanelElement,
  'function',
  'createAuditSystemPanelElement exported for tests'
);
assert.equal(
  typeof helpers.createAuditToolCallElement,
  'function',
  'createAuditToolCallElement exported for tests'
);
assert.equal(
  typeof helpers.renderAuditMarkdown,
  'function',
  'renderAuditMarkdown exported for tests'
);
assert.equal(
  typeof helpers.createUsageMetricElement,
  'function',
  'createUsageMetricElement exported for tests'
);
assert.equal(
  typeof helpers.createUsageRecentElement,
  'function',
  'createUsageRecentElement exported for tests'
);
assert.equal(
  typeof helpers.createUsageTableElement,
  'function',
  'createUsageTableElement exported for tests'
);
assert.equal(
  typeof helpers.renderEmptyAuditState,
  'function',
  'renderEmptyAuditState exported for tests'
);
assert.ok(!/\.innerHTML\s*=/.test(src), 'audit module should not assign innerHTML');
assert.ok(
  /renderEmptyAuditState\(\);\s*await loadAuditRecords\(\);/.test(src),
  'clearing audit history immediately clears UI state before reloading records'
);
assert.ok(
  /clearBtn\.disabled = true;[\s\S]*clearBtn\.disabled = false;/.test(src),
  'clear audit button is disabled while the clear request is in flight'
);

assert.equal(helpers.safeAuditCodeLanguage('JavaScript'), 'javascript');
assert.equal(helpers.safeAuditCodeLanguage('ts-node_20'), 'ts-node_20');
assert.equal(helpers.safeAuditCodeLanguage('"><img src=x onerror=alert(1)>'), '');
assert.equal(helpers.safeAuditCodeLanguage('x'.repeat(40)), '');

const markdownTarget = helpers.renderAuditMarkdown(
  [
    'hello <img src=x onerror=alert(25)> and `<script>alert(26)</script>`',
    '',
    '```js',
    '<svg onload=alert(27)>',
    '```',
  ].join('\n')
);
assert.equal(markdownTarget.innerHTML, '', 'Markdown renderer does not assign HTML strings');
assert.ok(
  markdownTarget.textContent.includes('<img src=x onerror=alert(25)>'),
  'Markdown plain text is text content'
);
assert.ok(
  markdownTarget.textContent.includes('<script>alert(26)</script>'),
  'Markdown inline code is text content'
);
assert.ok(
  markdownTarget.textContent.includes('<svg onload=alert(27)>'),
  'Markdown code block is text content'
);
const markdownCode = markdownTarget.children.find((child) => child.tagName === 'PRE').children[0];
assert.equal(markdownCode.className, 'language-js', 'safe code language is preserved as a class');

const unsafeMarkdownTarget = helpers.renderAuditMarkdown(
  ['```"><img src=x onerror=alert(28)>', '<script>alert(29)</script>', '```'].join('\n')
);
const unsafeCode = unsafeMarkdownTarget.children[0].children[0];
assert.equal(unsafeCode.className, '', 'unsafe code language omits class attribute');
assert.ok(
  unsafeCode.textContent.includes('<script>alert(29)</script>'),
  'unsafe code block content is text'
);

const item = helpers.createAuditHistoryItemElement(
  {
    time: '2026-06-12T00:00:00.000Z',
    protocol: 'claude',
    statusCode: 200,
    elapsed: 12,
    originalModel: 'claude<script>alert(1)</script>',
    rewriteModel: 'gemini<img src=x onerror=alert(2)>',
    profileName: 'profile<svg onload=alert(3)>',
    usage: { totalTokens: 1234 },
    messages: [{ role: 'user', content: '<img src=x onerror=alert(4)>' }],
  },
  7,
  'audit-7',
  true
);
assert.equal(item.dataset.auditIndex, '7');
assert.equal(item.dataset.auditId, 'audit-7');
assert.equal(item.classList.contains('active'), true);
assert.ok(item.textContent.includes('<img src=x onerror=alert(4)>'), 'snippet is text content');
assert.ok(
  item.textContent.includes('gemini<img src=x onerror=alert(2)>'),
  'model flow is text content'
);
assert.equal(item.innerHTML, '', 'history item does not use HTML strings');

const slowItem = helpers.createAuditHistoryItemElement(
  {
    time: '2026-06-12T00:00:00.000Z',
    protocol: 'claude',
    statusCode: 200,
    elapsed: 8000,
    messages: [{ role: 'user', content: 'slow request' }],
  },
  8,
  'audit-8',
  false
);
assert.ok(
  slowItem.textContent.includes('偏慢'),
  'slow rows are labelled so the filter is explainable'
);
assert.equal(slowItem.innerHTML, '', 'slow label is rendered as text');

const notice = helpers.createAuditNoticeElement('<script>alert(5)</script>', {
  danger: true,
  prefix: '失败：',
});
assert.ok(
  notice.textContent.includes('<script>alert(5)</script>'),
  'notice message is text content'
);
assert.equal(notice.innerHTML, '', 'notice does not use HTML strings');

const inspector = helpers.createAuditInspectorElement({
  method: 'POST',
  path: '/v1/messages?<img src=x onerror=alert(6)>',
  request: {
    headers: { authorization: 'Bearer secret' },
    body: { prompt: '<script>alert(7)</script>' },
  },
  upstream: { url: 'https://example.test/<svg onload=alert(8)>' },
  responseHeaders: { 'x-test': '<img src=x onerror=alert(9)>' },
  response: { content: '<script>alert(10)</script>' },
});
assert.ok(
  inspector.textContent.includes('<script>alert(7)</script>'),
  'inspector JSON is text content'
);
assert.equal(inspector.innerHTML, '', 'inspector container does not use HTML strings');

const systemPanel = helpers.createAuditSystemPanelElement('<img src=x onerror=alert(11)>');
assert.ok(
  systemPanel.textContent.includes('<img src=x onerror=alert(11)>'),
  'system prompt is text content'
);
assert.equal(systemPanel.innerHTML, '', 'system panel container does not use HTML strings');

const tool = helpers.createAuditToolCallElement({
  id: 'tool<script>alert(12)</script>',
  name: '<img src=x onerror=alert(13)>',
  input: '{"q":"<script>alert(14)</script>"}',
});
assert.ok(tool.textContent.includes('<img src=x onerror=alert(13)>'), 'tool name is text content');
assert.ok(tool.textContent.includes('<script>alert(14)</script>'), 'tool args are text content');
assert.equal(tool.innerHTML, '', 'tool container does not use HTML strings');

const message = helpers.createAuditMessageElement({
  role: 'assistant',
  content: '<img src=x onerror=alert(15)>',
  tool_calls: [{ id: 'call-1', name: 'lookup', input: { q: '<svg onload=alert(16)>' } }],
});
assert.ok(
  message.textContent.includes('<svg onload=alert(16)>'),
  'message tool args are text content'
);
assert.ok(message.innerHTML === '', 'message container does not use HTML strings directly');

const usageMetric = helpers.createUsageMetricElement(
  '<img src=x onerror=alert(17)>',
  '<script>alert(18)</script>',
  '<svg onload=alert(19)>'
);
assert.ok(
  usageMetric.textContent.includes('<script>alert(18)</script>'),
  'usage metric value is text content'
);
assert.equal(usageMetric.innerHTML, '', 'usage metric does not use HTML strings');

const usageTable = helpers.createUsageTableElement(
  [
    {
      label: 'profile<img src=x onerror=alert(20)>',
      key: 'fallback',
      requests: 1,
      inputTokens: 2,
      outputTokens: 3,
      cost: 0.01,
      estimatedRecords: '<script>alert(21)</script>',
    },
  ],
  'profile'
);
assert.ok(
  usageTable.textContent.includes('profile<img src=x onerror=alert(20)>'),
  'usage table label is text content'
);
assert.ok(
  usageTable.textContent.includes('<script>alert(21)</script> 条估算'),
  'usage table estimate is text content'
);
assert.equal(usageTable.innerHTML, '', 'usage table does not use HTML strings');

const recentTable = helpers.createUsageRecentElement([
  {
    time: '2026-06-12T00:00:00.000Z',
    profileName: 'profile<svg onload=alert(22)>',
    model: 'model<img src=x onerror=alert(23)>',
    usage: { totalTokens: 123 },
    cost: { known: true, amount: 0.02 },
    statusCode: '<script>alert(24)</script>',
  },
]);
assert.ok(
  recentTable.textContent.includes('profile<svg onload=alert(22)>'),
  'recent profile is text content'
);
assert.ok(
  recentTable.textContent.includes('model<img src=x onerror=alert(23)>'),
  'recent model is text content'
);
assert.equal(recentTable.innerHTML, '', 'recent usage table does not use HTML strings');

// The retry control must be disabled whenever a safe replay is impossible.
function findElement(node, predicate) {
  if (!node) return null;
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}

const retryHeader = helpers.createAuditDetailHeaderElement({
  id: 'audit-retry-1',
  time: '2026-06-12T00:00:00.000Z',
  protocol: 'claude',
  statusCode: 200,
  elapsed: 120,
  request: { body: '', truncated: false },
});
const retryButton = findElement(retryHeader, (node) => node.id === 'retryAuditRequestBtn');
assert.ok(retryButton, 'retry button is rendered on the audit detail header');
assert.equal(
  retryButton.disabled,
  true,
  'retry is disabled when the request body was not captured'
);
assert.ok(retryButton.title.includes('未保留请求体'), 'retry tooltip explains the disabled reason');

const truncatedRetryHeader = helpers.createAuditDetailHeaderElement({
  id: 'audit-retry-2',
  time: '2026-06-12T00:00:00.000Z',
  protocol: 'openai',
  statusCode: 200,
  elapsed: 120,
  request: { body: '{}', truncated: true },
});
const truncatedRetryButton = findElement(
  truncatedRetryHeader,
  (node) => node.id === 'retryAuditRequestBtn'
);
assert.equal(truncatedRetryButton.disabled, true, 'retry is disabled for truncated request bodies');

const replayableHeader = helpers.createAuditDetailHeaderElement({
  id: 'audit-retry-3',
  time: '2026-06-12T00:00:00.000Z',
  protocol: 'claude',
  statusCode: 200,
  elapsed: 120,
  request: { body: '{"model":"claude-opus-4"}', truncated: false },
});
const replayableButton = findElement(
  replayableHeader,
  (node) => node.id === 'retryAuditRequestBtn'
);
assert.equal(replayableButton.disabled, false, 'retry stays enabled for captured request bodies');
assert.equal(replayableButton.title, '通过本地入口重放该请求');

assert.ok(
  /newestIndexedWindow/.test(src),
  'audit list resolves clicked rows through the indexed paging window'
);
assert.ok(
  !/record = filteredAuditRecords\(\)\[Number\(item\.dataset\.auditIndex\)\]/.test(src),
  'audit list must not recompute the filter before resolving a clicked row'
);

console.log('app-audit.test.js ok');
