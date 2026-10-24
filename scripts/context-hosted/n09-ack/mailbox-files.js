'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fields, fail, parseN09AckCommand, parseN09AckReceipt } = require('./contract');
const { parseN09MailboxSignal } = require('./mailbox-control');

function rejectFile(handle) {
  if (handle !== undefined) {
    try {
      fs.closeSync(handle);
    } catch {
      throw fail();
    }
  }
  throw fail();
}

// Only fixed command/control/receipt filenames in an already-created owned
// directory. No caller-supplied path, executable, principal or method name.
function createN09MailboxFiles(input) {
  try {
    const { directory, pid } = fields(input, ['directory', 'pid']);
    if (
      typeof directory !== 'string' ||
      directory.length > 4096 ||
      !path.isAbsolute(directory) ||
      /^[\\/]{2}/.test(directory) ||
      [...directory].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      directory.split(/[\\/]/).some((part) => part === '.' || part === '..') ||
      !Number.isSafeInteger(pid) ||
      pid < 1
    )
      throw fail();
    let closed = false;
    function physical(file, directory) {
      let current = file,
        first = true,
        identity;
      for (;;) {
        const stat = fs.lstatSync(current, { bigint: true });
        if (
          stat.isSymbolicLink() ||
          path.resolve(fs.realpathSync.native(current)).toLowerCase() !==
            path.resolve(current).toLowerCase() ||
          (first
            ? directory
              ? !stat.isDirectory()
              : !stat.isFile() || stat.nlink !== 1n
            : !stat.isDirectory())
        )
          throw fail();
        if (first) identity = [stat.dev, stat.ino, stat.birthtimeNs].join(':');
        const parent = path.dirname(current);
        if (parent === current) return identity;
        current = parent;
        first = false;
      }
    }
    const identity = physical(directory, true);
    function verify() {
      if (closed || physical(directory, true) !== identity) throw fail();
    }
    function name(kind, sequence) {
      verify();
      if (
        !['command', 'control', 'receipt', 'failure'].includes(kind) ||
        !Number.isSafeInteger(sequence) ||
        sequence < 1 ||
        sequence > 16
      )
        throw fail();
      return path.join(directory, kind + '-' + pid + '-' + sequence + '.json');
    }
    function wire(kind, sequence, input) {
      const envelope = fields(input, ['payload', 'signature']);
      if (typeof envelope.signature !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.signature))
        throw fail();
      let payload;
      if (kind === 'command') payload = parseN09AckCommand(envelope.payload);
      else if (kind === 'receipt') payload = parseN09AckReceipt(envelope.payload);
      else {
        payload = parseN09MailboxSignal(envelope.payload);
        if (
          payload.version !== 1 ||
          typeof payload.epoch !== 'string' ||
          !/^[a-f0-9]{32}$/.test(payload.epoch) ||
          payload.state !== (kind === 'failure' ? 'failed' : 'armed')
        )
          throw fail();
      }
      if (payload.pid !== pid || payload.sequence !== sequence) throw fail();
      return JSON.stringify({ payload, signature: envelope.signature });
    }
    return Object.freeze({
      read(kind, sequence) {
        let handle;
        try {
          const file = name(kind, sequence);
          // Publish readiness only AFTER the full signed payload was flushed.
          // An empty marker has no partial-byte state and never carries an ACK.
          let ready;
          try {
            ready = fs.lstatSync(file + '.ready', { bigint: true });
          } catch (error) {
            if (error?.code === 'ENOENT') {
              verify();
              return null;
            }
            throw fail();
          }
          if (!ready.isFile() || ready.nlink !== 1n || ready.size !== 0n) throw fail();
          physical(file + '.ready', false);
          // A ready marker requires a complete payload; missing payloads fail closed.
          try {
            handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
          } catch {
            throw fail();
          }
          const before = fs.fstatSync(handle, { bigint: true });
          if (
            !before.isFile() ||
            before.nlink !== 1n ||
            before.size < 1n ||
            before.size > 4096n ||
            [before.dev, before.ino, before.birthtimeNs].join(':') !== physical(file, false)
          )
            throw fail();
          const bytes = Buffer.alloc(Number(before.size));
          if (fs.readSync(handle, bytes, 0, bytes.length, 0) !== bytes.length) throw fail();
          const after = fs.fstatSync(handle, { bigint: true });
          if (
            before.size !== after.size ||
            before.mtimeNs !== after.mtimeNs ||
            before.ctimeNs !== after.ctimeNs ||
            [after.dev, after.ino, after.birthtimeNs].join(':') !== physical(file, false)
          )
            throw fail();
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          const value = JSON.parse(text);
          if (JSON.stringify(value) !== text) throw fail();
          verify();
          fs.closeSync(handle);
          handle = undefined;
          return value;
        } catch {
          rejectFile(handle);
        }
      },
      write(kind, sequence, value) {
        let handle;
        try {
          const file = name(kind, sequence);
          const text = wire(kind, sequence, value);
          if (typeof text !== 'string' || Buffer.byteLength(text) > 4096) throw fail();
          if (fs.existsSync(file + '.ready')) throw fail();
          handle = fs.openSync(file, 'wx', 0o600);
          const before = fs.fstatSync(handle, { bigint: true });
          if (!before.isFile() || before.nlink !== 1n) throw fail();
          fs.writeFileSync(handle, text, 'utf8');
          fs.fsyncSync(handle);
          const after = fs.fstatSync(handle, { bigint: true });
          if (
            after.nlink !== 1n ||
            [after.dev, after.ino, after.birthtimeNs].join(':') !== physical(file, false) ||
            [before.dev, before.ino, before.birthtimeNs].join(':') !==
              [after.dev, after.ino, after.birthtimeNs].join(':')
          )
            throw fail();
          verify();
          fs.closeSync(handle);
          handle = undefined;
          handle = fs.openSync(file + '.ready', 'wx', 0o600);
          fs.fsyncSync(handle);
          physical(file + '.ready', false);
          verify();
          fs.closeSync(handle);
          handle = undefined;
        } catch {
          rejectFile(handle);
        }
      },
      close() {
        closed = true;
      },
    });
  } catch {
    throw fail();
  }
}

module.exports = { createN09MailboxFiles };
