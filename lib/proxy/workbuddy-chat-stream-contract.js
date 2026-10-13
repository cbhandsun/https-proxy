'use strict';

// WorkBuddy's host uses an empty finish_reason for nonterminal Chat deltas.
// It also emits an empty legacy function_call placeholder. Normalize these
// transport-specific spellings without relaxing shared parsers or real tools.
function normalizeWorkBuddyChatSse(body) {
  return body
    .split(/\r?\n\r?\n/)
    .map((frame) => {
      const lines = frame.split(/\r?\n/);
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data.trim() || data.trim() === '[DONE]') return frame;
      let value;
      try {
        value = JSON.parse(data);
      } catch (error) {
        throw new TypeError('Invalid WorkBuddy Chat stream frame', { cause: error });
      }
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new TypeError('Invalid WorkBuddy Chat stream frame');
      if (!Array.isArray(value.choices)) return frame;
      let changed = false;
      for (const choice of value.choices) {
        if (
          choice &&
          typeof choice === 'object' &&
          !Array.isArray(choice) &&
          choice.finish_reason === ''
        ) {
          choice.finish_reason = null;
          changed = true;
        }
        const legacy = choice?.delta?.function_call;
        if (
          legacy &&
          typeof legacy === 'object' &&
          !Array.isArray(legacy) &&
          Object.keys(legacy).every(
            (key) => ['name', 'arguments'].includes(key) && legacy[key] === ''
          )
        ) {
          delete choice.delta.function_call;
          changed = true;
        }
      }
      if (!changed) return frame;
      let written = false;
      return lines
        .flatMap((line) => {
          if (!line.startsWith('data:')) return [line];
          if (written) return [];
          written = true;
          return ['data: ' + JSON.stringify(value)];
        })
        .join('\n');
    })
    .join('\n\n');
}
module.exports = { normalizeWorkBuddyChatSse };
