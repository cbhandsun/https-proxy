// Tests for the frontend diagnostics module rendering helpers.

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

function loadDiagnosticsHelpers() {
  const elements = new Map();
  function makeElement(tag = 'div') {
    return {
      tagName: tag.toUpperCase(),
      children: [],
      className: '',
      style: {},
      checked: false,
      value: '',
      innerHTML: '',
      scrollTop: 0,
      scrollHeight: 0,
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
    };
  }
  function getElement(id) {
    if (!elements.has(id)) elements.set(id, makeElement('div'));
    return elements.get(id);
  }
  const sandbox = {
    window: {},
    document: {
      hidden: false,
      addEventListener() {},
      createElement: makeElement,
      querySelectorAll() {
        return [];
      },
    },
    console,
    bindDomainDependencies: (...args) => args[1],
    setInterval() {
      return 0;
    },
    clearInterval() {},
    Promise,
    Date,
    config: { diagnostics: { externalIngressUrl: '' } },
    storage: {
      getItem() {
        return null;
      },
      setItem() {},
    },
    escapeHtml,
    LOG_RENDER_LINE_LIMIT: 200,
    MONITOR_SEARCH_BODY_LIMIT: 512,
    MONITOR_RENDER_WINDOW: 100,
    heartbeatTimer: null,
    monitorRefreshInFlight: false,
    monitorEvents: [],
    lastEventTime: null,
    lastRenderedMonitorHtml: null,
    viewDomCache: null,
    cliSessionsTimer: null,
    lastLogAutoRefreshAt: 0,
    lastCliSessionsPollAt: 0,
    refreshActiveDiagnosticsPanel() {},
    refreshCliSessions() {},
    isCodeToolsVisible() {
      return false;
    },
    $(id) {
      const element = getElement(id);
      if (!element.classList) element.classList = { contains: () => false };
      return element;
    },
  };
  sandbox.sharedAppState = {};
  for (const name of [
    'diagnosticsRefreshInFlight',
    'heartbeatTimer',
    'lastEventTime',
    'lastLogAutoRefreshAt',
    'lastRenderedDiagnosticsOutput',
    'lastRenderedDiagnosticsStatus',
    'lastRenderedLog',
    'lastRenderedMonitorHtml',
    'lastStatusRefresh',
    'logRefreshInFlight',
    'logRefreshTimer',
    'monitorEvents',
    'monitorRefreshInFlight',
    'startupProxyRetryTimer',
    'statusRefreshInFlight',
    'viewDomCache',
  ]) {
    Object.defineProperty(sandbox.sharedAppState, name, {
      get: () => sandbox[name],
      set: (value) => {
        sandbox[name] = value;
      },
    });
  }
  sandbox.sharedCliState = {};
  Object.defineProperty(sandbox.sharedCliState, 'lastCliSessionsPollAt', {
    get: () => sandbox.lastCliSessionsPollAt,
    set: (value) => {
      sandbox.lastCliSessionsPollAt = value;
    },
  });
  getElement('autoScrollMonitor').checked = false;
  getElement('monitorSearch').value = '';
  getElement('monitorStatusFilter').value = 'all';
  vm.createContext(sandbox);
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'tauri-ui', 'src', 'app', 'domains', 'diagnostics.js'),
    'utf8'
  );
  vm.runInContext(stripEsmSyntax(src), sandbox);
  sandbox.configureDiagnostics(sandbox);
  return { helpers: sandbox.window.__diagnosticsTest, sandbox, elements, src };
}

const { helpers, sandbox, elements, src } = loadDiagnosticsHelpers();
assert.equal(
  typeof helpers.createLogLineElement,
  'function',
  'createLogLineElement exported for tests'
);
assert.equal(typeof helpers.logLineClassName, 'function', 'logLineClassName exported for tests');
assert.equal(typeof helpers.renderLogLines, 'function', 'renderLogLines exported for tests');
assert.equal(
  typeof helpers.prepareMonitorEvent,
  'function',
  'prepareMonitorEvent exported for tests'
);
assert.equal(typeof helpers.renderMonitor, 'function', 'renderMonitor exported for tests');
assert.equal(
  typeof helpers.createMonitorEventElement,
  'function',
  'createMonitorEventElement exported for tests'
);
assert.equal(
  typeof helpers.formatExternalIngressProbe,
  'function',
  'external ingress probe formatter exported for tests'
);
assert.ok(!/\.innerHTML\s*=/.test(src), 'diagnostics module should not assign innerHTML');

