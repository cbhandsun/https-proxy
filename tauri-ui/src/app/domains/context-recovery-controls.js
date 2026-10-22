const messages = Object.freeze({
  idle: '',
  confirming: '等待确认清除范围。',
  clearing: '正在撤销恢复权限并清除代理原文，请稍候。',
  cleared: '代理恢复原文已清除。新的捕获继续遵循已保存设置；插件、客户端聊天和审计日志不受影响。',
  failed: '未确认清除完成，请检查代理运行状态与管理权限。',
  unknown: '清除结果未知，操作可能仍在执行。请检查代理运行状态，勿重复提交。',
  not_started: '本次清除未执行。请检查管理连接与浏览器会话存储后重新确认。',
  cancelled: '未启动的清除操作已撤销；延迟到达的旧启动请求不会执行，原文未因此清除。',
  dismissed: '已结束本页查询；这不会取消后台清除，也不确认旧操作结果。再次清除需要重新确认。',
});

function clearAcknowledged(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  const ok = Object.getOwnPropertyDescriptor(value, 'ok');
  const scope = Object.getOwnPropertyDescriptor(value, 'scope');
  return keys === 'ok,scope' && ok?.value === true && scope?.value === 'proxy_context_recovery';
}

// One management action, never retried. A transport failure cannot prove that
// the server did not already commit; native IPC may ignore AbortSignal.
export async function requestContextRecoveryClear({
  fetchRequest,
  getApiBase,
  setTimer = setTimeout,
  cancelTimer = clearTimeout,
}) {
  const controller = new AbortController();
  let timer;
  try {
    const expiry = new Promise((resolve) => {
      timer = setTimer(() => {
        controller.abort();
        resolve('unknown');
      }, 10000);
    });
    const action = (async () => {
      const response = await fetchRequest(`${getApiBase()}/v1/local/context-recovery/clear`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
        signal: controller.signal,
      });
      if (!response.ok) return 'failed';
      const value = await response.json();
      return clearAcknowledged(value) ? 'cleared' : 'unknown';
    })();
    return await Promise.race([action, expiry]);
  } catch {
    return 'unknown';
  } finally {
    cancelTimer(timer);
  }
}

export function bindContextRecoveryControls({
  getElement,
  confirmAction,
  requestClear,
  readClearStatus,
  cancelPending,
  dismissPending,
  hasPending = () => false,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
}) {
  const button = getElement('clearContextRecovery');
  const status = getElement('contextRecoveryClearStatus');
  const refresh = getElement('refreshContextRecoveryClear');
  const cancel = getElement('cancelContextRecoveryClear');
  const dismiss = getElement('dismissContextRecoveryClear');
  let state = 'idle';
  let checking = false;
  let mutating = false;
  let timer = null;
  let polls = 0;
  const accepted = (value) =>
    ['cleared', 'clearing', 'cancelled', 'failed', 'not_started', 'unknown'].includes(value)
      ? value
      : 'unknown';
  function stopPolling() {
    if (timer !== null) cancelSchedule(timer);
    timer = null;
  }
  function render(next) {
    state = next;
    const pending = hasPending();
    button.disabled = checking || mutating || ['confirming', 'clearing', 'unknown'].includes(next);
    button.setAttribute('aria-busy', String(checking || mutating || next === 'clearing'));
    status.textContent = messages[next];
    refresh.hidden = cancel.hidden = dismiss.hidden = !pending;
    refresh.disabled = cancel.disabled = dismiss.disabled = checking || mutating;
    stopPolling();
    // Only GET queries are scheduled. Unknown outcomes stop automatic checks;
    // after 30 queries the explicit query button remains available.
    if (
      pending &&
      next === 'clearing' &&
      !checking &&
      !mutating &&
      polls < 30 &&
      typeof readClearStatus === 'function'
    ) {
      timer = schedule(() => {
        timer = null;
        polls++;
        void refresh.onclick();
      }, 1000);
    }
  }
  refresh.onclick = async () => {
    if (checking || mutating || !hasPending() || typeof readClearStatus !== 'function') return;
    checking = true;
    render(state);
    try {
      render(accepted(await readClearStatus()));
    } catch {
      render('unknown');
    } finally {
      checking = false;
      render(state);
    }
  };
  cancel.onclick = async () => {
    if (checking || mutating || !hasPending() || typeof cancelPending !== 'function') return;
    mutating = true;
    render(state);
    try {
      const confirmed = await confirmAction({
        title: '撤销尚未启动的清除操作？',
        message:
          '只撤销尚未启动的操作编号，阻止延迟启动。已经运行的清除会继续，不能由此恢复原文；请求不确定时仍需查询。',
        confirmText: '撤销未启动操作',
      });
      if (confirmed === true) render(accepted(await cancelPending()));
    } catch {
      render('unknown');
    } finally {
      mutating = false;
      render(state);
    }
  };
  dismiss.onclick = async () => {
    if (checking || mutating || !hasPending() || typeof dismissPending !== 'function') return;
    mutating = true;
    render(state);
    try {
      const confirmed = await confirmAction({
        title: '结束本页结果查询？',
        message:
          '这只移除本页保存的操作编号，不取消后台清除，也不代表旧操作成功或失败。若旧操作仍在运行，它会继续。再次清除将是一次需要重新确认的新操作。',
        confirmText: '结束查询',
      });
      if (confirmed === true) render(dismissPending() === true ? 'dismissed' : 'unknown');
    } catch {
      render('unknown');
    } finally {
      mutating = false;
      render(state);
    }
  };
  render('idle');
  button.onclick = async () => {
    if (checking || mutating || ['confirming', 'clearing', 'unknown'].includes(state)) return;
    mutating = true;
    render('confirming');
    try {
      const confirmed = await confirmAction({
        title: '清除代理上下文恢复数据？',
        message:
          '这会撤销代理恢复权限并清除已留存原文，不清除插件独立数据、客户端聊天或审计日志。新数据仍按已保存设置捕获；若需停止捕获，请先关闭自动恢复并保存。',
        confirmText: '清除恢复数据',
        danger: true,
      });
      if (confirmed !== true) {
        mutating = false;
        render('idle');
        return;
      }
    } catch {
      mutating = false;
      render('failed');
      return;
    }
    render('clearing');
    polls = 0;
    try {
      const result = await requestClear();
      render(accepted(result));
    } catch {
      render('unknown');
    } finally {
      mutating = false;
      render(state);
    }
  };
  if (hasPending()) {
    render('unknown');
    void refresh.onclick();
  }
}
