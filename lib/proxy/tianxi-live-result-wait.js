'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { AbortController } = globalThis;
let activeNativeTasks = 0;

function trackTianxiNativeTask() {
  activeNativeTasks++;
  let ended = false;
  return () => {
    if (!ended) {
      ended = true;
      activeNativeTasks--;
    }
  };
}

function getActiveTianxiNativeTasks() {
  return activeNativeTasks;
}

async function waitTianxiResultContinuation(cache, owner, references, clientRes, options = {}) {
  const controller = new AbortController();
  const onClose = () => {
    if (!clientRes.writableEnded) {
      cache.cancelContinuation(owner, references);
      controller.abort();
    }
  };
  clientRes.on?.('close', onClose);
  try {
    const timeout =
      Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
        ? Math.min(options.timeoutMs, 300000)
        : 300000;
    const deadline = Date.now() + timeout;
    let lastHeartbeat = 0;
    while (!controller.signal.aborted && !clientRes.destroyed) {
      const retained = cache.continuation(owner, references);
      if (!retained || retained.nextCall || retained.status !== 'in_progress') return retained;
      if (Date.now() >= deadline) {
        cache.cancelContinuation(owner, references);
        return cache.continuation(owner, references);
      }
      if (options.stream === true && Date.now() - lastHeartbeat >= 15000) {
        if (!clientRes.headersSent)
          clientRes.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          });
        clientRes.write(': tianxi-result-waiting\n\n');
        lastHeartbeat = Date.now();
      }
      await delay(100, undefined, { signal: controller.signal });
    }
    cache.cancelContinuation(owner, references);
    return null;
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    return null;
  } finally {
    clientRes.off?.('close', onClose);
  }
}

module.exports = {
  waitTianxiResultContinuation,
  trackTianxiNativeTask,
  getActiveTianxiNativeTasks,
};
