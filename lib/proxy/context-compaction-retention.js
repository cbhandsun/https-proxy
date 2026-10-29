'use strict';

const { normalizeCompactionData, invalidCompaction } = require('./context-compaction-envelope');
const { parseResponsesHistory } = require('./responses-semantic-history');
const { boundCompletedToolRounds } = require('./context-completed-rounds');
const { estimateTokensForValue } = require('./inline-media');
const { selectHistoricalUserArchive } = require('./context-user-archive');

const DEFAULT_RECENT_BYTES = 16 * 1024;
const DEFAULT_RECENT_TOKENS = 4096;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

function plainAssistant(item) {
  return (
    (item.type == null || item.type === 'message') &&
    item.role === 'assistant' &&
    item.tool_calls == null &&
    item.function_call == null &&
    item.encrypted_content == null &&
    (typeof item.content === 'string' ||
      (Array.isArray(item.content) &&
        item.content.every((part) => ['text', 'input_text', 'output_text'].includes(part?.type))))
  );
}

function exchangeShape(item, index) {
  if (['system', 'developer', 'user'].includes(item.role)) return { role: item.role, content: '' };
  if (
    ![
      'function_call',
      'tool_call',
      'call',
      'custom_tool_call',
      'function_call_output',
      'custom_tool_call_output',
      'tool_result',
    ].includes(item.type)
  )
    return { role: plainAssistant(item) ? 'assistant' : 'system', content: '' };
  const semantic = parseResponsesHistory([item], { fallbackId: () => 'unbound_' + index });
  if (semantic.length !== 1) return { role: 'system', content: '' };
  const message = semantic[0];
  const calls = message.parts.filter((part) => part.kind === 'call');
  const results = message.parts.filter((part) => part.kind === 'result');
  if (calls.length)
    return { role: 'assistant', content: '', tool_calls: calls.map((call) => ({ id: call.id })) };
  if (results.length)
    return { role: 'tool', content: '', tool_result_ids: results.map((result) => result.id) };
  return { role: message.role, content: '' };
}

// The optional recent working set is bounded independently of mandatory state.
// Oversized rounds are summarized whole, never sliced into orphaned exchanges.
function selectLocalCompactionWindow(input, options = {}) {
  const data = normalizeCompactionData(input, MAX_SOURCE_BYTES);
  const settings = normalizeCompactionData(options, 4096);
  const limits = {
    keepCompletedToolRounds: [2, 64],
    keepAssistantMessages: [2, 64],
    maxRecentBytes: [DEFAULT_RECENT_BYTES, 64 * 1024],
    maxRecentTokens: [DEFAULT_RECENT_TOKENS, 16 * 1024],
  };
  if (
    !Array.isArray(data) ||
    !data.length ||
    data.length > 2048 ||
    data.some((item) => !item || typeof item !== 'object' || Array.isArray(item)) ||
    !settings ||
    typeof settings !== 'object' ||
    Array.isArray(settings) ||
    Object.keys(settings).some(
      (key) =>
        !Object.hasOwn(limits, key) &&
        !['archiveHistoricalUsers', 'protectedMessageIndices'].includes(key)
    )
  )
    throw invalidCompaction('empty_compaction_input');
  if (
    settings.archiveHistoricalUsers !== undefined &&
    typeof settings.archiveHistoricalUsers !== 'boolean'
  )
    throw invalidCompaction();
  const protectedIndices = settings.protectedMessageIndices ?? [];
  if (
    !Array.isArray(protectedIndices) ||
    protectedIndices.length > data.length ||
    protectedIndices.some(
      (index) => !Number.isSafeInteger(index) || index < 0 || index >= data.length
    )
  )
    throw invalidCompaction();
  for (const [key, [fallback, maximum]] of Object.entries(limits)) {
    if (settings[key] === undefined) settings[key] = fallback;
    if (!Number.isSafeInteger(settings[key]) || settings[key] < 0 || settings[key] > maximum)
      throw invalidCompaction();
  }
  const pseudo = data.map(exchangeShape);
  const unretained = boundCompletedToolRounds(pseudo, {
    keepCompletedToolRounds: 0,
    allowEmptyCompletedRounds: true,
  });
  const dropped = new Set(unretained.droppedMessages);
  const mandatory = new Set(protectedIndices);
  data.forEach((item, index) => {
    if (
      unretained.protectedIntervals.some((part) => index >= part.start && index <= part.end) ||
      (!dropped.has(pseudo[index]) && !plainAssistant(item))
    )
      mandatory.add(index);
  });
  const preferred = boundCompletedToolRounds(pseudo, {
    keepCompletedToolRounds: settings.keepCompletedToolRounds,
    allowEmptyCompletedRounds: true,
  });
  const grouped = new Set();
  const candidates = [];
  for (const part of preferred.protectedIntervals) {
    const indices = [];
    for (let index = part.start; index <= part.end; index++) {
      grouped.add(index);
      if (!mandatory.has(index)) indices.push(index);
    }
    if (indices.length) candidates.push(indices);
  }
  const assistants = data
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item, index }) =>
        plainAssistant(item) &&
        !mandatory.has(index) &&
        !grouped.has(index) &&
        !dropped.has(pseudo[index])
    );
  const recentAssistants =
    settings.keepAssistantMessages === 0 ? [] : assistants.slice(-settings.keepAssistantMessages);
  for (const { index } of recentAssistants) candidates.push([index]);
  candidates.sort((left, right) => right.at(-1) - left.at(-1));
  let recentBytes = 0;
  let recentTokens = 0;
  for (const indices of candidates) {
    const items = indices.map((index) => data[index]);
    const bytes = Buffer.byteLength(JSON.stringify(items));
    const tokens = estimateTokensForValue(items);
    if (
      recentBytes + bytes > settings.maxRecentBytes ||
      recentTokens + tokens > settings.maxRecentTokens
    )
      break;
    recentBytes += bytes;
    recentTokens += tokens;
    for (const index of indices) mandatory.add(index);
  }
  const retained = data.filter((_item, index) => mandatory.has(index));
  const selected = new Set(
    data.flatMap((item, index) =>
      !mandatory.has(index) || ['system', 'developer', 'user'].includes(item.role) ? [index] : []
    )
  );
  const allRounds = boundCompletedToolRounds(pseudo, { keepCompletedToolRounds: 64 });
  // Group every removed completed exchange (including parallel calls and its
  // narration). Retained recent exchanges are not sent again to the summarizer.
  const summaryGroups = [];
  for (let index = 0; index < data.length; index++) {
    const interval = allRounds.exchangeIntervals.find((part) => part.start === index);
    const end = interval?.end ?? index;
    const group = [];
    for (let cursor = index; cursor <= end; cursor++)
      if (selected.has(cursor)) group.push({ index: cursor + 1, item: data[cursor] });
    if (group.length) summaryGroups.push(group);
    index = end;
  }
  return {
    retained,
    removed: data.length - retained.length,
    recentBytes,
    recentTokens,
    summaryGroups,
    ...(settings.archiveHistoricalUsers === true
      ? {
          sourceItems: data,
          userArchiveSelection: selectHistoricalUserArchive(data, {
            enabled: true,
            inputFormat: 'responses',
            protectedIntervals: unretained.protectedIntervals,
            protectedMessages: new Set(protectedIndices.map((index) => data[index])),
          }),
        }
      : {}),
  };
}

module.exports = { selectLocalCompactionWindow, DEFAULT_RECENT_BYTES, DEFAULT_RECENT_TOKENS };
