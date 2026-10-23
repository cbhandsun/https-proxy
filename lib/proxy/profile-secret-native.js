'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { types } = require('node:util');
const EXECUTABLE = path.resolve(__dirname, '../../runtime/native/hpm-context-recovery-key.exe');
const fail = () =>
  Object.assign(new Error('secret_encryption_failed'), { code: 'ERR_SECRET_ENCRYPTION_FAILED' });

// Fixed packaged helper, same CurrentUser DPAPI format as existing credentials.
// A source-only checkout may use the compatibility backend. An invoked native
// helper failure is terminal; it never causes an unobserved backend downgrade.
function protectProfileSecretNative(value, dependencies = {}) {
  try {
    if (typeof value !== 'string' || value.length < 1 || value.length > 4096) throw fail();
    if (
      !dependencies ||
      typeof dependencies !== 'object' ||
      types.isProxy(dependencies) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(dependencies))
    )
      throw fail();
    const options = Object.create(null);
    for (const key of Reflect.ownKeys(dependencies)) {
      const slot = Object.getOwnPropertyDescriptor(dependencies, key);
      if (
        !['platform', 'filesystem', 'execute'].includes(key) ||
        !slot ||
        !Object.hasOwn(slot, 'value')
      )
        throw fail();
      options[key] = slot.value;
    }
    const platform = Object.hasOwn(options, 'platform') ? options.platform : process.platform;
    if (typeof platform !== 'string' || !platform) throw fail();
    if (platform !== 'win32') return null;
    const filesystem = Object.hasOwn(options, 'filesystem') ? options.filesystem : fs;
    const execute = Object.hasOwn(options, 'execute') ? options.execute : execFileSync;
    if (
      !filesystem ||
      typeof filesystem !== 'object' ||
      types.isProxy(filesystem) ||
      typeof execute !== 'function' ||
      types.isProxy(execute)
    )
      throw fail();
    const statPath = Object.getOwnPropertyDescriptor(filesystem, 'lstatSync')?.value;
    if (typeof statPath !== 'function' || types.isProxy(statPath)) throw fail();
    let stat;
    try {
      stat = statPath.call(filesystem, EXECUTABLE);
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        !types.isProxy(error) &&
        Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ENOENT'
      )
        return null;
      throw fail();
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail();
    for (let parent = path.dirname(EXECUTABLE); ; parent = path.dirname(parent)) {
      const ancestor = statPath.call(filesystem, parent);
      if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) throw fail();
      if (parent === path.dirname(parent)) break;
    }
    const output = execute(EXECUTABLE, ['--hpm-profile-secret-v1'], {
      input: JSON.stringify({
        operation: 'protect',
        value: Buffer.from(value, 'utf16le').toString('base64'),
      }),
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 24000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (typeof output !== 'string' || Buffer.byteLength(output) > 24000) throw fail();
    const reply = JSON.parse(output);
    if (JSON.stringify(reply) !== output) throw fail();
    if (
      !reply ||
      types.isProxy(reply) ||
      typeof reply !== 'object' ||
      Array.isArray(reply) ||
      Object.keys(reply).sort().join(',') !== 'ok,value' ||
      reply.ok !== true ||
      typeof reply.value !== 'string' ||
      reply.value.length > 22000
    )
      throw fail();
    const wrapped = Buffer.from(reply.value, 'base64');
    if (wrapped.length < 32 || wrapped.length > 16384 || wrapped.toString('base64') !== reply.value)
      throw fail();
    return reply.value;
  } catch {
    throw fail();
  }
}
module.exports = { protectProfileSecretNative };
