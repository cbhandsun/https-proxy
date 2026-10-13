'use strict';

const PROXY_IDLE_TEXT = 'Tianxi native stream is still open; waiting for further output.\n';

function hasNativeProgress(frame) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return false;
  if (['act_exec', 'act_resp'].includes(frame.type)) return true;
  if (frame.type !== 'task_output' || !frame.data || typeof frame.data !== 'object') return false;
  if (frame.data.content_type === 'summary' && frame.data.content === PROXY_IDLE_TEXT) return false;
  return [
    'content',
    'delta',
    'text',
    'answer',
    'result',
    'reasoning_content',
    'thinking_content',
  ].some((key) => {
    const value = frame.data[key];
    return typeof value === 'string'
      ? value.trim().length > 0
      : Array.isArray(value) &&
          value.some(
            (part) =>
              part &&
              typeof part === 'object' &&
              typeof part.text === 'string' &&
              part.text.trim().length > 0
          );
  });
}

// Only budget waiting on the provider. Client approval and command execution
// consume neither this inactivity deadline nor provider progress notifications.
function createTianxiClientToolWait({
  idleTimeoutMs = 300000,
  noticeAfterMs = 30000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onWaiting,
  onTimeout,
} = {}) {
  if (
    !Number.isSafeInteger(idleTimeoutMs) ||
    idleTimeoutMs < 1 ||
    idleTimeoutMs > 3600000 ||
    !Number.isSafeInteger(noticeAfterMs) ||
    noticeAfterMs < 1 ||
    noticeAfterMs >= idleTimeoutMs ||
    typeof setTimer !== 'function' ||
    typeof clearTimer !== 'function' ||
    typeof onWaiting !== 'function' ||
    typeof onTimeout !== 'function'
  )
    throw new TypeError('Invalid Tianxi client wait policy');
  let noticeTimer,
    deadlineTimer,
    active = false,
    closed = false,
    generation = 0;
  function pause() {
    active = false;
    generation++;
    if (noticeTimer !== undefined) clearTimer(noticeTimer);
    if (deadlineTimer !== undefined) clearTimer(deadlineTimer);
    noticeTimer = deadlineTimer = undefined;
  }
  function resume() {
    if (closed) return;
    pause();
    active = true;
    const current = generation;
    noticeTimer = setTimer(() => {
      if (active && !closed && current === generation) onWaiting();
    }, noticeAfterMs);
    deadlineTimer = setTimer(() => {
      if (!active || closed || current !== generation) return;
      pause();
      onTimeout();
    }, idleTimeoutMs);
    noticeTimer?.unref?.();
    deadlineTimer?.unref?.();
  }
  return {
    resume,
    pause,
    progress(frame) {
      if (active && hasNativeProgress(frame)) resume();
    },
    close() {
      closed = true;
      pause();
    },
  };
}

module.exports = { createTianxiClientToolWait, hasNativeProgress };
