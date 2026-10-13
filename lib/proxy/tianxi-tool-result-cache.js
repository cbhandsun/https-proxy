'use strict';

const { randomUUID } = require('node:crypto');
const { TIANXI_RESULT_TOOLS } = require('./tianxi-progress-presentation');
const { REFERENCE_PATTERN, createTianxiResultCall } = require('./tianxi-tool-result-continuation');
const { parseTianxiResultDetails } = require('./tianxi-tool-result-details');

const TASK_PATTERN = /^txt_[0-9a-f]{32}$/;
const TERMINAL = new Set(['completed', 'failed', 'canceled', 'incomplete']);
const TOOLS = new Set(TIANXI_RESULT_TOOLS);

function boundedInteger(value, fallback, maximum) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function validIdentity(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isTianxiFinalResponse(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !['completed', 'failed', 'incomplete'].includes(value.status) ||
    !Array.isArray(value.output) ||
    value.output.length > 128
  )
    return false;
  let text = '';
  for (const item of value.output) {
    if (
      !item ||
      typeof item !== 'object' ||
      item.type !== 'message' ||
      typeof item.id !== 'string' ||
      item.id.length === 0 ||
      item.id.length > 256 ||
      !['completed', 'incomplete'].includes(item.status) ||
      item.role !== 'assistant' ||
      (item.phase != null && item.phase !== 'final_answer') ||
      !Array.isArray(item.content) ||
      item.content.length > 128
    )
      return false;
    for (const part of item.content) {
      if (
        !part ||
        typeof part !== 'object' ||
        part.type !== 'output_text' ||
        typeof part.text !== 'string' ||
        part.text.length > 1024 * 1024 ||
        !Array.isArray(part.annotations)
      )
        return false;
      text += part.text;
      if (text.length > 1024 * 1024) return false;
    }
  }
  return value.output_text == null || value.output_text === text;
}

