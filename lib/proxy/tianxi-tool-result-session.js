'use strict';

const { createTianxiResultCall } = require('./tianxi-tool-result-continuation');
const { tianxiResultDetails } = require('./tianxi-tool-result-details');

function createTianxiToolResultSession(cache, owner, options = {}) {
  const serial = options.parallelToolCalls === false;
  const taskId = cache.begin(
    owner,
    serial
      ? {
          serialResultTool: options.resultTool ?? {
            namespace: 'mcp__tianxi_progress',
            name: 'read_result',
          },
        }
      : {}
  );
  if (!taskId) return null;
  const calls = new Map();
  let firstFinished = false;
  return {
    get readyForHandoff() {
      return serial && options.live === true && firstFinished;
    },
    enableLive(model, cancel) {
      return cache.enableLive(owner, taskId, model, cancel);
    },
    get hasCalls() {
      return calls.size > 0;
    },
    start(nativeId, name, target = '') {
      // Missing upstream identities cannot safely correlate starts and returns.
      if (nativeId === 'tianxi_action') return null;
      const previous = calls.get(nativeId);
      if (previous) return previous;
      const operation = cache.start(owner, taskId, nativeId, name, { target });
      if (!operation) return null;
      const call = createTianxiResultCall(operation.reference, options.resultTool, operation.tool);
      calls.set(nativeId, call);
      return call;
    },
    shouldEmit(call) {
      return !serial || call === calls.values().next().value;
    },
    finish(nativeId, phase, result) {
      const record = cache.operation(owner, taskId, nativeId);
      const finished = cache.finish(
        owner,
        taskId,
        nativeId,
        phase === 'returned' ? 'completed' : phase === 'canceled' ? 'canceled' : 'failed',
        record ? tianxiResultDetails(record.tool, record.details?.target || '', result) : undefined
      );
      if (finished && calls.get(nativeId) === calls.values().next().value) firstFinished = true;
      return finished;
    },
    settle(response) {
      if (!response || !['completed', 'failed', 'incomplete'].includes(response.status)) {
        return cache.settle(owner, taskId, 'incomplete');
      }
      const final = {
        ...response,
        output: response.output.filter(
          (item) => item.type === 'message' && item.phase !== 'commentary'
        ),
      };
      return (
        cache.settle(owner, taskId, response.status, final) ||
        cache.settle(owner, taskId, response.status)
      );
    },
    abort() {
      cache.settle(owner, taskId, 'canceled');
    },
    discard() {
      cache.discard(owner, taskId);
    },
  };
}

module.exports = { createTianxiToolResultSession };
