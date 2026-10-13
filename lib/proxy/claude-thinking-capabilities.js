'use strict';

// These model families have documented adaptive-thinking support. Do not infer
// capabilities for unknown future models from a major-version comparison.
function supportsClaudeAdaptiveThinking(model) {
  return (
    typeof model === 'string' &&
    /^claude-(?:sonnet|opus)-4-6(?:-\d{8})?$/.test(model.trim().toLowerCase())
  );
}

function claudeAdaptiveEffort(effort) {
  if (effort === 'minimal') return 'low';
  if (effort === 'xhigh') return 'max';
  return effort;
}

module.exports = { supportsClaudeAdaptiveThinking, claudeAdaptiveEffort };
