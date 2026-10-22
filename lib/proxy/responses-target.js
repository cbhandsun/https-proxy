'use strict';

// Target classification is independent of request conversion and its schemas.
function isCodexResponsesTarget(profile, target) {
  if (profile?.api === 'openai-codex-responses') return true;
  return typeof target?.path === 'string' && /^\/backend-api(?:\/|$)/.test(target.path);
}

module.exports = { isCodexResponsesTarget };
