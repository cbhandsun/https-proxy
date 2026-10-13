'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { getWorkBuddyExecutablePath } = require('./workbuddy-official');

const unavailableStatuses = new Set([
  'not_available',
  'method_unavailable',
  'host_start_failed',
  'host_recovery_timeout',
  'host_recovery_cooldown',
]);
const isWorkBuddyHostUnavailable = (status) => unavailableStatuses.has(status);

function boundedMilliseconds(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' && typeof value !== 'string') return fallback;
  if (typeof value === 'string' && !value.trim()) return fallback;
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(maximum, Math.max(minimum, Math.trunc(number)))
    : fallback;
}

async function startWorkBuddyHost(options = {}) {
  const exePath = options.exePath || getWorkBuddyExecutablePath();
  const exists = options.exists || fs.existsSync;
  const launch = options.spawn || spawn;
  const { signal } = options;
  if (signal?.aborted) return { status: 'cancelled' };
  try {
    if (!exists(exePath)) return { status: 'missing_executable' };
    return await new Promise((resolve) => {
      const child = launch(exePath, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      let settled = false;
      const finish = (status) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', cancel);
        resolve({ status });
      };
      const cancel = () => finish('cancelled');
      // Keep the error listener after spawn: detached child failures must not crash the proxy.
      child.on('error', () => finish('start_failed'));
      child.once('spawn', () => {
        child.unref();
        finish('started');
      });
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  } catch (_error) {
    return { status: 'start_failed' };
  }
}

function wait(milliseconds, signal) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

function createWorkBuddyHostRecovery(options = {}) {
  const timeoutMs = boundedMilliseconds(options.timeoutMs, 30000, 100, 60000);
  const intervalMs = boundedMilliseconds(options.intervalMs, 250, 10, 1000);
  const cooldownMs = boundedMilliseconds(options.cooldownMs, 30000, 0, 300000);
  const startHost = options.startHost || startWorkBuddyHost;
  let flight = null;
  let cooldownUntil = 0;

  async function recover(probe, signal) {
    try {
      const trigger = await startHost({ signal });
      if (signal.aborted) return 'host_recovery_timeout';
      if (!trigger || !['started', 'already_running'].includes(trigger.status))
        return 'host_start_failed';
      while (!signal.aborted) {
        const state = await probe(signal);
        if (signal.aborted) break;
        if (state === 'ready') return 'ready';
        if (['endpoint_untrusted', 'handshake_failed', 'protocol_error'].includes(state))
          return state;
        await wait(intervalMs, signal);
      }
      return 'host_recovery_timeout';
    } catch (_error) {
      return 'host_start_failed';
    }
  }

  function ensureReady(probe, signal) {
    if (signal?.aborted) return Promise.resolve('cancelled');
    if (!flight) {
      if (Date.now() < cooldownUntil) return Promise.resolve('host_recovery_cooldown');
      const controller = new globalThis.AbortController();
      const active = { controller, waiters: 0, promise: null, expired: false };
      flight = active;
      active.promise = new Promise((resolve) => {
        let settled = false;
        const finish = (state) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', onAbort);
          resolve(state);
        };
        const onAbort = () => finish(active.expired ? 'host_recovery_timeout' : 'cancelled');
        const timer = setTimeout(() => {
          active.expired = true;
          controller.abort();
        }, timeoutMs);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        recover(probe, controller.signal).then(finish);
      }).then((state) => {
        controller.abort();
        if (state !== 'ready' && state !== 'cancelled') cooldownUntil = Date.now() + cooldownMs;
        if (flight === active) flight = null;
        return state;
      });
    }
    const active = flight;
    active.waiters++;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (state) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', cancel);
        active.waiters--;
        if (!active.waiters) active.controller.abort();
        resolve(state);
      };
      const cancel = () => finish('cancelled');
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      active.promise.then(finish);
    });
  }
  return { ensureReady, isRecovering: () => flight !== null };
}

const defaultWorkBuddyHostRecovery = createWorkBuddyHostRecovery();
module.exports = {
  createWorkBuddyHostRecovery,
  defaultWorkBuddyHostRecovery,
  startWorkBuddyHost,
  isWorkBuddyHostUnavailable,
};