function createTianxiToolResultCache(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const maxTasks = boundedInteger(options.maxTasks, 64, 256);
  const maxOperations = boundedInteger(options.maxOperations, 128, 512);
  const ttlMs = boundedInteger(options.ttlMs, 60 * 60 * 1000, 2 * 60 * 60 * 1000);
  const maxResponseBytes = boundedInteger(options.maxResponseBytes, 256 * 1024, 1024 * 1024);
  const maxBytes = boundedInteger(options.maxBytes, 8 * 1024 * 1024, 32 * 1024 * 1024);
  const tasks = new Map();
  const references = new Map();
  let responseBytes = 0;

  function remove(id) {
    const task = tasks.get(id);
    if (!task) return;
    clearTimeout(task.lease);
    if (task.status === 'in_progress') task.cancel?.();
    for (const operation of task.operations.values()) references.delete(operation.reference);
    responseBytes -= task.responseBytes;
    tasks.delete(id);
  }

  function prune() {
    const current = now();
    for (const [id, task] of tasks) {
      if (current < task.createdAt || current - task.createdAt >= ttlMs) remove(id);
    }
  }

  function ownedTask(owner, id) {
    prune();
    if (!validIdentity(owner) || typeof id !== 'string' || !TASK_PATTERN.test(id)) return null;
    const task = tasks.get(id);
    return task && task.owner === owner ? task : null;
  }

  function ownedReference(owner, reference) {
    prune();
    if (typeof reference !== 'string' || !REFERENCE_PATTERN.test(reference)) return null;
    const index = references.get(reference);
    const task = index ? ownedTask(owner, index.taskId) : null;
    return task ? { task, operation: task.operations.get(index.nativeId) } : null;
  }

  function publicOperation(task, operation) {
    return {
      reference: operation.reference,
      tool: operation.tool,
      ordinal: operation.ordinal,
      status: operation.status,
      taskStatus: task.status,
      ...(operation.details && Object.keys(operation.details).length
        ? { details: { ...operation.details } }
        : {}),
    };
  }

  function retainDetails(task, operation, value) {
    const details = parseTianxiResultDetails(operation.tool, value);
    const bytes = Object.keys(details).length ? Buffer.byteLength(JSON.stringify(details)) : 0;
    const delta = bytes - (operation.detailsBytes || 0);
    if (responseBytes + delta > maxBytes) return;
    operation.details = details;
    operation.detailsBytes = bytes;
    task.responseBytes += delta;
    responseBytes += delta;
  }

  function cancelTask(task) {
    if (task.status !== 'in_progress') return;
    task.status = 'canceled';
    clearTimeout(task.lease);
    for (const operation of task.operations.values()) {
      if (operation.status === 'in_progress') operation.status = 'canceled';
    }
    task.cancel?.();
  }

  function touch(task) {
    if (!task.liveModel || task.status !== 'in_progress') return;
    clearTimeout(task.lease);
    task.lease = setTimeout(() => cancelTask(task), 60000);
    task.lease.unref?.();
  }

  return {
    begin(owner, options = {}) {
      prune();
      if (!validIdentity(owner)) return null;
      if (!options || typeof options !== 'object' || Array.isArray(options)) return null;
      let serialBinding = null;
      if (options.serialResultTool != null) {
        const probe = createTianxiResultCall('txr_' + '0'.repeat(32), options.serialResultTool);
        if (!probe) return null;
        serialBinding = {
          name: probe.name,
          ...(probe.namespace ? { namespace: probe.namespace } : {}),
          ...(probe.type === 'custom_tool_call' ? { kind: 'code_mode' } : {}),
        };
      }
      if (tasks.size >= maxTasks) {
        const completed = [...tasks].find(([, task]) => task.status !== 'in_progress');
        if (!completed) return null;
        remove(completed[0]);
      }
      const id = 'txt_' + randomUUID().replace(/-/g, '');
      tasks.set(id, {
        owner,
        createdAt: now(),
        status: 'in_progress',
        operations: new Map(),
        response: null,
        responseBytes: 0,
        serialBinding,
      });
      return id;
    },
    start(owner, taskId, nativeId, name, details) {
      const task = ownedTask(owner, taskId);
      if (!task || !validIdentity(nativeId, 128)) return null;
      const previous = task.operations.get(nativeId);
      if (previous) return publicOperation(task, previous);
      const operationLimit = task.serialBinding ? Math.min(maxOperations, 128) : maxOperations;
      if (task.status !== 'in_progress' || task.operations.size >= operationLimit) return null;
      const operation = {
        reference: 'txr_' + randomUUID().replace(/-/g, ''),
        tool: TOOLS.has(name) ? name : 'Operation',
        ordinal: task.operations.size + 1,
        status: 'in_progress',
        issued: !task.serialBinding || task.operations.size === 0,
      };
      retainDetails(task, operation, details);
      task.operations.set(nativeId, operation);
      references.set(operation.reference, { taskId, nativeId });
      return publicOperation(task, operation);
    },
    finish(owner, taskId, nativeId, status, details) {
      const task = ownedTask(owner, taskId);
      const operation = task?.operations.get(nativeId);
      if (!operation || !TERMINAL.has(status)) return false;
      if (operation.status !== 'in_progress') return operation.status === status;
      if (details !== undefined) retainDetails(task, operation, details);
      operation.status = status;
      return true;
    },
    settle(owner, taskId, status, response = null) {
      const task = ownedTask(owner, taskId);
      if (!task || !TERMINAL.has(status)) return false;
      if (task.status !== 'in_progress') return task.status === status;
      if (response !== null) {
        if (!response || typeof response !== 'object' || Array.isArray(response)) return false;
        if (response.status !== status || !Array.isArray(response.output)) return false;
        let serialized;
        try {
          serialized = JSON.stringify(response);
        } catch (_error) {
          return false;
        }
        if (typeof serialized !== 'string') return false;
        const bytes = Buffer.byteLength(serialized);
        if (bytes > maxResponseBytes || responseBytes + bytes > maxBytes) return false;
        const detached = JSON.parse(serialized);
        // Continuations must not dispatch another client tool or repeat progress items.
        if (detached?.status !== status || !isTianxiFinalResponse(detached)) return false;
        task.response = serialized;
        task.responseBytes += bytes;
        responseBytes += bytes;
      }
      task.status = status;
      clearTimeout(task.lease);
      for (const operation of task.operations.values()) {
        if (operation.status === 'in_progress') {
          operation.status = status === 'completed' ? 'incomplete' : status;
        }
      }
      return true;
    },
    operation(owner, taskId, nativeId) {
      const task = ownedTask(owner, taskId);
      const operation = task?.operations.get(nativeId);
      // Native result enrichment is not evidence of an active consumer.
      return operation ? publicOperation(task, operation) : null;
    },
    lookup(owner, reference) {
      const record = ownedReference(owner, reference);
      if (record) touch(record.task);
      return record ? publicOperation(record.task, record.operation) : null;
    },
    continuation(owner, refs) {
      if (!Array.isArray(refs) || refs.length === 0 || refs.length > maxOperations) return null;
      let task = null;
      let lastOrdinal = 0;
      for (const reference of refs) {
        const record = ownedReference(owner, reference);
        if (!record || !record.operation.issued || (task && task !== record.task)) return null;
        task = record.task;
        lastOrdinal = Math.max(lastOrdinal, record.operation.ordinal);
      }
      const next =
        task.serialBinding &&
        ((task.status !== 'in_progress' && task.response !== null) ||
          (task.liveModel && task.status === 'in_progress'))
          ? [...task.operations.values()].find((operation) => operation.ordinal > lastOrdinal)
          : null;
      touch(task);
      const ready = next && (task.status !== 'in_progress' || next.status !== 'in_progress');
      const nextCall = ready
        ? createTianxiResultCall(next.reference, task.serialBinding, next.tool)
        : null;
      // Retrying the same completed reference replays the same next call. Only
      // the client's returned call IDs advance this sequence, never its text.
      if (nextCall) next.issued = true;
      return {
        status: task.status,
        response:
          task.response === null
            ? nextCall && task.liveModel
              ? { status: 'completed', output: [], model: task.liveModel }
              : null
            : JSON.parse(task.response),
        ...(nextCall ? { nextCall } : {}),
      };
    },
    enableLive(owner, taskId, model, cancel) {
      const task = ownedTask(owner, taskId);
      if (
        !task ||
        !task.serialBinding ||
        task.status !== 'in_progress' ||
        typeof model !== 'string' ||
        !/^[A-Za-z0-9_./-]{1,256}$/.test(model) ||
        typeof cancel !== 'function'
      )
        return false;
      task.liveModel = model;
      task.cancel = cancel;
      touch(task);
      return true;
    },
    cancelContinuation(owner, refs) {
      if (!Array.isArray(refs) || refs.length === 0 || refs.length > maxOperations) return false;
      let task = null;
      for (const reference of refs) {
        const record = ownedReference(owner, reference);
        if (!record || !record.operation.issued || (task && task !== record.task)) return false;
        task = record.task;
      }
      cancelTask(task);
      return true;
    },
    discard(owner, taskId) {
      if (!ownedTask(owner, taskId)) return false;
      remove(taskId);
      return true;
    },
  };
}

module.exports = { createTianxiToolResultCache, REFERENCE_PATTERN, isTianxiFinalResponse };
