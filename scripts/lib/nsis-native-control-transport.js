'use strict';
const { spawnSync } = require('node:child_process');
const { types } = require('node:util');
const { controlReceipt } = require('./nsis-native-control-contract');
const CONTROL_STEPS = ['start-1', 'stop-1', 'start-2', 'stop-2'];
const NATIVE_FAILURES = [
  'request_rejected',
  'root_unavailable',
  'launch_failed',
  'child_exited',
  'owner_mismatch',
  'health_timeout',
  'command_unconfirmed',
];
const CONTROL_FAILURES = [
  ...NATIVE_FAILURES,
  'spawn',
  'deadline',
  'signal',
  'exit',
  'stderr',
  'output',
  'json',
  'receipt',
  'exception',
];
const fail = (reason = 'exception') =>
  Object.assign(new Error('native_control_probe_failed'), { controlFailure: reason });
function nativeFailure(stderr) {
  return NATIVE_FAILURES.find(
    (reason) => stderr === `proxy_control_failed\nproxy_control_phase=${reason}\n`
  );
}
function failureReason(error) {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return 'exception';
  const slot = Object.getOwnPropertyDescriptor(error, 'controlFailure');
  return slot && Object.hasOwn(slot, 'value') && CONTROL_FAILURES.includes(slot.value)
    ? slot.value
    : 'exception';
}
function withControlFailurePhase(stage, report, action) {
  if (!CONTROL_STEPS.includes(stage)) throw fail();
  try {
    return action();
  } catch (error) {
    const reason = failureReason(error);
    report(stage + '-' + reason);
    throw fail(reason);
  }
}
function executeNativeControl(program, command, environment, workingDirectory, start = spawnSync) {
  try {
    if (!['start', 'stop'].includes(command)) throw fail();
    const result = start(program, ['--hpm-proxy-control-v1'], {
      cwd: workingDirectory,
      env: environment,
      input: JSON.stringify({ command }) + '\n',
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 12000,
      maxBuffer: 8192,
    });
    if (result.error) throw fail(result.error.code === 'ETIMEDOUT' ? 'deadline' : 'spawn');
    if (result.signal !== null) throw fail('signal');
    if (result.status !== 0) throw fail(nativeFailure(result.stderr) || 'exit');
    if (result.stderr !== '') throw fail('stderr');
    if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 512)
      throw fail('output');
    let value;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      throw fail('json');
    }
    if (result.stdout !== JSON.stringify(value) + '\n') throw fail('json');
    try {
      return controlReceipt(value, command);
    } catch {
      throw fail('receipt');
    }
  } catch (error) {
    throw fail(failureReason(error));
  }
}
module.exports = { executeNativeControl, withControlFailurePhase, CONTROL_FAILURES, CONTROL_STEPS };
