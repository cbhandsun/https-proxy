'use strict';

const MAX_TURNS = 4;
const MAX_TURN_CHARS = 4096;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 256;
const MAX_NATIVE_PROMPT_CHARS = 128000;

function boundedText(value) {
  return typeof value === 'string' ? value.slice(0, MAX_TURN_CHARS) : '';
}

function createTianxiResponseHistory(options = {}) {
  const entries = new Map();
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const ttlMs =
    Number.isSafeInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const maxEntries =
    Number.isSafeInteger(options.maxEntries) && options.maxEntries > 0
      ? options.maxEntries
      : DEFAULT_MAX_ENTRIES;

  function prune() {
    const current = now();
    for (const [id, record] of entries) {
      if (current < record.createdAt || current - record.createdAt >= ttlMs) entries.delete(id);
    }
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  return {
    get(id, owner) {
      prune();
      const record = entries.get(id);
      if (!record || record.owner !== owner) return null;
      return record.turns.map((turn) => ({ ...turn }));
    },
    save(id, owner, turns) {
      if (!id || !owner || !Array.isArray(turns)) return false;
      prune();
      entries.set(id, {
        owner,
        createdAt: now(),
        turns: turns.slice(-MAX_TURNS).map((turn) => ({
          user: boundedText(turn.user),
          assistant: boundedText(turn.assistant),
        })),
      });
      prune();
      return true;
    },
  };
}

function buildTianxiContinuationInput(previousTurns, currentUserText) {
  const turns = Array.isArray(previousTurns) ? previousTurns.slice(-MAX_TURNS) : [];
  const input = JSON.stringify({
    previous_turns: turns.map((turn) => ({
      user: boundedText(turn.user),
      assistant: boundedText(turn.assistant),
    })),
    current_user_message: currentUserText,
  });
  if (input.length > MAX_NATIVE_PROMPT_CHARS) return null;
  return `Continue the conversation using the prior turns as context. Answer the current user message.\n${input}`;
}

module.exports = { buildTianxiContinuationInput, createTianxiResponseHistory };
