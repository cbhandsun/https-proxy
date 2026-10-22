'use strict';

const { parseWebSearchAction } = require('./responses-web-search-history');

// Validate a completed hosted search receipt without fetching any URL, executing
// a client tool, or rewriting opaque provider result metadata.
function validateRecoveryHostedOutput(item) {
  if (
    item?.type !== 'web_search_call' ||
    typeof item.id !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(item.id) ||
    !['completed', 'failed', 'incomplete'].includes(item.status)
  )
    throw new TypeError('Invalid recovery hosted output');
  parseWebSearchAction(item.action);
}

module.exports = { validateRecoveryHostedOutput };