const logTarget = sandbox.$('log');
helpers.renderLogLines(
  logTarget,
  [
    '-> POST /v1/messages <img src=x onerror=alert(1)>',
    'xx failed <script>alert(2)</script>',
    '!! warning <svg onload=alert(3)>',
  ].join('\n')
);

assert.equal(logTarget.children.length, 3, 'three log lines are rendered');
assert.equal(logTarget.children[0].className, 'log-line info arrow', 'request line is highlighted');
assert.equal(logTarget.children[1].className, 'log-line error', 'error line is highlighted');
assert.equal(logTarget.children[2].className, 'log-line warn', 'warning line is highlighted');
assert.equal(
  logTarget.children[0].textContent,
  '-> POST /v1/messages <img src=x onerror=alert(1)>',
  'log image tag is text, not markup'
);
assert.equal(
  logTarget.children[1].textContent,
  'xx failed <script>alert(2)</script>',
  'log script tag is text, not markup'
);
assert.equal(
  logTarget.children[2].textContent,
  '!! warning <svg onload=alert(3)>',
  'log svg tag is text, not markup'
);
assert.equal(logTarget.innerHTML, '', 'log render does not assign HTML strings in test DOM');

helpers.renderLogLines(logTarget, '');
assert.equal(logTarget.children.length, 1, 'empty logs render one placeholder');
assert.equal(logTarget.children[0].className, 'log-line muted', 'empty placeholder is muted');
assert.equal(logTarget.children[0].textContent, '暂无日志', 'empty placeholder text is rendered');

const event = helpers.prepareMonitorEvent({
  kind: 'upstream_error',
  time: '2026-06-12T00:00:00.000Z',
  code: '502',
  body: '<img src=x onerror=alert(4)>',
  method: 'POST',
  path: '/v1/messages?<script>alert(5)</script>',
});
assert.ok(
  event.__monitorView.title.includes('<img'),
  'raw monitor title is preserved before render'
);
assert.ok(event.__searchText.includes('502'), 'monitor search text is prepared');
assert.ok(event.__searchText.includes('post'), 'monitor search text includes method');
assert.equal(event.__monitorView.levelClass, 'error', 'upstream error is marked as error');
assert.equal(event.__monitorView.badgeClass, 'protocol', 'badge class remains controlled');

const escapedTitle = escapeHtml(event.__monitorView.title);
const escapedDetails = escapeHtml(event.__monitorView.details);
assert.ok(escapedTitle.includes('&lt;img'), 'monitor title is escapable for rendering');
assert.ok(escapedDetails.includes('&lt;script'), 'monitor details are escapable for rendering');

sandbox.monitorEvents = [event];
helpers.renderMonitor();
const monitorList = elements.get('monitorList');
assert.equal(monitorList.children.length, 1, 'one monitor event is rendered');
assert.equal(monitorList.children[0].children[0].children[0].textContent.includes('<img'), true);
assert.equal(monitorList.children[0].children[1].textContent.includes('<script>'), true);
assert.equal(monitorList.innerHTML, '', 'monitor render does not assign HTML strings in test DOM');
assert.equal(
  monitorList.textContent.includes('&lt;img'),
  false,
  'monitor DOM stores text, not escaped markup'
);

assert.equal(
  helpers.formatExternalIngressProbe({
    ok: false,
    statusCode: 404,
    elapsedMs: 12,
    classification: 'ingress_route_missing',
    message: '<img src=x onerror=alert(6)>',
  }),
  '异常：<img src=x onerror=alert(6)>（HTTP 404 · 12ms · ingress_route_missing）'
);

console.log('app-diagnostics.test.js ok');
