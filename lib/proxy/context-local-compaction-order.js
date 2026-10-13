'use strict';

const { normalizeCompactionData, invalidCompaction } = require('./context-compaction-envelope');

// Positions come only from successful, authenticated envelope replay. A marker
// in caller text is not a capability. Reposition generated background, never
// hoist policy/user messages or change their relative order, role or contents.
function orderAuthenticatedCompactionReplay(input, authenticatedSummaryIndices) {
  const items = normalizeCompactionData(input, 2 * 1024 * 1024);
  const positions = normalizeCompactionData(authenticatedSummaryIndices, 32 * 1024);
  if (
    !Array.isArray(items) ||
    items.length > 2048 ||
    !Array.isArray(positions) ||
    positions.length > items.length ||
    items.some((item) => !item || typeof item !== 'object' || Array.isArray(item)) ||
    positions.some(
      (index, cursor) =>
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= items.length ||
        (cursor > 0 && index <= positions[cursor - 1]) ||
        items[index].role !== 'assistant' ||
        typeof items[index].content !== 'string'
    )
  )
    throw invalidCompaction();
  if (!positions.length) return items;
  // WorkBuddy treats a subsequent policy message as a new policy prefix and
  // may discard earlier assistant context. Put authenticated background after
  // the last original policy. With no policy, keep the initial user as anchor.
  let anchor = items.findLastIndex((item) => ['system', 'developer'].includes(item.role));
  if (anchor < 0) anchor = items.findIndex((item) => item.role === 'user');
  if (anchor < 0) return items;
  const moving = positions.filter((index) => index < anchor);
  if (!moving.length) return items;
  const selected = new Set(moving);
  const summaries = moving.map((index) => items[index]);
  const originals = items.filter((_item, index) => !selected.has(index));
  const insertion = originals.indexOf(items[anchor]) + 1;
  return [...originals.slice(0, insertion), ...summaries, ...originals.slice(insertion)];
}

module.exports = { orderAuthenticatedCompactionReplay };
