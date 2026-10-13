'use strict';

const { isTianxiClientProcessText } = require('./tianxi-responses');

function clientFinalFrames(frames, returnedActions) {
  if (!Array.isArray(frames)) return [];
  const completed = returnedActions instanceof Set ? returnedActions : new Set();
  const result = [];
  let hasLaterClientStart = false;
  for (let index = frames.length - 1; index >= 0; index--) {
    const frame = frames[index];
    const actions = frame?.data?.actions;
    const returned =
      ['act_exec', 'act_resp'].includes(frame?.type) &&
      Array.isArray(actions) &&
      actions.length > 0 &&
      actions.every(
        (action) => action?.mcpServerName === 'codex_readonly' && completed.has(action.id)
      );
    if (returned) {
      if (frame.type === 'act_exec') hasLaterClientStart = true;
      continue;
    }
    // Text before a later returned tool start belongs to that operation's
    // process, including mixed text/message/output markers used by native
    // frames. Explicit answer/final/result markers remain authoritative.
    if (hasLaterClientStart && frame?.type === 'task_output' && isTianxiClientProcessText(frame))
      result.push({ ...frame, data: { ...frame.data, content_type: 'summary' } });
    else result.push(frame);
  }
  return result.reverse();
}

module.exports = { clientFinalFrames };
