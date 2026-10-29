'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fields } = require('../n09-ack/contract');
const { readBootstrap, physical } = require('../n09-ack/bootstrap-client');
const fail = () => new Error('n09_publication_files_rejected');

// Immutable, bounded probe files. Ready markers authorize complete visibility,
// never durability or a storage ACK. This separate directory never alters ACKs.
function createPublicationFiles(input, create, ack) {
  try {
    const { directory, pid, epoch } = fields(input, ['directory', 'pid', 'epoch']);
    if (
      typeof create !== 'boolean' ||
      typeof directory !== 'string' ||
      directory.length > 4096 ||
      !path.isAbsolute(directory) ||
      /^[\\/]{2}/.test(directory) ||
      /[\0\r\n]/.test(directory) ||
      directory.split(/[\\/]/).some((part) => part === '.' || part === '..') ||
      !Number.isSafeInteger(pid) ||
      pid < 1 ||
      typeof epoch !== 'string' ||
      !/^[a-f0-9]{32}$/.test(epoch) ||
      path.basename(directory) !==
        (ack ? 'n09-publication-ack-' : 'n09-publication-') + pid + '-' + epoch
    )
      throw fail();
    const pins = new Map();
    physical(path.dirname(directory), true, pins);
    if (create) fs.mkdirSync(directory, { mode: 0o700 });
    physical(directory, true, pins);
    let closed = false,
      failed = false;
    function available() {
      if (closed || failed) throw fail();
    }
    function verify() {
      available();
      physical(directory, true, pins);
    }
    function name(kind, sequence) {
      verify();
      if (
        !(
          ack
            ? [
                'arm',
                'armed',
                'armed-cancel',
                'trigger-held',
                'trigger-release',
                'held',
                'release',
                'released',
              ]
            : ['query', 'state']
        ).includes(kind) ||
        !Number.isSafeInteger(sequence) ||
        sequence < 1 ||
        sequence > (ack ? 1 : 16)
      )
        throw fail();
      return path.join(directory, kind + '-' + sequence + '.json');
    }
    return Object.freeze({
      read(kind, sequence) {
        try {
          const file = name(kind, sequence);
          let marker;
          try {
            marker = physical(file + '.ready', false, pins);
          } catch (error) {
            if (error?.code === 'ENOENT') {
              verify();
              return null;
            }
            throw fail();
          }
          if (marker.size !== 0n) throw fail();
          // Bind the existing pins at the bounded reader's before/after path
          // checks, rather than traversing the same file ancestors twice more.
          const value = readBootstrap(file, 4096, pins);
          // The reader's final physical(file) already rechecks every pinned
          // ancestor. No I/O or callback occurs before this state check.
          available();
          return value;
        } catch {
          failed = true;
          throw fail();
        }
      },
      write(kind, sequence, value) {
        let fd;
        try {
          const file = name(kind, sequence);
          if (
            typeof value !== 'string' ||
            Buffer.byteLength(value) < 2 ||
            Buffer.byteLength(value) > 4096 ||
            JSON.stringify(JSON.parse(value)) !== value
          )
            throw fail();
          fd = fs.openSync(file, 'wx', 0o600);
          fs.writeFileSync(fd, value, 'utf8');
          fs.closeSync(fd);
          fd = undefined;
          physical(file, false, pins);
          available();
          fd = fs.openSync(file + '.ready', 'wx', 0o600);
          fs.closeSync(fd);
          fd = undefined;
          physical(file + '.ready', false, pins);
          available();
        } catch {
          failed = true;
          if (fd !== undefined) {
            try {
              fs.closeSync(fd);
            } catch {
              /* already rejected */
            }
          }
          throw fail();
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
const createPublicationObservationFiles = (input, create = false) =>
  createPublicationFiles(input, create, false);
const createPublicationAckFiles = (input, create = false) =>
  createPublicationFiles(input, create, true);
module.exports = { createPublicationObservationFiles, createPublicationAckFiles };
