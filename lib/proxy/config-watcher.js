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
const { EventEmitter } = require('events');

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_RETRY_DELAY_MS = 60;
const DEFAULT_MAX_RETRIES = 5;

function debounceReload(filePath, reloadFn, options = {}) {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const onError = typeof options.onError === 'function' ? options.onError : () => {};

  const emitter = new EventEmitter();
  let debounceTimer = null;
  let reloadInProgress = false;
  let pendingAfterCurrent = false;
  let watcher = null;
  let closed = false;

  function emitError(err) {
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
    return new Promise((resolve) => {
      fs.readFile(filePath, 'utf8', (readErr, raw) => {
        if (readErr) {
          // 短暂文件占用:重试
          if (
            (readErr.code === 'EBUSY' || readErr.code === 'EPERM' || readErr.code === 'EACCES') &&
            attempt < maxRetries
          ) {
            setTimeout(() => performReload(attempt + 1).then(resolve), retryDelayMs);
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
        Promise.resolve()
          .then(() => reloadFn(parsed))
          .then((updated) => {
            resolve({ ok: true, config: updated || parsed });
          })
          .catch((applyErr) => {
            resolve({ ok: false, error: applyErr });
          });
      });
    });
  }

  try {
    watcher = fs.watch(filePath, (event) => {
      if (event === 'change' || event === 'rename') {
        scheduleReload();
      }
    });
    watcher.on('error', (err) => {
      emitError(err);
    });
  } catch (err) {
    emitError(err);
  }

  emitter.close = function () {
    closed = true;
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
  debounceReload,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_MAX_RETRIES,
};
