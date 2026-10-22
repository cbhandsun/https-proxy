'use strict';

const path = require('node:path');
const { dataSnapshot } = require('./context-recovery-daemon-http-boundary');
const { PRELOAD_PHASES } = require('./context-recovery-daemon-owned-failure');
const reject = () => new Error('daemon_protocol_rejected');
const LABELS = Object.freeze(['00', '01', '10', '11']);

function exact(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    throw reject();
}

function identity(value) {
  value = dataSnapshot(value, 'daemon_protocol_rejected');
  exact(value, [
    'pid',
    'entrypoint',
    'cwd',
    'configDir',
    'runtimeDir',
    'managementPort',
    'entryPort',
  ]);
  if (!Number.isSafeInteger(value.pid) || value.pid < 1) throw reject();
  for (const name of ['entrypoint', 'cwd', 'configDir', 'runtimeDir']) {
    const file = value[name];
    if (
      typeof file !== 'string' ||
      Buffer.byteLength(file) > 4096 ||
      !file.isWellFormed() ||
      !path.isAbsolute(file) ||
      /^[\\/]{2}/.test(file) ||
      [...file].some(
        (character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127
      ) ||
      file.split(/[\\/]/).some((part) => part === '.' || part === '..')
    )
      throw reject();
  }
  for (const port of [value.managementPort, value.entryPort])
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw reject();
  if (value.managementPort === value.entryPort) throw reject();
  return Object.freeze(value);
}

// Protocol objects have no arrays, at most two object levels and no duplicate
// keys. Parse strings with JSON's native decoder after locating their boundary.
function parseDocument(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16384) throw reject();
  let index = 0;
  const whitespace = () => {
    while (/[ \t\r\n]/.test(text[index] || '') && index < text.length) index++;
  };
  function string() {
    const start = index++;
    while (index < text.length) {
      if (text[index] === '\\') index += 2;
      else if (text[index++] === '"') return JSON.parse(text.slice(start, index));
    }
    throw reject();
  }
  function value(depth) {
    whitespace();
    if (text[index] === '"') return string();
    if (text[index] === '{') {
      if (depth > 1) throw reject();
      index++;
      const result = Object.create(null);
      whitespace();
      if (text[index] === '}') {
        index++;
        return result;
      }
      for (;;) {
        whitespace();
        if (text[index] !== '"') throw reject();
        const key = string();
        if (Object.hasOwn(result, key)) throw reject();
        whitespace();
        if (text[index++] !== ':') throw reject();
        result[key] = value(depth + 1);
        whitespace();
        const next = text[index++];
        if (next === '}') return result;
        if (next !== ',') throw reject();
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      text.slice(index)
    );
    if (!match) throw reject();
    index += match[0].length;
    return JSON.parse(match[0]);
  }
  const parsed = value(0);
  whitespace();
  if (index !== text.length) throw reject();
  return parsed;
}

function response(frame, request) {
  try {
    const result = parseDocument(frame);
    const common = ['v', 'id', 'op', 'case', 'ok'];
    const fields = {
      start: ['identity'],
      status: [
        'alive',
        'credentialsPrivate',
        ...(Object.hasOwn(result, 'preloadPhase') ? ['preloadPhase'] : []),
      ],
      stop: ['treeEmpty', 'cleanupSemantics'],
    };
    if (!Object.hasOwn(fields, request.op)) throw reject();
    const failed = result.ok === false;
    exact(result, [...common, ...(failed ? ['cause'] : fields[request.op])]);
    if (
      result.v !== 1 ||
      result.id !== request.id ||
      result.op !== request.op ||
      result.case !== request.case ||
      (result.ok !== true && !failed)
    )
      throw reject();
    if (failed) {
      const causes =
        request.op === 'start'
          ? ['setup', 'process_start', 'job_assign', 'gate_release']
          : request.op === 'stop'
            ? ['controller_cleanup']
            : [];
      if (!causes.includes(result.cause)) throw reject();
      return result;
    }
    if (request.op === 'start') result.identity = identity(result.identity);
    if (
      request.op === 'status' &&
      (typeof result.alive !== 'boolean' ||
        typeof result.credentialsPrivate !== 'boolean' ||
        (Object.hasOwn(result, 'preloadPhase') && !PRELOAD_PHASES.includes(result.preloadPhase)))
    )
      throw reject();
    if (
      request.op === 'stop' &&
      (result.treeEmpty !== true || result.cleanupSemantics !== 'forced_cleanup')
    )
      throw reject();
    return result;
  } catch {
    throw reject();
  }
}

module.exports = { LABELS, identity, response };
