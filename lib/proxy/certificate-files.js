'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { ensurePrivateFileSync } = require('./secure-files');

// Stage and secure every file before installation. Roll back partial installs
// on ordinary I/O failure; startup key/chain checks detect interrupted installs.
function writeCertificateFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > 4) {
    throw new Error('certificate_file_input_invalid');
  }
  const paths = new Set();
  const admitted = [];
  for (let index = 0; index < files.length; index++) {
    const file = Object.getOwnPropertyDescriptor(files, String(index))?.value;
    if (!file || typeof file !== 'object') throw new Error('certificate_file_input_invalid');
    const target = Object.getOwnPropertyDescriptor(file, 'path')?.value;
    const content = Object.getOwnPropertyDescriptor(file, 'content')?.value;
    const exclusiveDescriptor = Object.getOwnPropertyDescriptor(file, 'exclusive');
    const exclusive = exclusiveDescriptor?.value;
    if (exclusiveDescriptor && (exclusiveDescriptor.get || typeof exclusive !== 'boolean')) {
      throw new Error('certificate_file_input_invalid');
    }
    if (
      typeof target !== 'string' ||
      target.length > 4096 ||
      !path.isAbsolute(target) ||
      typeof content !== 'string' ||
      !content.length ||
      content.length > 32 * 1024
    ) {
      throw new Error('certificate_file_input_invalid');
    }
    const identity =
      process.platform === 'win32' ? path.resolve(target).toLowerCase() : path.resolve(target);
    if (paths.has(identity)) throw new Error('certificate_file_input_invalid');
    paths.add(identity);
    admitted.push({ path: target, content, exclusive: exclusive === true });
  }
  const staged = [];
  let failure;
  try {
    for (const file of admitted) {
      if (fs.existsSync(file.path) && !fs.lstatSync(file.path).isFile()) {
        throw new Error('certificate_file_input_invalid');
      }
      const suffix = crypto.randomUUID();
      const entry = {
        path: file.path,
        exclusive: file.exclusive,
        stage: `${file.path}.${suffix}.tmp`,
        backup: `${file.path}.${suffix}.bak`,
        installed: false,
        backedUp: false,
      };
      staged.push(entry);
      fs.writeFileSync(entry.stage, file.content, { flag: 'wx', mode: 0o600 });
      ensurePrivateFileSync(entry.stage);
    }
    for (const entry of staged) {
      if (entry.exclusive) {
        // Same-directory hard links provide atomic no-overwrite installation.
        // A simultaneous initializer must not silently replace a new root.
        fs.linkSync(entry.stage, entry.path);
        entry.installed = true;
        continue;
      }
      if (fs.existsSync(entry.path)) {
        fs.renameSync(entry.path, entry.backup);
        entry.backedUp = true;
      }
      fs.renameSync(entry.stage, entry.path);
      entry.installed = true;
    }
  } catch {
    let rollbackFailed = false;
    for (const entry of [...staged].reverse()) {
      try {
        if (entry.installed) fs.unlinkSync(entry.path);
        if (entry.backedUp) {
          fs.renameSync(entry.backup, entry.path);
          entry.backedUp = false;
        }
      } catch {
        rollbackFailed = true;
      }
    }
    // If rollback fails, keep secured backups for explicit recovery.
    failure = rollbackFailed
      ? 'certificate_file_recovery_required'
      : 'certificate_file_install_failed';
  }
  for (const entry of staged) {
    try {
      if (fs.existsSync(entry.stage)) fs.unlinkSync(entry.stage);
      if (!failure && entry.backedUp) fs.unlinkSync(entry.backup);
    } catch {
      failure = failure || 'certificate_file_cleanup_failed';
    }
  }
  if (failure) throw new Error(failure);
}

module.exports = { writeCertificateFiles };
