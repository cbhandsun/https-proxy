'use strict';
const fs = require('node:fs');
const { types } = require('node:util');

// Missing first append is pending. All other filesystem failures and malformed
// contents remain errors in the caller's original bounded wait/assertions.
function readPendingLogText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      !types.isProxy(error) &&
      Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ENOENT'
    )
      return '';
    throw error;
  }
}
module.exports = { readPendingLogText };
