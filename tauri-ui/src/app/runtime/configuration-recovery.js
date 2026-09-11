// One recovery request at a time; unavailable backends never overwrite config.
export function createConfigurationRecovery({
  read,
  isLoaded,
  apply,
  onState,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  for (const callback of [read, isLoaded, apply, onState, schedule, cancel]) {
    if (typeof callback !== 'function') throw new TypeError('Recovery requires callbacks');
  }
  let pending = null;
  let timer = null;
  let attempts = 0;
  let stopped = false;
  function clearRetry() {
    if (timer !== null) cancel(timer);
    timer = null;
  }
  function run() {
    if (stopped) return Promise.resolve(false);
    if (pending) return pending;
    clearRetry();
    if (isLoaded()) {
      onState({ phase: 'connected', attempts });
      return Promise.resolve(true);
    }
    attempts += 1;
    onState({ phase: 'connecting', attempts });
    pending = Promise.resolve()
      .then(read)
      .then((value) => {
        if (stopped) return false;
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          value.__fallback ||
          !Array.isArray(value.profiles) ||
          !Array.isArray(value.modelRoutes)
        ) {
          throw new Error('Configuration is unavailable');
        }
        apply(value);
        attempts = 0;
        onState({ phase: 'connected', attempts });
        return true;
      })
      .catch(() => {
        if (!stopped) {
          const retryMs = Math.min(30000, 1000 * 2 ** Math.min(attempts - 1, 5));
          onState({ phase: 'waiting', attempts, retryMs });
          timer = schedule(() => {
            timer = null;
            void run();
          }, retryMs);
        }
        return false;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }
  function stop() {
    stopped = true;
    clearRetry();
  }
  return { run, stop };
}

export function createConfigurationRecoveryView(document, reconnect, onConnected = () => {}) {
  let connected = false;
  return ({ phase, attempts, retryMs }) => {
    let panel = document.getElementById('configurationRecovery');
    if (phase === 'connected') {
      panel?.remove();
      if (!connected) {
        connected = true;
        onConnected();
      }
      return;
    }
    connected = false;
    const summary = document.getElementById('summary');
    if (!summary) return;
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'configurationRecovery';
      const status = document.createElement('span');
      status.setAttribute('role', 'status');
      const button = document.createElement('button');
      button.id = 'reconnectConfiguration';
      button.type = 'button';
      button.textContent = '重新连接';
      button.addEventListener('click', reconnect);
      panel.append(status, button);
      summary.after(panel);
    }
    panel.firstChild.textContent =
      phase === 'connecting'
        ? `正在自动重连（第 ${attempts} 次）… `
        : `连接暂不可用，${Math.ceil(retryMs / 1000)} 秒后自动重试；原配置保留。 `;
    panel.lastChild.disabled = phase === 'connecting';
  };
}
