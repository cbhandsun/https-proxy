'use strict';

const { createHash } = require('node:crypto');
const { normalizeCompactionData } = require('./context-compaction-envelope');

const MAX_MESSAGES = 16384;
const MAX_ARCHIVED_MESSAGES = 64;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
const selections = new WeakMap();
const archives = new WeakMap();
const sourceTokens = new WeakMap();
const SECTIONS = [
  'objectives',
  'requirements',
  'decisions',
  'work',
  'blockers',
  'nextSteps',
  'files',
];

function dataProperty(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  if (![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value)))
    return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function resultOnlyUser(message) {
  const content = dataProperty(message, 'content');
  const length = dataProperty(content, 'length');
  if (
    !Array.isArray(content) ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > MAX_MESSAGES
  )
    return false;
  for (let index = 0; index < length; index++) {
    const part = dataProperty(content, String(index));
    const response = dataProperty(part, 'functionResponse');
    if (
      dataProperty(part, 'type') !== 'tool_result' &&
      !(response && typeof response === 'object' && !Array.isArray(response))
    )
      return false;
  }
  return true;
}

// Responses and converted Chat messages can carry text in blocks. Accept only exact known
// text-only shapes, matching task-state source joining; never flatten media,
// annotations, provider extensions or tool results into archival authority.
function archivableText(message, format) {
  const content = message.content;
  if (typeof content === 'string') return content.trim() ? content : null;
  if (!Array.isArray(content) || !content.length || content.length > 256) return null;
  if (
    !content.every(
      (part) =>
        part &&
        typeof part === 'object' &&
        !Array.isArray(part) &&
        Object.keys(part).sort().join(',') === 'text,type' &&
        (part.type === 'text' || (format === 'responses' && part.type === 'input_text')) &&
        typeof part.text === 'string'
    )
  )
    return null;
  const text = content.map((part) => part.text).join('\n');
  return text.trim() ? text : null;
}

// Selection grants no permission to delete a message. Only a validated summary,
// recoverable original and successful outer history/evidence commit can do that.
// The first user request, recent user turns, caller pins and unsafe tool intervals
// remain exact. Unknown/provider-specific/multimodal messages are not flattened.
function selectHistoricalUserArchive(messages, options = {}) {
  const empty = Object.freeze({ indices: Object.freeze([]), messageCount: 0, sourceBytes: 0 });
  const length = dataProperty(messages, 'length');
  if (
    dataProperty(options, 'enabled') !== true ||
    !Array.isArray(messages) ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > MAX_MESSAGES
  )
    return empty;
  const requestedKeep = dataProperty(options, 'keepRecentUserTurns');
  if (requestedKeep !== undefined && (!Number.isSafeInteger(requestedKeep) || requestedKeep < 1))
    return empty;
  const format = dataProperty(options, 'inputFormat') ?? 'chat';
  if (!['chat', 'responses'].includes(format)) return empty;
  const keep =
    Number.isSafeInteger(requestedKeep) && requestedKeep > 0 ? Math.min(requestedKeep, 64) : 2;
  const pins = dataProperty(options, 'protectedMessages');
  if (pins !== undefined && !(pins instanceof Set)) return empty;
  if (pins instanceof Set) {
    try {
      Set.prototype.has.call(pins, null);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return empty;
    }
  }
  const intervals = dataProperty(options, 'protectedIntervals');
  if (!Array.isArray(intervals)) return empty;
  let safeIntervals;
  try {
    safeIntervals = normalizeCompactionData(intervals, 256 * 1024);
  } catch (error) {
    if (error?.code !== 'invalid_local_compaction') throw error;
    return empty;
  }
  if (
    safeIntervals.some(
      (part) =>
        !Number.isSafeInteger(part?.start) ||
        !Number.isSafeInteger(part?.end) ||
        part.start < 0 ||
        part.end < part.start ||
        part.end >= length
    )
  )
    return empty;
  const userIndices = [];
  for (let index = 0; index < length; index++) {
    const message = dataProperty(messages, String(index));
    const role = dataProperty(message, 'role');
    // Native non-message items do not consume human-retention slots. They can
    // never be selected; the caller separately protects unsafe tool intervals.
    if (format === 'responses' && role === undefined) continue;
    if (!['system', 'developer', 'user', 'assistant', 'tool', 'function'].includes(role))
      return empty;
    if (role === 'user' && !resultOnlyUser(message)) userIndices.push(index);
  }
  const cutoff = userIndices.at(-keep) ?? 0;
  const entries = [];
  let sourceBytes = 0;
  for (const index of userIndices) {
    const message = dataProperty(messages, String(index));
    if (
      index === userIndices[0] ||
      index >= cutoff ||
      (pins instanceof Set && Set.prototype.has.call(pins, message)) ||
      safeIntervals.some((part) => index >= part.start && index <= part.end)
    )
      continue;
    let safe;
    try {
      safe = normalizeCompactionData(message, MAX_ARCHIVE_BYTES);
    } catch (error) {
      if (error?.code !== 'invalid_local_compaction') throw error;
      continue;
    }
    if (
      !(
        Object.keys(safe).sort().join(',') === 'content,role' ||
        (format === 'responses' &&
          Object.keys(safe).sort().join(',') === 'content,role,type' &&
          safe.type === 'message')
      )
    )
      continue;
    const text = archivableText(safe, format);
    if (text === null) continue;
    const serialized = JSON.stringify(safe);
    const bytes = Buffer.byteLength(serialized);
    if (entries.length >= MAX_ARCHIVED_MESSAGES || sourceBytes + bytes > MAX_ARCHIVE_BYTES) break;
    entries.push({
      index,
      sourceIndex: index + (format === 'responses' ? 1 : 0),
      message,
      serialized,
      text,
    });
    sourceBytes += bytes;
  }
  const selection = Object.freeze({
    indices: Object.freeze(entries.map((entry) => entry.index)),
    messageCount: entries.length,
    sourceBytes,
  });
  if (!sourceTokens.has(messages)) sourceTokens.set(messages, Object.freeze({}));
  selections.set(selection, { entries, sourceToken: sourceTokens.get(messages) });
  return selection;
}

