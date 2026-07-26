// Tests for the frontend UX module — P3 体验增强 (通知/主题/延迟加载)
// 在 Node 中以 vm 沙箱执行 app-ux.js，注入最小 window/Notification/localStorage。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function readAppSource() {
  return ['app-tool-status.js', 'app-environment.js', 'app-mcp.js', 'app.js']
    .map((file) =>
      fs.readFileSync(path.join(__dirname, '..', 'tauri-ui', 'src', 'modules', file), 'utf8')
    )
    .join('\n');
}

function buildSandbox() {
  const listeners = new Map();
  const localStorage = {
    _data: new Map(),
    getItem(k) {
      return this._data.has(k) ? this._data.get(k) : null;
    },
    setItem(k, v) {
      this._data.set(k, String(v));
    },
    removeItem(k) {
      this._data.delete(k);
    },
    clear() {
      this._data.clear();
    },
  };
  const calls = {
    notifications: [],
    appendChild: [],
  };
  function makeMediaQueryList() {
    return {
      matches: false,
      addEventListener(_type, cb) {
        const arr = listeners.get('mq') || [];
        arr.push(cb);
        listeners.set('mq', arr);
      },
      removeEventListener(_type, cb) {
        const arr = listeners.get('mq') || [];
        const idx = arr.indexOf(cb);
        if (idx >= 0) arr.splice(idx, 1);
        listeners.set('mq', arr);
      },
      addListener(cb) {
        this.addEventListener('change', cb);
      },
      removeListener(cb) {
        this.removeEventListener('change', cb);
      },
    };
  }
  const elements = new Map();
  function makeEl(tag) {
    const node = {
      tagName: tag.toUpperCase(),
      children: [],
      dataset: {},
      style: {},
      listeners: {},
      appendChild(c) {
        this.children.push(c);
        calls.appendChild.push(c);
        return c;
      },
      addEventListener(t, cb) {
        (this.listeners[t] ||= []).push(cb);
      },
      dispatch(ev) {
        (this.listeners[ev.type] || []).forEach((cb) => cb(ev));
      },
    };
    return node;
  }
  const root = makeEl('html');
  root.setAttribute = function (k, v) {
    this.dataset[k] = v;
  };
  root.getAttribute = function (k) {
    return this.dataset[k];
  };
  function $(id) {
    if (elements.has(id)) return elements.get(id);
    const el = makeEl('div');
    el.id = id;
    elements.set(id, el);
    return el;
  }
  const document = {
    documentElement: root,
    head: makeEl('head'),
    getElementById: $,
    createElement(tag) {
      return makeEl(tag);
    },
    querySelector() {
      return null;
    },
    addEventListener(_t, _cb) {
      // no-op
    },
  };
  const Notification = function (title, opts) {
    calls.notifications.push({ title, opts });
    this.title = title;
    this.opts = opts || {};
    this.closed = false;
    this.close = () => {
      this.closed = true;
    };
  };
  Notification.permission = 'default';
  Notification.requestPermission = async () => {
    Notification.permission = 'granted';
    return 'granted';
  };
  const window = {
    Notification,
    localStorage,
    matchMedia: makeMediaQueryList,
    addEventListener() {
      // no-op
    },
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    Math,
  };
  return {
    sandbox: {
      window,
      document,
      console,
      setTimeout,
      clearTimeout,
      Promise,
      Date,
      Math,
      localStorage,
      Notification,
    },
    root,
    elements,
    calls,
    listeners,
  };
}

function loadUx(sandbox) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'tauri-ui', 'src', 'modules', 'app-ux.js'),
    'utf8'
  );
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window.UX;
}

