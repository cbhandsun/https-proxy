'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
require(process.argv[2]).requireNativeDayAssignment(process.env.HPM_NATIVE_DAY_OWNED_JOB);
if (process.argv[4] === 'success') process.exit(0);
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
  windowsHide: true,
});
fs.writeFileSync(
  path.join(process.argv[3], 'owned-tree.json'),
  JSON.stringify({
    pid: process.pid,
    descendant: child.pid,
  }),
  { flag: 'wx' }
);
setInterval(() => {}, 1000);
