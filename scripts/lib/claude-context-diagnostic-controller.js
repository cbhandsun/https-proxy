'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { safePath, digest } = require('./nsis-encrypted-contract');
const { buildInstalledClientController } = require('./nsis-client-controller');
const fail = () => new Error('claude_diagnostic_controller_failed');
const ORIGINAL =
  "$config = New-HpmDaemonOwnedConfig $ports -EntryProtocol $(if ($Request.case -cin @('10','11')) { 'claude' } else { 'openai-responses' })";
const CLAUDE = "$config = New-HpmDaemonOwnedConfig $ports -EntryProtocol 'claude'";
function transformClaudeDiagnosticStartup(source) {
  if (
    typeof source !== 'string' ||
    Buffer.byteLength(source) > 262144 ||
    source.split(ORIGINAL).length !== 2
  )
    throw fail();
  return source.replace(ORIGINAL, CLAUDE);
}
function buildClaudeDiagnosticController(options) {
  let fd;
  try {
    const built = buildInstalledClientController(options);
    const output = safePath(built.outputRoot, true);
    if (output !== path.join(options.ownedRoot, 'n08-hosted-controller')) throw fail();
    for (const [name, expected] of Object.entries(built.copyPins))
      if (digest(path.join(output, name)) !== expected) throw fail();
    const name = 'context-recovery-daemon-owned-controller.psm1';
    const file = safePath(path.join(output, name));
    const before = fs.lstatSync(file);
    fd = fs.openSync(file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    const keys = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'];
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size < 1 ||
      opened.size > 262144 ||
      keys.some((key) => opened[key] !== before[key])
    )
      throw fail();
    const bytes = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fs.fstatSync(fd);
    if (
      length !== opened.size ||
      keys.some((key) => opened[key] !== after[key]) ||
      createHash('sha256').update(bytes.subarray(0, length)).digest('hex') !== built.copyPins[name]
    )
      throw fail();
    const next = transformClaudeDiagnosticStartup(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
    );
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, next, 0, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    const expected = createHash('sha256').update(next).digest('hex');
    if (digest(file) !== expected) throw fail();
    const copyPins = { ...built.copyPins, [name]: expected };
    for (const [entry, hash] of Object.entries(copyPins))
      if (digest(path.join(output, entry)) !== hash) throw fail();
    return Object.freeze({ outputRoot: output, copyPins: Object.freeze(copyPins) });
  } catch {
    throw fail();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
module.exports = { buildClaudeDiagnosticController, transformClaudeDiagnosticStartup };
