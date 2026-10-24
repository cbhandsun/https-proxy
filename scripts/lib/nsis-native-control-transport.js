'use strict';
const { spawnSync } = require('node:child_process');
const { controlReceipt } = require('./nsis-native-control-contract');
const fail = () => new Error('native_control_probe_failed');
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
    if (
      result.error ||
      result.status !== 0 ||
      result.signal !== null ||
      result.stderr !== '' ||
      typeof result.stdout !== 'string' ||
      Buffer.byteLength(result.stdout) > 512
    )
      throw fail();
    let value;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      throw fail();
    }
    if (result.stdout !== JSON.stringify(value) + '\n') throw fail();
    return controlReceipt(value, command);
  } catch {
    throw fail();
  }
}
module.exports = { executeNativeControl };
