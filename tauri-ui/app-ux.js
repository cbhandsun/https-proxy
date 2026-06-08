// tauri-ui/app-ux.js
// P3 体验增强：桌面通知、深色主题自动模式、IntersectionObserver 延迟加载。
// 旧式全局脚本：window.* 形式暴露给 app.js 与其它模块调用。

(function () {
  'use strict';

  // ─── 桌面通知 ────────────────────────────────────────────────────
  // - 仅在用户授权后展示。授权失败（被拒/不支持）时静默降级为 toast。
  // - 同一秒内的相同标题只展示一次，避免托盘/启动/重启导致的连发。
  const notifState = { permission: null, lastKey: null, lastAt: 0 };

  function canNotify() {
    return typeof window !== 'undefined' && 'Notification' in window;
  }

  async function ensureNotificationPermission() {
    if (!canNotify()) return 'unsupported';
    if (notifState.permission) return notifState.permission;
    if (Notification.permission === 'granted') {
      notifState.permission = 'granted';
      return 'granted';
    }
    if (Notification.permission === 'denied') {
      notifState.permission = 'denied';
      return 'denied';
    }
    try {
      const result = await Notification.requestPermission();
      notifState.permission = result;
      return result;
    } catch (_err) {
      notifState.permission = 'denied';
      return 'denied';
    }
  }

  function notify(title, options = {}) {
    if (!canNotify()) return false;
    const body = typeof options.body === 'string' ? options.body : '';
    const tag = typeof options.tag === 'string' ? options.tag : title;
    const now = Date.now();
    if (notifState.lastKey === tag && now - notifState.lastAt < 1500) {
      return false;
    }
    notifState.lastKey = tag;
    notifState.lastAt = now;

    ensureNotificationPermission().then((perm) => {
      if (perm !== 'granted') return;
      try {
        const n = new Notification(title, {
          body,
          tag,
          icon: options.icon,
          silent: options.silent === true,
        });
        if (typeof options.onclick === 'function') {
          n.onclick = options.onclick;
        }
        if (typeof options.onclose === 'function') {
          n.onclose = options.onclose;
        }
        // 默认 6s 自动关闭
        const ttl = typeof options.ttl === 'number' ? options.ttl : 6000;
        setTimeout(() => n.close(), ttl);
      } catch (_err) {
        // 通知实例化失败时静默忽略
      }
    });

    return true;
  }

  // ─── 主题：light / dark / auto ──────────────────────────────────
  // - auto 模式监听 prefers-color-scheme 变化并自动切换。
  // - 主题值持久化到 localStorage.theme。
  const THEME_KEY = 'theme';
  const THEME_MODES = ['light', 'dark', 'auto'];
  let currentThemeMode = 'auto';
  let mqListener = null;

  function detectSystemTheme() {
    if (typeof window === 'undefined' || !window.matchMedia) return 'light';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyThemeMode(mode) {
    if (!THEME_MODES.includes(mode)) mode = 'auto';
    currentThemeMode = mode;
    const resolved = mode === 'auto' ? detectSystemTheme() : mode;
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.setAttribute('data-theme-mode', mode);
    try {
      window.localStorage.setItem(THEME_KEY, mode);
    } catch (_err) {
      // localStorage 可能被禁用；静默忽略
    }
    updateThemeIcons(resolved, mode);
    attachMediaListenerIfNeeded(mode);
  }

  function attachMediaListenerIfNeeded(mode) {
    if (mode !== 'auto') {
      if (mqListener && typeof mqListener.removeEventListener === 'function') {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        mq.removeEventListener('change', mqListener);
      }
      mqListener = null;
      return;
    }
    if (mqListener || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mqListener = (event) => {
      const resolved = event.matches ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', resolved);
      updateThemeIcons(resolved, 'auto');
    };
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', mqListener);
    } else if (typeof mq.addListener === 'function') {
      mq.addListener(mqListener);
    }
  }

  function updateThemeIcons(resolved, mode) {
    const sun = document.getElementById('themeIconSun');
    const moon = document.getElementById('themeIconMoon');
    const autoBadge = document.getElementById('themeAutoBadge');
    if (sun) sun.style.display = resolved === 'dark' ? 'block' : 'none';
    if (moon) moon.style.display = resolved === 'dark' ? 'none' : 'block';
    if (autoBadge) autoBadge.style.display = mode === 'auto' ? 'inline-flex' : 'none';
  }

  function readStoredThemeMode() {
    try {
      const stored = window.localStorage.getItem(THEME_KEY);
      if (THEME_MODES.includes(stored)) return stored;
    } catch (_err) {
      // 忽略
    }
    return 'auto';
  }

  function initTheme() {
    applyThemeMode(readStoredThemeMode());
  }

  function cycleTheme() {
    const idx = THEME_MODES.indexOf(currentThemeMode);
    const next = THEME_MODES[(idx + 1) % THEME_MODES.length];
    applyThemeMode(next);
    return next;
  }

  function getThemeMode() {
    return currentThemeMode;
  }

  // ─── 延迟加载：IntersectionObserver 包装 ─────────────────────────
  // - 元素进入视口时调用 loader()，执行后取消观察。
  // - 若浏览器不支持 IntersectionObserver，则在 requestIdleCallback 中
  //   立即执行；再降级到 setTimeout。
  function whenIdle(fn, timeout = 1500) {
    if (typeof window.requestIdleCallback === 'function') {
      return window.requestIdleCallback(fn, { timeout });
    }
    return setTimeout(fn, Math.min(timeout, 250));
  }

  function lazyOnVisible(element, loader, options = {}) {
    if (!element || typeof loader !== 'function') return () => {};
    const rootMargin = options.rootMargin || '200px';
    const threshold = options.threshold || 0;
    let observed = true;

    function trigger() {
      if (!observed) return;
      observed = false;
      if (observer && typeof observer.disconnect === 'function') observer.disconnect();
      try {
        loader();
      } catch (_err) {
        // loader 内部应该自己处理错误；这里不再吞
      }
    }

    let observer = null;
    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              trigger();
              break;
            }
          }
        },
        { rootMargin, threshold }
      );
      observer.observe(element);
    } else {
      // 降级：等空闲后立即触发
      whenIdle(trigger, 500);
    }

    return function cancel() {
      observed = false;
      if (observer && typeof observer.disconnect === 'function') observer.disconnect();
    };
  }

  // 动态加载外部脚本（chart.js 等），Promise 形式，缓存结果。
  const scriptCache = new Map();
  function loadScript(src) {
    if (scriptCache.has(src)) return scriptCache.get(src);
    const promise = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-lazy-src="${src}"]`);
      if (existing) {
        if (existing.dataset.loaded === '1') {
          resolve();
        } else {
          existing.addEventListener('load', () => resolve(), { once: true });
          existing.addEventListener('error', () => reject(new Error('script load failed')), {
            once: true,
          });
        }
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.defer = true;
      s.dataset.lazySrc = src;
      s.addEventListener(
        'load',
        () => {
          s.dataset.loaded = '1';
          resolve();
        },
        { once: true }
      );
      s.addEventListener('error', () => reject(new Error('script load failed')), { once: true });
      document.head.appendChild(s);
    });
    scriptCache.set(src, promise);
    return promise;
  }

  // ─── 公开 API ────────────────────────────────────────────────────
  window.UX = {
    notify,
    ensureNotificationPermission,
    canNotify: canNotify,
    theme: {
      init: initTheme,
      apply: applyThemeMode,
      cycle: cycleTheme,
      getMode: getThemeMode,
      MODES: THEME_MODES,
    },
    lazyOnVisible,
    loadScript,
    whenIdle,
  };
})();
