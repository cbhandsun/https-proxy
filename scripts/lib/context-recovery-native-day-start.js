'use strict';
const fs = require('node:fs');

// Optional for direct CLI use; required by the Windows owned-Job controller.
// No product imports, storage opens or descendants may precede assignment.
function requireNativeDayAssignment(value) {
  if (value === undefined) return;
  if (value !== '1') throw new Error('native_day_assignment_failed');
  const input = Buffer.alloc(2);
  const count = fs.readSync(0, input, 0, 2, null);
  if (count !== 1 || input[0] !== 49 || fs.readSync(0, input, 0, 1, null) !== 0)
    throw new Error('native_day_assignment_failed');
}
module.exports = { requireNativeDayAssignment };
