'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { requireNativeDayAssignment } = require('./lib/context-recovery-native-day-start');

async function main() {
  if (process.argv.length !== 2 || process.platform !== 'win32') throw Error();
  requireNativeDayAssignment(process.env?.HPM_NATIVE_DAY_OWNED_JOB);
  const { runNativeCapacityDay } = require('./lib/context-recovery-native-day');
  const { createNativeDayReceipts } = require('./lib/context-recovery-native-day-receipts');
  const receipts = createNativeDayReceipts(fs.realpathSync.native(os.tmpdir()));
  let exitCode = 1;
  try {
    const directory = path.join(receipts.directory, 'context');
    await runNativeCapacityDay(directory, (event) => {
      receipts.emit(event, (line) => fs.writeSync(1, line));
    });
    exitCode = 0;
  } finally {
    // This is the main operation's result, never proof of actual process exit
    // or a replacement for the original supervisor/task success requirement.
    try {
      receipts.finish(exitCode);
    } finally {
      receipts.close();
    }
  }
}

main().catch(() => {
  process.exitCode = 1;
  try {
    fs.writeSync(2, 'native_capacity_day_failed\n');
  } catch {
    // Failure was already selected; an unavailable diagnostic pipe cannot
    // prevent termination or turn it into success.
  }
});
