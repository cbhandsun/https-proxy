// Tests for tauri-ui/app-ux.js — P3 体验增强 (通知/主题/延迟加载)
// 在 Node 中以 vm 沙箱执行 app-ux.js，注入最小 window/Notification/localStorage。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
  const src = fs.readFileSync(path.join(__dirname, '..', 'tauri-ui', 'app-ux.js'), 'utf8');
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

  console.log('app-ux.test.js ok (6 scenarios)');
})().catch((err) => {
  console.error('app-ux.test.js FAILED:', err);
  process.exit(1);
});
