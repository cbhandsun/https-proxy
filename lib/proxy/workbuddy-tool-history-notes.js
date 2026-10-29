'use strict';

// Non-wire, request-local provenance. Client text/markers cannot acquire this
// capability; only locally generated notes and exact checked clones retain it.
const notes = new WeakMap();
function data(value, key) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}
function createToolHistoryNote(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 1024)
    throw new TypeError('Invalid tool-history note');
  const note = { type: 'text', text };
  notes.set(note, text);
  return note;
}
function isToolHistoryNote(value) {
  return (
    notes.has(value) && data(value, 'type') === 'text' && data(value, 'text') === notes.get(value)
  );
}
function carryToolHistoryNotes(target, source) {
  const original = data(source, 'content');
  const cloned = data(target, 'content');
  if (
    !Array.isArray(original) ||
    !Array.isArray(cloned) ||
    original.length !== cloned.length ||
    original.length > 262144
  )
    return target;
  for (let index = 0; index < original.length; index += 1) {
    const before = Object.getOwnPropertyDescriptor(original, String(index))?.value;
    const after = Object.getOwnPropertyDescriptor(cloned, String(index))?.value;
    if (
      isToolHistoryNote(before) &&
      data(after, 'type') === 'text' &&
      data(after, 'text') === notes.get(before)
    )
      notes.set(after, notes.get(before));
  }
  return target;
}
module.exports = { createToolHistoryNote, isToolHistoryNote, carryToolHistoryNotes };
