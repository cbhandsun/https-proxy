'use strict';

const { createHash, randomUUID } = require('node:crypto');

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = (value) => typeof value === 'string' && /^[\w.-]{1,256}$/.test(value);
// Native action IDs are opaque correlation values, not tool names or commands.
const actionIdentity = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const fail = () => {
  throw new Error('tianxi_external_tool_invalid');
};

function validateParameters(value) {
  let nodes = 0;
  function visit(node, depth) {
    if (++nodes > 4096 || depth > 16) fail();
    if (node === null || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail();
      visit(child, depth + 1);
    }
  }
  visit(value, 0);
}

// The channel only correlates and returns externally executed actions. The
// consumer must validate each registered tool's argument schema before execution.
function createTianxiExternalToolChannel(command, { onCall, send, onError }) {
  if (typeof onCall !== 'function') return null;
  const servers = command?.data?.options?.customMcpServers;
  if (!record(servers) || !record(command.header)) fail();
  if (!identity(command.header.session_id) || !identity(command.header.request_id)) fail();
  const sessionId = command.header.session_id;
  const requestId = command.header.request_id;
  const registered = new Map();
  const entries = Object.entries(servers);
  if (!entries.length || entries.length > 16) fail();
  for (const [name, server] of entries) {
    if (
      !identity(name) ||
      !record(server) ||
      server.exec_mode !== 'local' ||
      !Array.isArray(server.tools) ||
      !server.tools.length ||
      server.tools.length > 128
    )
      fail();
    const names = new Set();
    for (const tool of server.tools) {
      if (!record(tool) || !identity(tool.name) || names.has(tool.name)) fail();
      names.add(tool.name);
    }
    registered.set(name, names);
  }
  let active = true;
  let taskId = null;
  const calls = new Map();
  const actionIds = new Set();
  function accept(frame) {
    if (!active || frame?.type !== 'act_exec' || frame.data?.exec_mode !== 'local') return false;
    const data = frame.data;
    if (
      !record(frame.header) ||
      frame.header.session_id !== sessionId ||
      frame.header.request_id !== requestId ||
      !identity(data.task_id) ||
      !identity(data.execution_id) ||
      !Array.isArray(data.actions) ||
      !data.actions.length ||
      data.actions.length > 16 ||
      !record(frame.source) ||
      !record(frame.target)
    )
      fail();
    if (taskId !== null && taskId !== data.task_id) fail();
    const serialized = JSON.stringify(frame);
    if (Buffer.byteLength(serialized) > 131072) fail();
    const snapshot = JSON.parse(serialized);
    const ids = new Set();
    for (const action of snapshot.data.actions) {
      const names = registered.get(action?.mcpServerName);
      if (
        !record(action) ||
        !actionIdentity(action.id) ||
        ids.has(action.id) ||
        !names ||
        typeof action.name !== 'string' ||
        ![...names].some(
          (name) => action.name === name || action.name === `mcp__${action.mcpServerName}__${name}`
        ) ||
        !record(action.parameters) ||
        Object.hasOwn(action, 'response')
      )
        fail();
      validateParameters(action.parameters);
      ids.add(action.id);
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          header: snapshot.header,
          data: snapshot.data,
          source: snapshot.source,
          target: snapshot.target,
        })
      )
      .digest('hex');
    // An execution can contain sequential action batches. Correlate the batch
    // with both its execution and action IDs instead of treating execution ID
    // as a unique tool-call ID.
    const key = JSON.stringify([data.execution_id, [...ids].sort()]);
    const previous = calls.get(key);
    if (previous) {
      if (previous !== fingerprint) fail();
      return true;
    }
    if (calls.size >= 128 || [...ids].some((id) => actionIds.has(id))) fail();
    taskId = data.task_id;
    calls.set(key, fingerprint);
    for (const id of ids) actionIds.add(id);
    let replied = false;
    const reply = (outputs) => {
      if (!active || replied) return false;
      if (
        !Array.isArray(outputs) ||
        outputs.length !== snapshot.data.actions.length ||
        outputs.some((output) => typeof output !== 'string' || Buffer.byteLength(output) > 65536) ||
        outputs.reduce((bytes, output) => bytes + Buffer.byteLength(output), 0) > 262144
      )
        fail();
      replied = true;
      send({
        id: randomUUID(),
        type: 'act_resp',
        timestamp: String(Date.now()),
        header: snapshot.header,
        data: {
          task_id: snapshot.data.task_id,
          actions: snapshot.data.actions.map((action, i) => ({
            ...action,
            response: outputs[i],
          })),
        },
        source: snapshot.target,
        target: snapshot.source,
        extend: {},
      });
      return true;
    };
    // Pass a separate copy so consumer mutation cannot change reply routing.
    Promise.resolve()
      .then(() => {
        if (active) return onCall(JSON.parse(serialized), reply);
      })
      .catch(() => {
        if (active) onError(new Error('tianxi_external_tool_callback_failed'));
      });
    return true;
  }
  return {
    accept,
    close() {
      active = false;
      calls.clear();
      actionIds.clear();
    },
  };
}

module.exports = { createTianxiExternalToolChannel };
