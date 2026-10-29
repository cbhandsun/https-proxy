/**
 * 配置文件热重载：debounce + lock + 重试
 *
 * 设计:
 *   - 多次连续变更（编辑器通常一次保存触发 2-3 次 change）合并到 150ms 窗口
 *   - 同一时刻只允许一个 reload 进行中（防止竞争）
 *   - Windows 上文件可能被原子写入短暂占用，EBUSY/EPERM 自动重试
 *   - 文件不存在/解析失败时不覆盖现有配置
 *   - emit('reloaded', { config }) / emit('error', err) 事件回调
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_RETRY_DELAY_MS = 60;
const DEFAULT_MAX_RETRIES = 5;

function configWatchEventMatches(basename, event, filename, platform = process.platform) {
  if (event !== 'change' && event !== 'rename') return false;
  if (
    typeof basename !== 'string' ||
    !basename ||
    basename.length > 4096 ||
    basename === '.' ||
    basename === '..' ||
    /[\\/\0]/.test(basename)
  )
    return false;
  // Node may omit the filename. Always reload the fixed config path; never
  // derive a read path from a directory notification.
  if (filename == null) return true;
  if (Buffer.isBuffer(filename)) {
    if (filename.length > 4096) return false;
    filename = filename.toString('utf8');
  }
  if (typeof filename !== 'string' || filename.length > 4096) return false;
  return platform === 'win32'
    ? filename.toLowerCase() === basename.toLowerCase()
    : filename === basename;
}

function debounceReload(filePath, reloadFn, options = {}) {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const loadConfigFn = typeof options.loadConfigFn === 'function' ? options.loadConfigFn : null;

  const emitter = new EventEmitter();
  let debounceTimer = null;
  let retryTimer = null;
  let resolveRetry = null;
  let reloadInProgress = false;
  let pendingAfterCurrent = false;
  let watcher = null;
  let directoryWatcher = null;
  let watchedIdentity;
  let closed = false;

  function emitError(err) {
    if (closed) return;
    onError(err);
    if (emitter.listenerCount('error') > 0) {
      emitter.emit('error', err);
    }
  }

  function scheduleReload() {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(tryReload, debounceMs);
  }

  function tryReload() {
    if (closed) return;
    if (reloadInProgress) {
      // 标记在当前 reload 完成后还需再跑一次（合并新的变更）
      pendingAfterCurrent = true;
      return;
    }
    reloadInProgress = true;
    performReload(0)
      .then((result) => {
        if (closed) return;
        if (result && result.ok) {
          emitter.emit('reloaded', { config: result.config });
        } else if (result && result.error) {
          emitError(result.error);
        }
      })
      .catch((err) => {
        emitError(err);
      })
      .finally(() => {
        reloadInProgress = false;
        if (pendingAfterCurrent) {
          pendingAfterCurrent = false;
          scheduleReload();
        }
      });
  }

  function performReload(attempt) {
    if (closed) return Promise.resolve({ ok: false });
    return new Promise((resolve) => {
      fs.readFile(filePath, 'utf8', (readErr, raw) => {
        if (closed) return resolve({ ok: false });
        if (readErr) {
          // 短暂文件占用:重试
          if (
            (readErr.code === 'EBUSY' || readErr.code === 'EPERM' || readErr.code === 'EACCES') &&
            attempt < maxRetries
          ) {
            resolveRetry = resolve;
            retryTimer = setTimeout(() => {
              retryTimer = null;
              resolveRetry = null;
              performReload(attempt + 1).then(resolve);
            }, retryDelayMs);
            return;
          }
          return resolve({ ok: false, error: readErr });
        }
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (parseErr) {
          return resolve({ ok: false, error: parseErr });
        }
        let loadedConfig = parsed;
        Promise.resolve()
          .then(() => (closed ? undefined : loadConfigFn ? loadConfigFn(parsed) : parsed))
          .then((config) => {
            if (closed) return;
            loadedConfig = config || parsed;
            return reloadFn(loadedConfig);
          })
          .then((updated) => {
            resolve(closed ? { ok: false } : { ok: true, config: updated || loadedConfig });
          })
          .catch((applyErr) => {
            resolve({ ok: false, error: applyErr });
          });
      });
    });
  }

  function fileIdentity() {
    const stat = fs.statSync(filePath, { bigint: true });
    if (!stat.isFile()) throw new TypeError('Invalid configuration file');
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  }

  function attachFileWatcher(identity) {
    const next = fs.watch(filePath, (event) => {
      if (event === 'change' || event === 'rename') scheduleReload();
    });
    next.on('error', (err) => {
      if (!closed) emitError(err);
    });
    const previous = watcher;
    watcher = next;
    watchedIdentity = identity;
    previous?.close();
  }

  function observeReplacement() {
    if (closed) return;
    try {
      const identity = fileIdentity();
      if (identity !== watchedIdentity) {
        attachFileWatcher(identity);
        scheduleReload();
      }
    } catch (err) {
      emitError(err);
    }
  }

  try {
    // File notifications retain the original debounce behavior for ordinary
    // edits. The directory listener only rebinds after physical replacement;
    // coalesced directory events must not replace the faster file events.
    attachFileWatcher(fileIdentity());
    const basename = path.basename(filePath);
    directoryWatcher = fs.watch(path.dirname(path.resolve(filePath)), (event, filename) => {
      if (configWatchEventMatches(basename, event, filename)) observeReplacement();
    });
    directoryWatcher.on('error', (err) => {
      if (!closed) emitError(err);
    });
    observeReplacement();
  } catch (err) {
    watcher?.close();
    watcher = null;
    directoryWatcher?.close();
    directoryWatcher = null;
    emitError(err);
  }

  emitter.close = function () {
    closed = true;
    pendingAfterCurrent = false;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
      resolveRetry?.({ ok: false });
      resolveRetry = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (watcher && typeof watcher.close === 'function') {
      try {
        watcher.close();
      } catch (e) {
        /* ignore */
      }
      watcher = null;
    }
    directoryWatcher?.close();
    directoryWatcher = null;
  };

  emitter.scheduleNow = function () {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    tryReload();
  };
  return emitter;
}

module.exports = {
  configWatchEventMatches,
  debounceReload,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_MAX_RETRIES,
};
