'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runNativeCapacityDay } = require('./lib/context-recovery-native-day');

async function main() {
  if (process.argv.length !== 2 || process.platform !== 'win32') throw Error();
  const parent = fs.realpathSync.native(os.tmpdir());
  const directory = path.join(fs.mkdtempSync(path.join(parent, 'hpm-native-day-')), 'context');
  await runNativeCapacityDay(directory, (event) => {
    fs.writeSync(1, JSON.stringify(event) + '\n');
  });
}

main().catch(() => {
  process.stderr.write('native_capacity_day_failed\n');
  process.exitCode = 1;
});
