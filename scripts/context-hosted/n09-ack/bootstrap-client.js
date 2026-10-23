'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fields, fail } = require('./contract');
const { createN09BootstrapContract } = require('./bootstrap-contract');
const { createN09MailboxClient } = require('./mailbox');
const identity = (stat) => [stat.dev, stat.ino, stat.birthtimeNs].join(':');

function physical(file, directory, ancestors) {
  let current = file,
    first = true,
    result;
  for (;;) {
    const stat = fs.lstatSync(current, { bigint: true });
    const actual = path.resolve(fs.realpathSync.native(current));
    const expected = path.resolve(current);
    if (
      stat.isSymbolicLink() ||
      (process.platform === 'win32'
        ? actual.toLowerCase() !== expected.toLowerCase()
        : actual !== expected) ||
      (first && !directory ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory())
    )
      throw fail();
    const id = identity(stat);
    if (first) result = stat;
    if (ancestors) {
      if (ancestors.has(current) && ancestors.get(current) !== id) throw fail();
      ancestors.set(current, id);
    }
    const parent = path.dirname(current);
    if (parent === current) return result;
    current = parent;
    first = false;
  }
}

function readBootstrap(file) {
  let fd;
  try {
    const initial = physical(file, false);
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > 131072n ||
      identity(before) !== identity(initial) ||
      before.size !== initial.size ||
      before.mtimeNs !== initial.mtimeNs
    )
      throw fail();
    const bytes = Buffer.alloc(Number(before.size));
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw fail();
    const after = fs.fstatSync(fd, { bigint: true });
    const final = physical(file, false);
    for (const stat of [after, final]) {
      if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        identity(stat) !== identity(before) ||
        stat.size !== before.size ||
        stat.mtimeNs !== before.mtimeNs ||
        stat.ctimeNs !== before.ctimeNs
      )
        throw fail();
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    if (JSON.stringify(value) !== text || !Buffer.from(text, 'utf8').equals(bytes)) throw fail();
    fs.closeSync(fd);
    fd = undefined;
    return value;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function createN09HostAckClient(input) {
  let bootstrap, mailbox, token;
  try {
    let options = fields(input, ['runtimeDir', 'pid', 'manifestSha256', 'token']);
    let { runtimeDir } = options;
    const { pid, manifestSha256 } = options;
    token = options.token;
    options = undefined;
    input = undefined;
    if (
      typeof runtimeDir !== 'string' ||
      runtimeDir.length > 4096 ||
      !path.isAbsolute(runtimeDir) ||
      /^[\\/]{2}/.test(runtimeDir) ||
      [...runtimeDir].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || (code >= 127 && code <= 159);
      }) ||
      runtimeDir.split(/[\\/]/).some((part) => part === '.' || part === '..') ||
      path.basename(runtimeDir) !== 'runtime'
    )
      throw fail();
    runtimeDir = path.resolve(runtimeDir);
    const directory = path.join(path.dirname(runtimeDir), 'n09-ack');
    const ancestors = new Map();
    const verifyDirectories = () => {
      physical(runtimeDir, true, ancestors);
      physical(directory, true, ancestors);
    };
    verifyDirectories();
    bootstrap = createN09BootstrapContract({ token, pid, manifestSha256 });
    token = undefined;
    const payload = bootstrap.verify(
      readBootstrap(path.join(directory, 'bootstrap-' + pid + '.json'))
    );
    verifyDirectories();
    mailbox = createN09MailboxClient({
      directory,
      pid,
      epoch: payload.epoch,
      signingKey: bootstrap.mailboxKey(payload),
    });
    verifyDirectories();
    let closed = false,
      closeFailed = false,
      sequence = 0;
    function available() {
      if (closed) throw fail();
      verifyDirectories();
    }
    return Object.freeze({
      submit(input) {
        try {
          available();
          const precondition = fields(input, ['operation', 'rootId', 'expiresAt', 'minRevision']);
          mailbox.submit({
            version: 1,
            pid,
            epoch: payload.epoch,
            sequence: sequence + 1,
            ...precondition,
          });
          sequence++;
          verifyDirectories();
        } catch {
          throw fail();
        }
      },
      readArmed() {
        try {
          available();
          const result = mailbox.readArmed();
          verifyDirectories();
          return result;
        } catch {
          throw fail();
        }
      },
      readReceipt() {
        try {
          available();
          const result = mailbox.readReceipt();
          verifyDirectories();
          return result;
        } catch {
          throw fail();
        }
      },
      close() {
        if (closed) {
          if (closeFailed) throw fail();
          return;
        }
        closed = true;
        token = undefined;
        for (const resource of [bootstrap, mailbox]) {
          try {
            resource.close();
          } catch {
            closeFailed = true;
          }
        }
        if (closeFailed) throw fail();
      },
    });
  } catch {
    for (const resource of [bootstrap, mailbox]) {
      try {
        resource?.close();
      } catch {
        /* Preserve the fixed initialization rejection. */
      }
    }
    throw fail();
  }
}

module.exports = { createN09HostAckClient };
