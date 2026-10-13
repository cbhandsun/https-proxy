'use strict';

function invalidFilteredToolInput() {
  const error = new TypeError('Invalid or incomplete upstream Claude tool arguments');
  error.code = 'upstream_stream_invalid_tool_arguments';
  throw error;
}

function parseFilteredToolInput(pending, budget) {
  if (
    typeof pending.id !== 'string' ||
    !pending.id.trim() ||
    typeof pending.name !== 'string' ||
    !pending.name.trim() ||
    !Number.isSafeInteger(pending.index) ||
    pending.index < 0
  )
    invalidFilteredToolInput();
  const input = pending.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalidFilteredToolInput();
  if (!pending.partialJson.trim()) {
    budget.appendArguments({}, JSON.stringify(input));
    return input;
  }
  let parsed;
  try {
    parsed = JSON.parse(pending.partialJson);
  } catch {
    invalidFilteredToolInput();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalidFilteredToolInput();
  const merged = { ...input, ...parsed };
  budget.appendArguments({}, JSON.stringify(merged));
  return merged;
}

module.exports = { parseFilteredToolInput, invalidFilteredToolInput };