function archiveSourceCovered(entry, state) {
  return SECTIONS.some((section) =>
    state[section].some(
      (item) =>
        Array.isArray(item?.sources) &&
        [...item.sources, ...(item.revision ? [item.revision] : [])].some(
          (ref) =>
            ref &&
            typeof ref === 'object' &&
            ref.sourceRole === 'user' &&
            ref.sourceIndex === entry.sourceIndex &&
            ref.sourceId === `m_${entry.sourceIndex}` &&
            typeof ref.quote === 'string' &&
            ref.quote.trim() &&
            entry.text.includes(ref.quote)
        )
    )
  );
}

// Store the complete original message, not a quote, digest or shortened preview.
// These are reservations in the existing outer transaction, never early writes.
function stageHistoricalUserArchive(selection, state, store, owner, scope) {
  const selectedSource = selections.get(selection);
  const selected = selectedSource?.entries;
  const put = dataProperty(store, 'put');
  if (
    !selected?.length ||
    typeof put !== 'function' ||
    typeof owner !== 'string' ||
    typeof scope !== 'string' ||
    !SECTIONS.every((section) => Array.isArray(dataProperty(state, section)))
  )
    return null;
  try {
    state = normalizeCompactionData(state, 64 * 1024);
  } catch (error) {
    if (error?.code !== 'invalid_local_compaction') throw error;
    return null;
  }
  if (!selected.every((entry) => archiveSourceCovered(entry, state))) return null;
  const entries = [];
  const locators = new Set();
  for (const entry of selected) {
    let safe;
    try {
      safe = normalizeCompactionData(entry.message, MAX_ARCHIVE_BYTES);
    } catch (error) {
      if (error?.code !== 'invalid_local_compaction') throw error;
      return null;
    }
    if (JSON.stringify(safe) !== entry.serialized) return null;
    let receipt;
    try {
      receipt = normalizeCompactionData(put.call(store, owner, scope, safe), 4096);
    } catch (error) {
      if (error?.code !== 'invalid_local_compaction') throw error;
      return null;
    }
    if (
      !receipt ||
      !/^hca_[a-f0-9]{32}$/.test(receipt.locator) ||
      receipt.digest !== createHash('sha256').update(entry.serialized).digest('hex') ||
      locators.has(receipt.locator) ||
      !Number.isSafeInteger(receipt.bytes) ||
      receipt.bytes !== Buffer.byteLength(entry.serialized)
    )
      return null;
    locators.add(receipt.locator);
    entries.push(
      Object.freeze({
        sourceId: `m_${entry.sourceIndex}`,
        sourceIndex: entry.sourceIndex,
        kind: 'historical_user_context',
        locator: receipt.locator,
        scope,
        digest: receipt.digest,
        bytes: receipt.bytes,
      })
    );
  }
  const archive = Object.freeze({
    schema: 'hpm.context.user_archive',
    version: 1,
    sourceRole: 'user',
    authority: 'untrusted_background',
    recovery: 'hpm_read_context_artifact',
    unavailable: 'report_unavailable_do_not_guess_or_replay',
    replayExternalTools: false,
    entries: Object.freeze(entries),
  });
  archives.set(archive, {
    owner,
    scope,
    sourceToken: selectedSource.sourceToken,
    entries,
    originals: new Map(selected.map((entry) => [entry.index, entry.serialized])),
  });
  return archive;
}

function historicalUserArchiveReferences(archive) {
  return archives.has(archive) ? [...archives.get(archive).entries] : [];
}

function historicalUserArchiveBinding(archive) {
  const record = archives.get(archive);
  return record ? Object.freeze({ owner: record.owner, scope: record.scope }) : null;
}

function historicalUserArchiveMatches(archive, index, original, owner, scope, sourceMessages) {
  const record = archives.get(archive);
  if (!record || record.owner !== owner || record.scope !== scope) return false;
  if (sourceTokens.get(sourceMessages) !== record.sourceToken) return false;
  const expected = record.originals.get(index);
  if (typeof expected !== 'string') return false;
  try {
    return JSON.stringify(normalizeCompactionData(original, MAX_ARCHIVE_BYTES)) === expected;
  } catch (error) {
    if (error?.code !== 'invalid_local_compaction') throw error;
    return false;
  }
}

module.exports = {
  selectHistoricalUserArchive,
  stageHistoricalUserArchive,
  historicalUserArchiveReferences,
  historicalUserArchiveMatches,
  historicalUserArchiveBinding,
};