function tick(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  // ─── 1. notify() requires & uses Notification API ──────────────
  {
    const { sandbox, calls } = buildSandbox();
    const UX = loadUx(sandbox);
    assert.equal(typeof UX.notify, 'function', 'notify() exists');
    assert.equal(UX.canNotify(), true, 'canNotify true when Notification available');
    UX.notify('代理已启动', { body: '端口 3543', tag: 'proxy:start' });
    await tick(5);
    assert.ok(calls.notifications.length >= 1, 'Notification constructor called');
    assert.equal(calls.notifications[0].title, '代理已启动');
    assert.equal(calls.notifications[0].opts.tag, 'proxy:start');
  }

  // ─── 2. notify() de-dupes within 1.5s window ──────────────────
  {
    const { sandbox, calls } = buildSandbox();
    const UX = loadUx(sandbox);
    UX.notify('hello', { tag: 'dup' });
    UX.notify('hello', { tag: 'dup' });
    await tick(5);
    assert.equal(calls.notifications.length, 1, 'duplicate within 1.5s suppressed');
  }

  // ─── 3. theme: light/dark/auto cycle ──────────────────────────
  {
    const { sandbox, root } = buildSandbox();
    const UX = loadUx(sandbox);
    UX.theme.init();
    assert.equal(UX.theme.getMode(), 'auto', 'default mode is auto');
    assert.equal(root.getAttribute('data-theme-mode'), 'auto', 'data-theme-mode set');
    const mode1 = UX.theme.cycle();
    assert.equal(mode1, 'light', 'auto -> light');
    const mode2 = UX.theme.cycle();
    assert.equal(mode2, 'dark', 'light -> dark');
    const mode3 = UX.theme.cycle();
    assert.equal(mode3, 'auto', 'dark -> auto');
  }

  // ─── 4. theme: localStorage persistence ────────────────────────
  {
    const { sandbox, root } = buildSandbox();
    sandbox.window.localStorage.setItem('theme', 'dark');
    const UX = loadUx(sandbox);
    UX.theme.init();
    assert.equal(UX.theme.getMode(), 'dark', 'reads stored dark');
    assert.equal(root.getAttribute('data-theme-mode'), 'dark', 'mode applied to root');
  }

  // ─── 5. lazyOnVisible: triggers loader when intersecting ──────
  {
    const { sandbox, calls } = buildSandbox();
    const UX = loadUx(sandbox);
    let loaded = false;
    // JSDOM not available; pass a sentinel that has classList
    const fakeEl = {
      dataset: {},
      classList: { add: () => {} },
    };
    // Force the no-IntersectionObserver branch to ensure compat
    const saved = global.IntersectionObserver;
    delete global.IntersectionObserver;
    try {
      // Add a noop IntersectionObserver to the sandbox so we exercise
      // the immediate-fallback path
      sandbox.IntersectionObserver = undefined;
      UX.lazyOnVisible(fakeEl, () => {
        loaded = true;
      });
      await tick(500);
      assert.equal(loaded, true, 'lazyOnVisible fires when no observer available');
    } finally {
      if (saved) global.IntersectionObserver = saved;
    }
    assert.deepEqual(calls.appendChild, [], 'no DOM mutations');
  }

  // ─── 6. loadScript: inserts <script> tag, idempotent ──────────
  {
    const { sandbox } = buildSandbox();
    const UX = loadUx(sandbox);
    const headChildren = sandbox.document.head.children;
    const p1 = UX.loadScript('https://example.com/foo.js');
    const p2 = UX.loadScript('https://example.com/foo.js');
    assert.equal(p1, p2, 'same URL returns same promise');
    await tick(10);
    assert.equal(headChildren.length, 1, 'only one script tag inserted');
    assert.equal(headChildren[0].src, 'https://example.com/foo.js');
    // 触发 load
    headChildren[0].dispatch({ type: 'load' });
    await p1;
    assert.equal(headChildren[0].dataset.loaded, '1', 'marked as loaded');
    // 第三次再 load 不重复插入
    await UX.loadScript('https://example.com/foo.js');
    assert.equal(headChildren.length, 1, 'still one script tag');
  }

  // ─── 7. Claude Desktop process verification controls exist ────
  {
    const { sandbox } = buildSandbox();
    const UX = loadUx(sandbox);
    assert.deepEqual(Array.from(UX.storage.parsePromptTemplates('invalid')), []);
    assert.deepEqual(Array.from(UX.storage.parsePromptTemplates('{"name":"not-array"}')), []);
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(
          UX.storage.parsePromptTemplates(
            JSON.stringify([
              { name: ' valid ', content: 'content' },
              { name: '', content: 'drop' },
              { name: 'wrong', content: 42 },
            ])
          )
        )
      ),
      [{ name: 'valid', content: 'content' }]
    );
    const cliProfiles = UX.storage.parseCliProfiles(
      JSON.stringify([
        { id: 'valid', name: 'CLI', toolId: 'codex', model: 'm', upgrade: true },
        { id: 'valid', name: 'duplicate', toolId: 'codex' },
        { id: 'bad id', toolId: 'codex' },
      ])
    );
    assert.equal(cliProfiles.length, 1);
    assert.equal(cliProfiles[0].id, 'valid');
    assert.equal(cliProfiles[0].upgrade, true);
    assert.equal(UX.storage.parsePromptTemplates('x'.repeat(5 * 1024 * 1024 + 1)).length, 0);
  }

  // ─── 8. Claude Desktop process verification controls exist ────
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'tauri-ui', 'index.html'), 'utf8');
    const app = readAppSource();
    assert.ok(
      html.includes('id="testClaudeDesktopProcess"'),
      'Claude Desktop process self-test button exists'
    );
    assert.ok(
      html.includes('id="copyClaudeDesktopProcessPrompt"'),
      'Claude Desktop process prompt copy button exists'
    );
    assert.ok(
      app.includes('copyClaudeDesktopProcessPrompt'),
      'Claude Desktop prompt copy handler is bound'
    );
  }

  // ─── 8. MCP Hub uses delegated DOM handlers, not inline JS ─────
  {
    const mcpModule = fs.readFileSync(
      path.join(__dirname, '..', 'tauri-ui', 'src', 'modules', 'app-mcp.js'),
      'utf8'
    );
    const start = mcpModule.indexOf('function renderMcpServers()');
    const end = mcpModule.indexOf('function renderMcpLogs(', start);
    assert.ok(start > 0 && end > start, 'MCP Hub render section found');
    const mcpSection = mcpModule.slice(start, end);
    assert.ok(
      !/\son(?:click|change|input|load)=/i.test(mcpSection),
      'MCP Hub has no inline event handlers'
    );
    assert.ok(!mcpSection.includes('window.updateMcpServer'), 'MCP update handler is not global');
    assert.ok(!mcpSection.includes('window.deleteMcpServer'), 'MCP delete handler is not global');
  }

  // ─── 9. Prompt template lists avoid dynamic HTML strings ───────
  {
    const app = readAppSource();
    const presetStart = app.indexOf('function loadPresetPrompts()');
    const presetEnd = app.indexOf('function loadTemplates()', presetStart);
    assert.ok(presetStart > 0 && presetEnd > presetStart, 'preset prompt render section found');
    const presetSection = app.slice(presetStart, presetEnd);
    assert.ok(
      presetSection.includes('createPresetPromptItemElement(tpl, index)'),
      'preset prompts render through DOM helper'
    );
    assert.ok(
      !presetSection.includes('item.innerHTML'),
      'preset prompt cards do not use innerHTML'
    );

    const templateStart = app.indexOf('function loadTemplates()');
    const templateEnd = app.indexOf('const saveTplBtn', templateStart);
    assert.ok(
      templateStart > 0 && templateEnd > templateStart,
      'custom template render section found'
    );
    const templateSection = app.slice(templateStart, templateEnd);
    assert.ok(
      templateSection.includes('createTemplateEmptyElement()'),
      'empty template state renders through DOM helper'
    );
    assert.ok(
      !templateSection.includes('listContainer.innerHTML'),
      'template list does not use innerHTML'
    );
  }

  // ─── 10. MCP execution logs avoid dynamic HTML strings ─────────
  {
    const mcpModule = fs.readFileSync(
      path.join(__dirname, '..', 'tauri-ui', 'src', 'modules', 'app-mcp.js'),
      'utf8'
    );
    const start = mcpModule.indexOf('function renderMcpLogs(logs)');
    const end = mcpModule.indexOf('async function saveMcpHub()', start);
    assert.ok(start > 0 && end > start, 'MCP log render section found');
    const logsSection = mcpModule.slice(start, end);
    assert.ok(
      mcpModule.includes('function createMcpLogEntryElement(log)'),
      'MCP log entry DOM helper exists'
    );
    assert.ok(
      logsSection.includes('createMcpLogEntryElement(log)'),
      'MCP logs render through DOM helper'
    );
    assert.ok(!logsSection.includes('container.innerHTML'), 'MCP logs do not use innerHTML');
    assert.ok(
      !logsSection.includes('escapeHtml(log.'),
      'MCP logs do not build escaped HTML strings'
    );
    assert.ok(
      !/\blog\.input\b/.test(mcpModule) &&
        !/\blog\.result\b/.test(mcpModule) &&
        !/\blog\.error\b/.test(mcpModule),
      'MCP log UI consumes metadata only and cannot render captured content'
    );
  }

  // ─── 11. Claude Desktop model table avoids dynamic HTML strings ─
  {
    const app = readAppSource();
    const start = app.indexOf('function renderClaudeDesktopModels()');
    const end = app.indexOf('function syncClaudeDesktopRoutesToModelRoutes()', start);
    assert.ok(start > 0 && end > start, 'Claude Desktop model render section found');
    const desktopSection = app.slice(start, end);
    assert.ok(
      app.includes('function createClaudeDesktopModelRow(model, index)'),
      'Claude Desktop model row DOM helper exists'
    );
    assert.ok(
      desktopSection.includes('createClaudeDesktopModelsTableElement(config.claudeDesktop.models)'),
      'Claude Desktop model table renders through DOM helper'
    );
    assert.ok(
      !desktopSection.includes('container.innerHTML'),
      'Claude Desktop model table does not use innerHTML'
    );
    assert.ok(
      !desktopSection.includes('escapeHtml(resolved.'),
      'Claude Desktop model table does not build escaped HTML strings'
    );
  }

  // ─── 12. Dynamic select/datalist options use DOM APIs ──────────
  {
    const app = readAppSource();
    assert.ok(
      app.includes('function appendOption(select, value, label = value)'),
      'shared option DOM helper exists'
    );
    [
      ['renderClaudeDesktopRouteOptions', 'updateClaudeDesktopRouteDetails'],
      ['renderClaudeDesktopProfiles', 'renderClaudeDesktopPreview'],
      ['renderRouteProfiles', 'renderModelOptions'],
      ['renderModelOptions', 'routeTableSignature'],
    ].forEach(([fnName, nextFn]) => {
      const start = app.indexOf(`function ${fnName}`);
      const end = app.indexOf(`function ${nextFn}`, start + 1);
      assert.ok(start > 0 && end > start, `${fnName} section found`);
      const section = app.slice(start, end);
      assert.ok(section.includes('appendOption('), `${fnName} uses appendOption`);
      assert.ok(!section.includes('.innerHTML'), `${fnName} does not use innerHTML`);
      assert.ok(!section.includes('<option'), `${fnName} does not build option HTML strings`);
    });
  }

  // ─── 13. Entry server rows avoid dynamic HTML strings ──────────
  {
    const app = readAppSource();
    const start = app.indexOf('function renderEntryServers()');
    const end = app.indexOf('function renderLocalPreview()', start);
    assert.ok(start > 0 && end > start, 'entry server render section found');
    const section = app.slice(start, end);
    assert.ok(
      app.includes('function createEntryServerRow(entry, index)'),
      'entry server DOM helper exists'
    );
    assert.ok(
      app.includes('group.appendChild(createEntryServerRow(entry, index))') &&
        section.includes("createEntryTransportGroup('https', groupedEntries.https)"),
      'entry servers render through grouped DOM helpers'
    );
    assert.ok(!section.includes('.innerHTML'), 'entry server render does not use innerHTML');
    assert.ok(!section.includes('<input'), 'entry server render does not build input HTML strings');
    assert.ok(
      !section.includes('<select'),
      'entry server render does not build select HTML strings'
    );
    assert.ok(
      !section.includes('<option'),
      'entry server render does not build option HTML strings'
    );
  }

  // ─── 14. Preview and proxy status widgets avoid dynamic HTML strings ─
  {
    const app = readAppSource();
    [
      ['renderClaudeDesktopPreview', 'let claudeDesktopPreviewFrame'],
      ['renderLocalPreview', 'claudeProxyBaseUrl'],
      ['refreshProxyStatus', 'function renderPortDiagnostics'],
    ].forEach(([fnName, nextMarker]) => {
      const start = app.indexOf(`function ${fnName}`);
      const end = app.indexOf(nextMarker, start + 1);
      assert.ok(start > 0 && end > start, `${fnName} section found`);
      const section = app.slice(start, end);
      assert.ok(!section.includes('.innerHTML'), `${fnName} does not use innerHTML`);
      assert.ok(!section.includes('<br>'), `${fnName} does not build line-break HTML strings`);
      assert.ok(!section.includes('<span'), `${fnName} does not build status HTML strings`);
      assert.ok(!section.includes('<strong'), `${fnName} does not build label HTML strings`);
    });
    assert.ok(
      app.includes('function setProxyStatusElement(element, color, text)'),
      'proxy status DOM helper exists'
    );
  }

  // ─── 15. Route tables render through DOM helpers ───────────────
  {
    const app = readAppSource();
    assert.ok(
      /function createRoutesTableElement\([^)]*\)/.test(app),
      'route table DOM helper exists'
    );
    assert.ok(
      app.includes('function createRouteTableRow(route, index)'),
      'route table row DOM helper exists'
    );
    [
      ['renderRules', 'renderOverview'],
      ['renderOverview', 'updateOfficialAuthSection'],
    ].forEach(([fnName, nextMarker]) => {
      const start = app.indexOf(`function ${fnName}`);
      const end = app.indexOf(`function ${nextMarker}`, start + 1);
      assert.ok(start > 0 && end > start, `${fnName} section found`);
      const section = app.slice(start, end);
      assert.ok(
        section.includes('createRoutesTableElement('),
        `${fnName} uses route table DOM helper`
      );
      assert.ok(!section.includes('.innerHTML'), `${fnName} does not use innerHTML`);
      assert.ok(!section.includes('routesTable()'), `${fnName} does not render table HTML strings`);
    });
    const start = app.search(/function createRoutesTableElement\([^)]*\)/);
    const end = app.indexOf('function resetRouteEditor()', start);
    assert.ok(start > 0 && end > start, 'route table helper section found');
    const section = app.slice(start, end);
    assert.ok(
      !section.includes('escapeHtml('),
      'route table helper does not depend on HTML escaping'
    );
    assert.ok(!section.includes('`<'), 'route table helper does not build template HTML');
  }

  // ─── 16. Rate limit dashboard renders through DOM helpers ──────
  {
    const app = readAppSource();
    assert.ok(
      app.includes('function createLimitsElement(profileId)'),
      'rate limit DOM helper exists'
    );
    assert.ok(
      app.includes('function limitsSignature(profileId)'),
      'rate limit signature helper exists'
    );
    const renderStart = app.indexOf('function renderDashboardLimits(profileId)');
    const renderEnd = app.indexOf('async function refreshRateLimitsFromUI()', renderStart);
    assert.ok(renderStart > 0 && renderEnd > renderStart, 'rate limit render section found');
    const renderSection = app.slice(renderStart, renderEnd);
    assert.ok(
      renderSection.includes('createLimitsElement(profileId)'),
      'rate limit render uses DOM helper'
    );
    assert.ok(!renderSection.includes('.innerHTML'), 'rate limit render does not use innerHTML');
    assert.ok(
      !renderSection.includes('renderLimitsHtml'),
      'rate limit render does not use HTML helper'
    );

    const helperStart = app.indexOf('function createLimitsTextElement');
    const helperEnd = app.indexOf('async function refreshRateLimits(profileId)', helperStart);
    assert.ok(helperStart > 0 && helperEnd > helperStart, 'rate limit helper section found');
    const helperSection = app.slice(helperStart, helperEnd);
    assert.ok(!helperSection.includes('`<'), 'rate limit helpers do not build template HTML');
    assert.ok(
      !helperSection.includes('escapeHtml('),
      'rate limit helpers do not depend on HTML escaping'
    );
  }

  // ─── 17. Provider help and profile cards avoid dynamic HTML ────
  {
    const app = readAppSource();
    assert.ok(
      app.includes('function renderProviderPresetHelp(preset)'),
      'provider preset help DOM helper exists'
    );
    assert.ok(
      app.includes('function createProfileCardElement(profile)'),
      'profile card DOM helper exists'
    );
    [
      ['renderProviderPresetHelp', 'initProviderPresets'],
      ['initProviderPresets', 'matchPresetByUrl'],
      ['fillForm', 'collectForm'],
      ['renderProfiles', 'initToolsTabSwitching'],
    ].forEach(([fnName, nextMarker]) => {
      const start = app.indexOf(`function ${fnName}`);
      const end = app.indexOf(`function ${nextMarker}`, start + 1);
      assert.ok(start > 0 && end > start, `${fnName} section found`);
      const section = app.slice(start, end);
      assert.ok(!section.includes('.innerHTML'), `${fnName} does not use innerHTML`);
      assert.ok(!section.includes('escapeHtml('), `${fnName} does not build escaped HTML strings`);
      assert.ok(
        !section.includes('escapeAttr('),
        `${fnName} does not build escaped HTML attributes`
      );
    });
    const helperStart = app.indexOf('function profilesSignature()');
    const helperEnd = app.indexOf('function renderProfiles()', helperStart);
    assert.ok(helperStart > 0 && helperEnd > helperStart, 'profile helper section found');
    const helperSection = app.slice(helperStart, helperEnd);
    assert.ok(!helperSection.includes('`<'), 'profile helpers do not build template HTML');
    assert.ok(
      !helperSection.includes('escapeHtml('),
      'profile helpers do not depend on HTML escaping'
    );
    assert.ok(
      app.includes('注：本地运行，不需要填写 API Key。'),
      'Ollama preset description is plain text'
    );
    assert.ok(!app.includes('<b>注：本地运行'), 'Ollama preset description does not embed HTML');
  }

  // ─── 18. Trae debug event list avoids dynamic HTML ─────────────
  {
    const app = readAppSource();
    const start = app.indexOf('function renderTraeDebugEvents(events)');
    const end = app.indexOf('function formatTraeNativeCommandBlock', start);
    assert.ok(start > 0 && end > start, 'Trae debug event section found');
    const section = app.slice(start, end);
    assert.ok(
      section.includes('clearElement(target)'),
      'Trae debug events clear through DOM helper'
    );
    assert.ok(section.includes('target.appendChild(item)'), 'Trae debug events append DOM rows');
    assert.ok(!section.includes('.innerHTML'), 'Trae debug events do not use innerHTML');
    assert.ok(!section.includes('`<'), 'Trae debug events do not build template HTML');
    assert.ok(!section.includes('escapeHtml('), 'Trae debug events do not depend on HTML escaping');
  }

  // ─── 19. Environment tools render through DOM helpers ──────────
  {
    const app = readAppSource();
    [
      'createEnvProgressItem(job)',
      'createEnvSkeletonCard()',
      'createEnvToolCard(tool)',
      'renderEnvSkeleton(grid)',
      'envDataSignature(tools = [])',
    ].forEach((signature) => {
      assert.ok(app.includes(`function ${signature}`), `${signature} helper exists`);
    });

    [
      ['updateEnvInstallProgressPanel', 'markEnvInstallSubmitting'],
      ['refreshEnvStatus', 'window.upgradeSingleTool'],
    ].forEach(([fnName, nextMarker]) => {
      const start = app.indexOf(`function ${fnName}`);
      const end = app.indexOf(nextMarker, start + 1);
      assert.ok(start > 0 && end > start, `${fnName} section found`);
      const section = app.slice(start, end);
      assert.ok(!section.includes('.innerHTML'), `${fnName} does not use innerHTML`);
      assert.ok(!section.includes('escapeHtml('), `${fnName} does not build escaped HTML strings`);
      assert.ok(
        section.includes('replaceChildren') || section.includes('append('),
        `${fnName} renders DOM nodes`
      );
    });

    const helperStart = app.indexOf('function envDataSignature');
    const helperEnd = app.indexOf('async function refreshEnvStatus', helperStart);
    assert.ok(helperStart > 0 && helperEnd > helperStart, 'environment helper section found');
    const helperSection = app.slice(helperStart, helperEnd);
    assert.ok(!helperSection.includes('`<'), 'environment helpers do not build template HTML');
    assert.ok(
      !helperSection.includes('escapeHtml('),
      'environment helpers do not depend on HTML escaping'
    );
  }

  // ─── 20. Certificate status badge avoids dynamic HTML ──────────
  {
    const app = readAppSource();
    assert.ok(
      app.includes('function setStatusDotText(elementId, color, text)'),
      'status dot text helper exists'
    );
    const start = app.indexOf('async function refreshCertStatus(options = {})');
    const end = app.indexOf('function schedulePassiveCertRefresh()', start);
    assert.ok(start > 0 && end > start, 'certificate status section found');
    const section = app.slice(start, end);
    assert.ok(
      section.includes("setStatusDotText('heroCertStatus'"),
      'certificate status uses DOM helper'
    );
    assert.ok(!section.includes('.innerHTML'), 'certificate status does not use innerHTML');
    assert.ok(!section.includes('<span'), 'certificate status does not build status HTML strings');
  }

  // ─── 21. MCP server table renders through DOM helpers ──────────
  {
    const app = readAppSource();
    assert.ok(
      app.includes('function createMcpServersEmptyElement()'),
      'MCP empty DOM helper exists'
    );
    assert.ok(
      app.includes('function createMcpServersTableElement(servers)'),
      'MCP table DOM helper exists'
    );
    const renderStart = app.indexOf('function renderMcpServers()');
    const renderEnd = app.indexOf('function createMcpServerInput', renderStart);
    assert.ok(renderStart > 0 && renderEnd > renderStart, 'MCP server render section found');
    const renderSection = app.slice(renderStart, renderEnd);
    assert.ok(
      renderSection.includes('createMcpServersTableElement(mcpHubConfig.servers)'),
      'MCP render uses table helper'
    );
    assert.ok(!renderSection.includes('.innerHTML'), 'MCP server render does not use innerHTML');
    assert.ok(!renderSection.includes('`<'), 'MCP server render does not build template HTML');

    const helperStart = app.indexOf('function createMcpServersEmptyElement()');
    const helperEnd = app.indexOf('function createMcpServerInput', helperStart);
    assert.ok(helperStart > 0 && helperEnd > helperStart, 'MCP server helper section found');
    const helperSection = app.slice(helperStart, helperEnd);
    assert.ok(!helperSection.includes('`<'), 'MCP server helpers do not build template HTML');
    assert.ok(
      !helperSection.includes('escapeHtml('),
      'MCP server helpers do not depend on HTML escaping'
    );
  }

  // ─── 22. Tauri reload menu uses events instead of eval ─────────
  {
    const rust = ['lib.rs', 'launch_on_login.rs']
      .map((file) => fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', file), 'utf8'))
      .join('\n');
    const bridge = fs.readFileSync(
      path.join(__dirname, '..', 'tauri-ui', 'src', 'modules', 'app-bridge.js'),
      'utf8'
    );
    assert.ok(!rust.includes('window.eval'), 'Tauri menu reload should not eval JavaScript');
    assert.ok(
      rust.includes('window.emit("reload-requested", false)'),
      'regular reload emits a frontend event'
    );
    assert.ok(
      rust.includes('window.emit("reload-requested", true)'),
      'force reload emits a frontend event'
    );
    assert.ok(
      /event\s*\.\s*listen\('reload-requested'/.test(bridge),
      'frontend listens for reload events'
    );
  }

  // ─── 23. Recommended Claude model chips exclude retired IDs ─────
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'tauri-ui', 'index.html'), 'utf8');
    const app = readAppSource();
    const retiredModels = [
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-latest',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-latest',
      'claude-3-opus-20240229',
      'claude-3-haiku-20240307',
      'claude-3-7-sonnet-latest',
      'claude-3-7-sonnet-20250219',
      'claude-opus-4-1',
      'claude-sonnet-4-0',
      'claude-opus-4-0',
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
    ];
    retiredModels.forEach((model) => {
      assert.ok(!html.includes(model), `${model} should not be present in route chips HTML`);
      assert.ok(!app.includes(model), `${model} should not be present in route chip runtime`);
    });
    assert.ok(
      app.includes('function renderRecommendedClientModels()'),
      'route chips are rebuilt from the runtime allowlist'
    );
  }

  // ─── 24. Tauri runtime root selection keeps dev/prod state separate ─
  {
    const rust = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8');
    assert.ok(
      rust.includes('fn is_proxy_runtime_root(path: &Path) -> bool'),
      'Tauri root detection validates complete proxy runtime roots'
    );
    assert.ok(
      rust.includes('if cfg!(debug_assertions)') &&
        rust.includes('return manifest_project_root();'),
      'Tauri dev builds bind to the source checkout instead of stale target/debug copies'
    );
    assert.ok(
      rust.includes('push_proxy_root_ancestors(&mut candidates, start)') &&
        rust.includes('push_proxy_root_ancestors(&mut candidates, exe)') &&
        rust.includes('first_unique_existing_root(candidates)'),
      'Tauri release builds select a verified launch/exe runtime root deterministically'
    );
    assert.ok(
      rust.includes('fn ensure_proxy_config_file(root: &Path)') &&
        rust.includes('ensure_proxy_config_file(&root);'),
      'Tauri direct startup creates proxy.config.json before launching packaged proxy'
    );
    const proxyScript = fs.readFileSync(path.join(__dirname, '..', 'proxy.ps1'), 'utf8');
    assert.ok(
      proxyScript.includes('function Get-ManagementToken') &&
        proxyScript.includes("$headers['x-mgmt-token'] = $token"),
      'proxy.ps1 status health checks use the management token'
    );
    const portableScript = fs.readFileSync(
      path.join(__dirname, '..', 'scripts', 'build-portable.ps1'),
      'utf8'
    );
    assert.ok(
      !portableScript.includes("(Join-Path $PortableDir 'proxy.config.json')") &&
        portableScript.includes("'proxy.config.example.json'") &&
        portableScript.includes('scripts/validate-release-package.js'),
      'portable packages are stateless and validated before distribution'
    );
  }

  // ─── 25. Audit management calls use authenticated local helper ───
  {
    const bridge = fs.readFileSync(
      path.join(__dirname, '..', 'tauri-ui', 'src', 'modules', 'app-bridge.js'),
      'utf8'
    );
    assert.ok(
      bridge.includes('const fetchLocalJsonWithAuth = async'),
      'bridge provides an authenticated local management JSON helper'
    );
    assert.ok(
      bridge.includes("invoke('clear_audit_conversations_native'"),
      'clear audit can use the native Tauri management-token path before HTTP fallback'
    );
    const rust = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8');
    assert.ok(
      rust.includes('fn clear_audit_conversations_native(') &&
        rust.includes('clear_audit_conversations_native,'),
      'native clear-audit command is registered'
    );
    const auditBridgeStart = bridge.indexOf('readAuditConversations: async');
    const auditBridgeEnd = bridge.indexOf('  };', auditBridgeStart);
    assert.ok(
      auditBridgeStart > 0 && auditBridgeEnd > auditBridgeStart,
      'audit bridge methods found'
    );
    const auditBridgeSection = bridge.slice(auditBridgeStart, auditBridgeEnd);
    assert.ok(
      /fetchLocalJsonWithAuth\(\s*'\/v1\/local\/audit\/conversations\/clear'/.test(
        auditBridgeSection
      ),
      'clear audit calls the authenticated helper'
    );
    assert.ok(
      /fetchLocalJsonWithAuth\(\s*'\/v1\/local\/audit\/retry'/.test(auditBridgeSection),
      'audit retry calls the authenticated helper'
    );
    assert.ok(
      /fetchLocalJsonWithAuth\(\s*'\/v1\/local\/usage\/report\?/.test(auditBridgeSection),
      'usage report calls the authenticated helper'
    );
  }

  // ─── 26. Windows launch-on-login uses typed native commands ─────
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'tauri-ui', 'index.html'), 'utf8');
    const app = readAppSource();
    const bridge = fs.readFileSync(
      path.join(__dirname, '..', 'tauri-ui', 'src', 'modules', 'app-bridge.js'),
      'utf8'
    );
    const rust = ['lib.rs', 'launch_on_login.rs']
      .map((file) => fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', file), 'utf8'))
      .join('\n');
    const permissions = fs.readFileSync(
      path.join(__dirname, '..', 'src-tauri', 'permissions', 'app-commands.toml'),
      'utf8'
    );
    assert.ok(html.includes('id="launchOnLogin"'), 'settings page exposes launch-on-login');
    assert.ok(app.includes('async function refreshLaunchOnLogin()'), 'native state is queried');
    assert.ok(app.includes('async function applyLaunchOnLogin()'), 'requested state is verified');
    assert.ok(
      app.includes("typeof window.proxyManager.setLaunchOnLogin !== 'function'") &&
        app.includes('config.appSettings.launchOnLogin = false;'),
      'browser fallback can still save unrelated application settings'
    );
    assert.ok(
      bridge.includes("invoke('get_launch_on_login')") &&
        bridge.includes("invoke('set_launch_on_login', { enabled })"),
      'bridge uses dedicated typed Tauri commands'
    );
    assert.ok(
      rust.includes('HKEY_CURRENT_USER') && rust.includes('WINDOWS_RUN_VALUE_NAME'),
      'startup entry is scoped to the current Windows user'
    );
    assert.ok(
      permissions.includes('"get_launch_on_login"') &&
        permissions.includes('"set_launch_on_login"'),
      'Tauri ACL permits both launch-on-login commands'
    );
  }

  // ─── 27. Entry server transport is explicit and round-trips TLS state ─
  {
    const app = readAppSource();
    assert.ok(
      app.includes("select.dataset.entryTransport = ''"),
      'entry rows expose a dedicated HTTP/HTTPS transport selector'
    );
    assert.ok(
      app.includes("appendOption(select, 'https', 'HTTPS（TLS）')") &&
        app.includes("appendOption(select, 'http', 'HTTP（明文）')"),
      'transport choices identify encrypted and plaintext modes'
    );
    assert.ok(
      app.includes("const transport = row.querySelector('[data-entry-transport]').value") &&
        app.includes("tls: protocol === 'claude-desktop' ? false : transport === 'https'"),
      'saving entry rows preserves the selected transport instead of forcing HTTPS'
    );
    assert.ok(
      app.includes("usesTls ? 'HTTPS · TLS' : 'HTTP · 明文'"),
      'entry headers show an unambiguous transport badge'
    );
    assert.ok(
      app.includes("createEntryTransportGroup('https', groupedEntries.https)") &&
        app.includes("createEntryTransportGroup('http', groupedEntries.http)"),
      'entry rows are visibly grouped into HTTPS and HTTP sections'
    );
    assert.ok(
      app.includes('listenPort: 3080') &&
        app.includes('listenPort: 3082') &&
        app.includes('listenPort: 3084'),
      'frontend defaults include all plaintext HTTP entry ports'
    );
    const html = fs.readFileSync(path.join(__dirname, '..', 'tauri-ui', 'index.html'), 'utf8');
    assert.ok(
      html.includes('HTTPS 与 HTTP 入口') && html.includes('HTTP 为明文传输'),
      'entry guidance describes both transports and the HTTP safety boundary'
    );
  }

  console.log('app-ux.test.js ok (27 scenarios)');
})().catch((err) => {
  console.error('app-ux.test.js FAILED:', err);
  process.exit(1);
});
