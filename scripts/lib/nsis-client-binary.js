'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { safePath } = require('./nsis-encrypted-contract');
const fail = () => new Error('installed_client_binary_rejected');
// Exact upper bounds from the SRI-verified tools/nsis-clients lock archives:
// @openai/codex 0.160.1-win32-x64 and Claude 2.1.292. The generic 256 MiB
// digest guard remains unchanged; these native clients use bounded streaming.
const LIMITS = Object.freeze({ codex: 326875440, claude: 254858400 });
function digestInstalledClient(file, client) {
  let descriptor;
  try {
    if (
      typeof client !== 'string' ||
      !Object.hasOwn(LIMITS, client) ||
      path.basename(file) !== client + '.exe'
    )
      throw fail();
    file = safePath(file);
    const before = fs.lstatSync(file);
    if (before.size < 1 || before.size > LIMITS[client]) throw fail();
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const same = (stat) =>
      ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].every(
        (key) => stat[key] === before[key]
      );
    if (!same(fs.fstatSync(descriptor))) throw fail();
    const hash = createHash('sha256');
    const bytes = Buffer.alloc(Math.min(before.size, 1024 * 1024));
    let offset = 0;
    while (offset < before.size) {
      const count = fs.readSync(
        descriptor,
        bytes,
        0,
        Math.min(bytes.length, before.size - offset),
        offset
      );
      if (!count) throw fail();
      hash.update(bytes.subarray(0, count));
      offset += count;
    }
    if (!same(fs.fstatSync(descriptor))) throw fail();
    safePath(file);
    if (!same(fs.lstatSync(file))) throw fail();
    return hash.digest('hex');
  } catch {
    throw fail();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
module.exports = { digestInstalledClient };
