'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { types } = require('node:util');
const fail = () => new Error('installed_fixture_cleanup_failed');
const id = (stat) => [stat.dev, stat.ino, stat.birthtimeNs].join(':');

// Call at fixture creation, then invoke only after every owned child has exited.
// A transient Windows image/AV lock can outlive spawnSync's completed child.
// Retrying deletion is bounded and never reruns a scenario or changes assertions.
function createFixtureCleanup(directory, namePattern) {
  try {
    const temp = fs.realpathSync.native(os.tmpdir());
    if (
      typeof directory !== 'string' ||
      !path.isAbsolute(directory) ||
      path.resolve(directory) !== directory ||
      path.dirname(directory) !== temp ||
      !namePattern.test(path.basename(directory))
    )
      throw fail();
    const pins = new Map();
    let current = directory;
    for (;;) {
      const stat = fs.lstatSync(current, { bigint: true });
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        path.resolve(fs.realpathSync.native(current)).toLowerCase() !== current.toLowerCase()
      )
        throw fail();
      pins.set(current, id(stat));
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    function verify() {
      let present = true;
      for (const [file, expected] of pins) {
        let stat;
        try {
          stat = fs.lstatSync(file, { bigint: true });
        } catch (error) {
          if (file === directory && safeCode(error) === 'ENOENT') {
            present = false;
            continue;
          }
          throw fail();
        }
        if (!stat.isDirectory() || stat.isSymbolicLink() || id(stat) !== expected) throw fail();
      }
      return present;
    }
    return async () => {
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          if (!verify()) return;
          try {
            fs.rmSync(directory, { recursive: true, force: true });
            if (verify()) throw fail();
            return;
          } catch (error) {
            const code = safeCode(error);
            if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code) || attempt === 3) throw fail();
          }
          await new Promise((resolve) => setTimeout(resolve, 75));
        }
        throw fail();
      } catch {
        throw fail();
      }
    };
  } catch {
    throw fail();
  }
}

function safeCode(error) {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return null;
  const slot = Object.getOwnPropertyDescriptor(error, 'code');
  return slot && Object.hasOwn(slot, 'value') && typeof slot.value === 'string' ? slot.value : null;
}

function createInstalledFixtureCleanup(directory) {
  return createFixtureCleanup(directory, /^hpm-installed-boundary-[a-zA-Z0-9]+$/);
}

function createPhysicalOwnerFixtureCleanup(directory) {
  return createFixtureCleanup(directory, /^hpm-v7-owner-[a-zA-Z0-9]+$/);
}

module.exports = { createInstalledFixtureCleanup, createPhysicalOwnerFixtureCleanup };
